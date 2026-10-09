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
    const grossCents = Math.round(Number(order.payAmount || 0) * 100)
    const grossAmount = grossCents / 100
    const earningAmount = Math.round(grossCents * rate) / 100
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
    const grossCents = Math.round(Number(order.payAmount || 0) * 100)
    const grossAmount = grossCents / 100
    let baseCents = Math.round(grossCents * rate)
    if (order.isUrgent && Number(order.urgentStaffReward) > 0) {
      baseCents = Math.round(Number(order.urgentStaffReward) * 100)
    }

    const baseAmount = baseCents / 100
    const originalAmount = baseAmount
    let deductCents = 0
    let deductReason = ''
    if (Number(options.deductAmount) > 0) {
      deductCents = Math.min(baseCents, Math.round(Number(options.deductAmount) * 100))
      deductReason = String(options.deductReason || options.reason || '').trim()
    } else if (Number(order.adminManualDeductEarning) > 0) {
      deductCents = Math.min(baseCents, Math.round(Number(order.adminManualDeductEarning) * 100))
      deductReason = String(order.adminManualDeductReason || '').trim()
    }
    const deductAmount = deductCents / 100

    const finalCents = Math.max(0, baseCents - deductCents)
    let earningAmount = options.overrideAmount !== undefined && Number(options.overrideAmount) >= 0
      ? Math.round(Number(options.overrideAmount) * 100) / 100
      : finalCents / 100

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
    const execute = async transaction => {
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
    }
    return options.transaction ? execute(options.transaction) : db.runTransaction(execute)
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

  async function adjustStaffEarningsForRefund(orderId, refundAmount, totalPayAmount, reason = '', transaction = null) {
    if (!orderId) return null
    const client = transaction || db
    let earnings = []
    try {
      const res = await db.collection('staff_earnings').where({ orderId }).get()
      earnings = res.data || []
    } catch (e) {
      earnings = []
    }
    if (!earnings.length) return null

    const time = now()
    const refundCents = Math.round(Number(refundAmount || 0) * 100)
    const payCents = Math.max(Math.round(Number(totalPayAmount || 0) * 100), refundCents)
    const isFullRefund = refundCents >= payCents

    const results = []
    for (const earning of earnings) {
      if (['refunded_void'].includes(earning.status) && Number(earning.amount) === 0) {
        continue
      }
      const earningAmountCents = Math.round(Number(earning.amount || 0) * 100)
      const originalAmountCents = Math.round(Number(earning.originalAmount || earning.amount || 0) * 100)
      const accumulatedDeductCents = Math.round(Number(earning.deductedAmount || 0) * 100)

      if (earning.status === 'withdrawn') {
        const debtDeltaCents = isFullRefund ? earningAmountCents : Math.min(earningAmountCents, Math.round(originalAmountCents * (refundCents / payCents)))
        const debtDelta = debtDeltaCents / 100
        const updateData = {
          hasOverpaidDebt: true,
          overpaidDebtAmount: (Math.round(Number(earning.overpaidDebtAmount || 0) * 100) + debtDeltaCents) / 100,
          refundVoidReason: reason || '订单退款，收益已提现转入待追缴',
          updatedAt: time
        }
        await client.collection('staff_earnings').doc(earning._id).update({ data: updateData })
        await client.collection('finance_logs').doc(`refund_debt_${earning._id}_${Date.now()}`).set({
          data: {
            action: 'staff_earning_withdrawn_debt',
            targetType: 'staff_earning',
            targetId: earning._id,
            orderId,
            staffOpenid: earning.staffOpenid,
            amountDelta: -debtDelta,
            detail: { isFullRefund, refundAmount, totalPayAmount, reason },
            createdAt: time
          }
        }).catch(() => {})
        results.push({ _id: earning._id, action: 'debt', delta: debtDelta })
        continue
      }

      if (earning.status === 'withdrawing') {
        const updateData = {
          status: 'refunded_void',
          amount: 0,
          deductedAmount: originalAmountCents / 100,
          refundVoidAt: time,
          refundVoidReason: reason || '订单退款，提现中的收益已作废',
          updatedAt: time
        }
        await client.collection('staff_earnings').doc(earning._id).update({ data: updateData })
        if (earning.withdrawRequestId) {
          await client.collection('withdraw_requests').doc(earning.withdrawRequestId).update({
            data: {
              hasVoidedEarnings: true,
              auditRemark: `关联订单 ${orderId} 发生退款，收益已作废`,
              updatedAt: time
            }
          }).catch(() => {})
        }
        await client.collection('finance_logs').doc(`refund_void_${earning._id}_${Date.now()}`).set({
          data: {
            action: 'staff_earning_voided',
            targetType: 'staff_earning',
            targetId: earning._id,
            orderId,
            staffOpenid: earning.staffOpenid,
            amountDelta: -earning.amount,
            detail: { isFullRefund: true, refundAmount, totalPayAmount, reason, fromStatus: 'withdrawing' },
            createdAt: time
          }
        }).catch(() => {})
        results.push({ _id: earning._id, action: 'voided', delta: earning.amount })
        continue
      }

      if (isFullRefund) {
        const updateData = {
          status: 'refunded_void',
          amount: 0,
          deductedAmount: originalAmountCents / 100,
          refundVoidAt: time,
          refundVoidReason: reason || '订单全额退款，收益作废',
          updatedAt: time
        }
        await client.collection('staff_earnings').doc(earning._id).update({ data: updateData })
        await client.collection('finance_logs').doc(`refund_void_${earning._id}_${Date.now()}`).set({
          data: {
            action: 'staff_earning_voided',
            targetType: 'staff_earning',
            targetId: earning._id,
            orderId,
            staffOpenid: earning.staffOpenid,
            amountDelta: -earning.amount,
            detail: { isFullRefund: true, refundAmount, totalPayAmount, reason },
            createdAt: time
          }
        }).catch(() => {})
        results.push({ _id: earning._id, action: 'voided', delta: earning.amount })
      } else {
        const deductRatio = Math.min(refundCents / payCents, 1)
        const deductCents = Math.min(earningAmountCents, Math.round(originalAmountCents * deductRatio))
        const newAmountCents = Math.max(0, earningAmountCents - deductCents)
        const newDeductedCents = accumulatedDeductCents + deductCents
        const updateData = {
          amount: newAmountCents / 100,
          deductedAmount: newDeductedCents / 100,
          deductReason: reason ? `退款冲减：${reason}` : '订单部分退款冲减收益',
          status: newAmountCents === 0 ? 'refunded_void' : earning.status,
          updatedAt: time
        }
        await client.collection('staff_earnings').doc(earning._id).update({ data: updateData })
        await client.collection('finance_logs').doc(`refund_part_${earning._id}_${Date.now()}`).set({
          data: {
            action: 'staff_earning_partially_refunded',
            targetType: 'staff_earning',
            targetId: earning._id,
            orderId,
            staffOpenid: earning.staffOpenid,
            amountDelta: -deductCents / 100,
            detail: { refundAmount, totalPayAmount, deductCents, newAmount: newAmountCents / 100, reason },
            createdAt: time
          }
        }).catch(() => {})
        results.push({ _id: earning._id, action: 'partial_deduct', delta: deductCents / 100 })
      }
    }
    return results
  }

  return {
    calculateStaffEarningForOrder,
    calculateAvailableAt,
    ensureStaffEarning,
    refreshStaffEarnings,
    summarizeStaffEarnings,
    adjustStaffEarningsForRefund
  }
}
