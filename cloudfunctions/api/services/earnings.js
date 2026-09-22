module.exports = function createService({
  db,
  getSystemSettings,
  now,
  parseDateValue
}) {
  async function calculateStaffEarningForOrder(order) {
    if (!order) return { earningAmount: 0, commissionRate: 0.7 }
    if (order.isUrgent && Number(order.urgentStaffReward) > 0) {
      const urgentReward = Number(order.urgentStaffReward)
      return {
        earningAmount: urgentReward,
        commissionRate: 1,
        isUrgent: true,
        urgentBonus: Number(order.urgentBonus || 0)
      }
    }
    if (!order.payAmount) return { earningAmount: 0, commissionRate: 0.7 }
    const settings = await getSystemSettings()
    const rate = Number(settings.settlement.staffCommissionRate ?? 0.7)
    const grossAmount = Number(order.payAmount || 0)
    const earningAmount = Math.round(grossAmount * rate * 100) / 100
    return { earningAmount, commissionRate: rate }
  }

  function calculateAvailableAt(completedAt, delayDays) {
    const base = parseDateValue(completedAt) || now()
    return new Date(base.getTime() + Math.max(Number(delayDays || 0), 0) * 86400000)
  }

  async function ensureStaffEarning(order, completedAt = now(), options = {}) {
    if (!order || !order._id || !order.staffOpenid) return null
    const settings = await getSystemSettings()
    const rate = Number(settings.settlement.staffCommissionRate ?? 0.7)
    const grossAmount = Number(order.payAmount || 0)
    let baseAmount = Math.round(grossAmount * rate * 100) / 100
    if (order.isUrgent && Number(order.urgentStaffReward) > 0) {
      baseAmount = Number(order.urgentStaffReward)
    }

    const originalAmount = baseAmount
    let deductAmount = 0
    let deductReason = ''
    if (Number(options.deductAmount) > 0) {
      deductAmount = Math.min(baseAmount, Math.round(Number(options.deductAmount) * 100) / 100)
      deductReason = String(options.deductReason || options.reason || '').trim()
    } else if (Number(order.adminManualDeductEarning) > 0) {
      deductAmount = Math.min(baseAmount, Math.round(Number(order.adminManualDeductEarning) * 100) / 100)
      deductReason = String(order.adminManualDeductReason || '').trim()
    }

    let earningAmount = Math.max(0, Math.round((baseAmount - deductAmount) * 100) / 100)
    if (options.overrideAmount !== undefined && Number(options.overrideAmount) >= 0) {
      earningAmount = Math.round(Number(options.overrideAmount) * 100) / 100
    }

    const time = now()
    if (![grossAmount, baseAmount, earningAmount].every(value => Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.round(value * 100))) ||
        !Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error('收益金额或分成比例异常，请核对')
    const earning = {
      orderId: order._id,
      orderNo: order.orderNo || '',
      staffOpenid: order.staffOpenid || '',
      staffUserId: order.staffUserId || '',
      staffProfileId: order.staffProfileId || '',
      clientOpenid: order.clientOpenid || '',
      grossAmount,
      commissionRate: rate,
      amount: earningAmount,
      originalAmount,
      deductAmount,
      deductReason,
      isDeducted: deductAmount > 0,
      completionType: order.completionType || options.completionType || 'normal',
      status: settings.settlement.settlementDelayDays > 0 ? 'pending' : 'available',
      availableAt: calculateAvailableAt(completedAt, settings.settlement.settlementDelayDays),
      withdrawRequestId: '',
      frozenReason: '',
      createdAt: time,
      updatedAt: time
    }
    // 固定订单级 ID + 事务，避免重复点击完单、定时任务和人工完单并发时重复入账。
    // 历史随机 ID 由普通查询发现，再进行事务点读；事务写入统一使用文档操作。
    const earningId = `earning_order_${order._id}`
    return db.runTransaction(async transaction => {
      async function readEarning(id) {
        try {
          return (await transaction.collection('staff_earnings').doc(id).get()).data || null
        } catch (error) {
          if (String(error.message || error.errMsg || error).includes(`document with _id ${id} does not exist`)) return null
          throw error
        }
      }
      const fixed = await readEarning(earningId)
      if (fixed) return fixed
      const candidate = (await db.collection('staff_earnings').where({ orderId: order._id }).limit(1).get()).data[0]
      if (candidate) {
        const legacy = await readEarning(candidate._id)
        if (legacy && legacy.orderId === order._id) return legacy
      }
      let currentOrder = null
      try { currentOrder = (await transaction.collection('orders').doc(order._id).get()).data } catch (error) {
        if (!String(error.message || error.errMsg).includes(`document with _id ${order._id} does not exist`)) throw error
      }
      const value = { ...earning }
      if (currentOrder?.frozenEarningIncidentId) {
        const incidentId = currentOrder.frozenEarningIncidentId
        const incident = (await transaction.collection('order_incidents').doc(incidentId).get()).data
        if (!incident || incident.orderId !== order._id || incident.staffOpenid !== order.staffOpenid) throw new Error('预冻结纠纷归属异常')
        Object.assign(value, { status: 'frozen', frozenIncidentId: incidentId, frozenFromStatus: earning.status })
        await transaction.collection('order_incidents').doc(incidentId).update({ data: {
          frozenEarningIds: [...new Set([...(incident.frozenEarningIds || []), earningId])], updatedAt: time
        } })
      }
      if (currentOrder) await transaction.collection('orders').doc(order._id).update({ data: { earningRevision: Number(currentOrder.earningRevision || 0) + 1 } })
      await transaction.collection('staff_earnings').doc(earningId).set({ data: value })
      await transaction.collection('finance_logs').doc(earningId).set({ data: {
        action: 'staff_earning_created',
        targetType: 'staff_earning',
        targetId: earningId,
        orderId: order._id,
        staffOpenid: order.staffOpenid,
        amountDelta: earningAmount,
        detail: {
          commissionRate: rate,
          originalAmount,
          deductAmount,
          deductReason,
          isDeducted: deductAmount > 0
        },
        createdAt: time
      } })
      return { _id: earningId, ...value }
    })
  }

  async function refreshStaffEarnings(openid = '') {
    const query = openid ? { staffOpenid: openid, status: 'pending' } : { status: 'pending' }
    const time = now()
    let cursor = ''
    while (true) {
      const where = { ...query }
      if (cursor) where._id = db.command.gt(cursor)
      const res = await db.collection('staff_earnings').where(where).orderBy('_id', 'asc').limit(100).get()
      const rows = res.data || []
      for (const earning of rows) {
        const availableAt = parseDateValue(earning.availableAt)
        if (availableAt && availableAt.getTime() <= time.getTime()) {
          await db.collection('staff_earnings').where({ _id: earning._id, status: 'pending' }).update({ data: { status: 'available', updatedAt: time } })
        }
      }
      if (rows.length < 100) break
      cursor = rows[rows.length - 1]._id
    }
  }

  function summarizeStaffEarnings(earnings = []) {
    return earnings.reduce((summary, earning) => {
      const amount = Number(earning.amount || 0)
      summary.total += amount
      if (earning.status === 'pending') summary.pending += amount
      if (earning.status === 'available') summary.available += amount
      if (earning.status === 'withdrawing') summary.withdrawing += amount
      if (earning.status === 'withdrawn') summary.withdrawn += amount
      if (earning.status === 'frozen') summary.frozen += amount
      return summary
    }, { total: 0, pending: 0, available: 0, withdrawing: 0, withdrawn: 0, frozen: 0 })
  }

  return {
    calculateStaffEarningForOrder,
    calculateAvailableAt,
    ensureStaffEarning,
    refreshStaffEarnings,
    summarizeStaffEarnings
  }
}
