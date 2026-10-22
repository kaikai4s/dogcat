module.exports = function createService({
  db,
  getSystemSettings,
  now,
  parseDateValue,
  releaseWechatTransferQuota
}) {
  function splitOrderCents(grossCents, rate) {
    const platformCents = Math.round(grossCents * (1 - rate))
    return { platformCents, staffCents: grossCents - platformCents }
  }

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
    const { staffCents } = splitOrderCents(grossCents, rate)
    const earningAmount = staffCents / 100
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
    let baseCents = splitOrderCents(grossCents, rate).staffCents
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
      const channelCandidate = order.paymentChannel || currentOrder?.paymentChannel || ''
      let isMock = order.isMockPayment === true || currentOrder?.isMockPayment === true || channelCandidate === 'mock'
      if (!isMock && !channelCandidate) {
        try {
          const paymentsRes = await transaction.collection('payments').where({ orderId: order._id }).limit(2).get()
          const paymentList = paymentsRes.data || []
          const succPayment = paymentList.find(p => p.status === 'success' || p.status === 'paid')
          if (succPayment && succPayment.channel === 'mock') {
            isMock = true
          }
        } catch (_) {}
      }
      const paymentChannel = isMock ? 'mock' : (channelCandidate || 'wechat')
      const value = {
        ...earning,
        paymentChannel,
        isMock,
        isWithdrawable: !isMock,
        mockReason: isMock ? '模拟支付测试订单，不计入真实可提现资金池' : '',
        status: isMock ? 'mock_settled' : earning.status
      }
      value.pendingRefundIds = currentOrder?.pendingEarningRefundIds || []
      // A completion racing a refund may create this ledger after the refund
      // was finalized. Explicit retained-amount overrides already include it.
      if (options.overrideAmount === undefined && Number(currentOrder?.refundedAmount) > 0 && grossCents > 0) {
        const refundedCents = Math.round(Number(currentOrder.refundedAmount) * 100)
        if (!Number.isSafeInteger(refundedCents) || refundedCents > grossCents) throw new Error('订单已退款金额异常，请核对收益')
        const deduction = Math.min(Math.round(value.amount * 100), Math.round(baseCents * refundedCents / grossCents))
        value.amount = (Math.round(value.amount * 100) - deduction) / 100
        value.deductedAmount = deduction / 100
        if (value.amount === 0) value.status = 'refunded_void'
      }
      if (currentOrder?.frozenEarningIncidentId) {
        const incidentId = currentOrder.frozenEarningIncidentId
        const incident = (await transaction.collection('order_incidents').doc(incidentId).get()).data
        if (!incident || incident.orderId !== order._id || incident.staffOpenid !== order.staffOpenid) throw new Error('预冻结纠纷归属异常')
        Object.assign(value, { status: 'frozen', frozenIncidentId: incidentId, frozenFromStatus: value.status })
        await transaction.collection('order_incidents').doc(incidentId).update({ data: {
          frozenEarningIds: [...new Set([...(incident.frozenEarningIds || []), earningId])], updatedAt: time
        } })
      }
      if (currentOrder) await transaction.collection('orders').doc(order._id).update({ data: { earningRevision: Number(currentOrder.earningRevision || 0) + 1 } })
      await transaction.collection('staff_earnings').doc(earningId).set({ data: value })
      await transaction.collection('finance_logs').doc(earningId).set({ data: {
        action: isMock ? 'staff_earning_mock_created' : 'staff_earning_created',
        targetType: 'staff_earning',
        targetId: earningId,
        orderId: order._id,
        staffOpenid: order.staffOpenid,
        amountDelta: isMock ? 0 : earningAmount,
        detail: {
          commissionRate: rate,
          originalAmount,
          deductAmount,
          deductReason,
          isDeducted: deductAmount > 0,
          paymentChannel,
          isMock,
          isWithdrawable: !isMock
        },
        createdAt: time
      } })
      return { _id: earningId, ...value }
    }
    return options.transaction ? execute(options.transaction) : db.runTransaction(execute)
  }

  async function refreshStaffEarnings(openid = '') {
    const time = now()

    // 1. 回溯清洗存量被误标或历史遗留的模拟收益（状态为 available，但实为 mock 支付）
    try {
      const availQuery = openid ? { staffOpenid: openid, status: 'available' } : { status: 'available' }
      const availableRows = (await db.collection('staff_earnings').where(availQuery).limit(100).get()).data || []
      for (const earning of availableRows) {
        let isMockEarning = earning.isMock === true || earning.paymentChannel === 'mock'
        if (!isMockEarning && earning.isMock === undefined && earning.orderId) {
          try {
            const payments = (await db.collection('payments').where({ orderId: earning.orderId }).limit(2).get()).data || []
            const succPayment = payments.find(p => p.status === 'success' || p.status === 'paid')
            if (succPayment && succPayment.channel === 'mock') {
              isMockEarning = true
            } else {
              const orderRes = await db.collection('orders').doc(earning.orderId).get().catch(() => ({ data: null }))
              const orderData = orderRes && orderRes.data
              if (orderData && (orderData.paymentChannel === 'mock' || orderData.isMockPayment === true)) {
                isMockEarning = true
              }
            }
          } catch (_) {}
        }

        if (isMockEarning) {
          await db.collection('staff_earnings').doc(earning._id).update({
            data: {
              status: 'mock_settled',
              isMock: true,
              paymentChannel: 'mock',
              isWithdrawable: false,
              mockReason: '历史模拟测试订单自动订正隔离',
              updatedAt: time
            }
          }).catch(() => {})
        }
      }
    } catch (_) {}

    // 2. 正常处理 pending 收益的延期到期转 available 及 pending mock 清洗
    const query = openid ? { staffOpenid: openid, status: 'pending' } : { status: 'pending' }
    let cursor = ''
    while (true) {
      const where = { ...query }
      if (cursor) where._id = db.command.gt(cursor)
      const res = await db.collection('staff_earnings').where(where).orderBy('_id', 'asc').limit(100).get()
      const rows = res.data || []
      for (const earning of rows) {
        let isMockEarning = earning.isMock === true || earning.paymentChannel === 'mock'
        if (!isMockEarning && earning.isMock === undefined && earning.orderId) {
          try {
            const payments = (await db.collection('payments').where({ orderId: earning.orderId }).limit(2).get()).data || []
            const succPayment = payments.find(p => p.status === 'success' || p.status === 'paid')
            if (succPayment && succPayment.channel === 'mock') {
              isMockEarning = true
            } else {
              const orderRes = await db.collection('orders').doc(earning.orderId).get().catch(() => ({ data: null }))
              const orderData = orderRes && orderRes.data
              if (orderData && (orderData.paymentChannel === 'mock' || orderData.isMockPayment === true)) {
                isMockEarning = true
              }
            }
          } catch (_) {}
        }

        if (isMockEarning) {
          await db.collection('staff_earnings').where({ _id: earning._id, status: 'pending' }).update({
            data: {
              status: 'mock_settled',
              isMock: true,
              paymentChannel: 'mock',
              isWithdrawable: false,
              mockReason: '历史模拟测试订单自动订正隔离',
              updatedAt: time
            }
          })
          continue
        }
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
      const isMock = earning.isMock === true || earning.paymentChannel === 'mock' || earning.status === 'mock_settled'
      if (isMock) {
        summary.mockTotal = Math.round((summary.mockTotal + amount) * 100) / 100
        return summary
      }
      summary.total = Math.round((summary.total + amount) * 100) / 100
      if (earning.status === 'pending') summary.pending = Math.round((summary.pending + amount) * 100) / 100
      if (earning.status === 'available') summary.available = Math.round((summary.available + amount) * 100) / 100
      if (earning.status === 'withdrawing') summary.withdrawing = Math.round((summary.withdrawing + amount) * 100) / 100
      if (earning.status === 'withdrawn') summary.withdrawn = Math.round((summary.withdrawn + amount) * 100) / 100
      if (earning.status === 'frozen') summary.frozen = Math.round((summary.frozen + amount) * 100) / 100
      return summary
    }, { total: 0, pending: 0, available: 0, withdrawing: 0, withdrawn: 0, frozen: 0, mockTotal: 0 })
  }

  const { adjustStaffEarningsForRefund } = require('./refundEarnings')({ db, now, parseDateValue, releaseWechatTransferQuota })

  function buildOrderProfitSummary(order, actualEarning = null, commissionRate = 0.7) {
    if (!order) {
      return {
        hasPayment: false,
        payAmount: 0,
        refundAmount: 0,
        netPayAmount: 0,
        staffReward: 0,
        platformProfit: 0,
        commissionRate: 0.7,
        commissionRateText: '70%',
        platformProfitRateText: '30%',
        isUrgent: false,
        isSubsidy: false,
        subsidyAmount: 0,
        deductAmount: 0,
        settlementStatus: 'unpaid',
        settlementStatusText: '未付款'
      }
    }

    const payAmount = Number(order.payAmount || 0)
    const refundAmount = Number(order.refundAmount || 0)
    const netPayAmount = Math.max(0, Math.round((payAmount - refundAmount) * 100) / 100)
    const rate = Number(commissionRate ?? 0.7)
    const ratePercentText = `${Math.round(rate * 100)}%`
    const platformRatePercentText = `${Math.max(0, 100 - Math.round(rate * 100))}%`

    const isPaid = Boolean(order.paidAt) || order.paymentStatus === 'paid' ||
      ['paid', 'assigned', 'on_the_way', 'in_service', 'day_completed', 'pending_confirm', 'completed'].includes(order.status) ||
      (order.status === 'cancelled' && payAmount > 0)

    if (!isPaid || payAmount <= 0) {
      return {
        hasPayment: false,
        payAmount,
        refundAmount,
        netPayAmount: 0,
        staffReward: 0,
        platformProfit: 0,
        commissionRate: rate,
        commissionRateText: ratePercentText,
        platformProfitRateText: platformRatePercentText,
        isUrgent: Boolean(order.isUrgent),
        isSubsidy: false,
        subsidyAmount: 0,
        deductAmount: 0,
        settlementStatus: 'unpaid',
        settlementStatusText: '未支付'
      }
    }

    if (netPayAmount <= 0 && refundAmount >= payAmount) {
      return {
        hasPayment: true,
        payAmount,
        refundAmount,
        netPayAmount: 0,
        staffReward: 0,
        platformProfit: 0,
        commissionRate: rate,
        commissionRateText: ratePercentText,
        platformProfitRateText: platformRatePercentText,
        isUrgent: Boolean(order.isUrgent),
        isSubsidy: false,
        subsidyAmount: 0,
        deductAmount: 0,
        settlementStatus: 'refunded',
        settlementStatusText: '已全额退款 (无收益)'
      }
    }

    let staffReward = 0
    let deductAmount = 0
    let commissionText = ratePercentText
    const isUrgent = Boolean(order.isUrgent && Number(order.urgentStaffReward) > 0)

    if (actualEarning && typeof actualEarning.amount === 'number') {
      staffReward = Number(actualEarning.amount)
      deductAmount = Number(actualEarning.deductAmount || 0)
      if (actualEarning.commissionRate) {
        commissionText = `${Math.round(actualEarning.commissionRate * 100)}%`
      }
    } else if (order.completionType === 'admin_manual' && order.adminManualStaffReward !== undefined) {
      staffReward = Number(order.adminManualStaffReward)
      deductAmount = Number(order.adminManualDeductEarning || 0)
    } else if (isUrgent) {
      staffReward = Number(order.urgentStaffReward)
      commissionText = '加急补贴一口价'
      if (Number(order.adminManualDeductEarning) > 0) {
        deductAmount = Number(order.adminManualDeductEarning)
        staffReward = Math.max(0, staffReward - deductAmount)
      }
    } else {
      const netPayCents = Math.max(0, Math.round(netPayAmount * 100))
      staffReward = splitOrderCents(netPayCents, rate).staffCents / 100
      if (Number(order.adminManualDeductEarning) > 0) {
        deductAmount = Number(order.adminManualDeductEarning)
        staffReward = Math.max(0, staffReward - deductAmount)
      }
    }

    staffReward = Math.round(staffReward * 100) / 100
    const netPayCents = Math.max(0, Math.round(netPayAmount * 100))
    const staffRewardCents = Math.round(staffReward * 100)
    const platformProfit = (netPayCents - staffRewardCents) / 100
    const isSubsidy = platformProfit < 0
    const subsidyAmount = isSubsidy ? Math.abs(platformProfit) : 0

    let settlementStatus = 'estimated'
    let settlementStatusText = '履约中 (预计收益)'
    if (order.status === 'completed' || (actualEarning && ['available', 'withdrawn', 'pending'].includes(actualEarning.status))) {
      settlementStatus = 'settled'
      settlementStatusText = actualEarning && actualEarning.status === 'withdrawn' ? '已结算并提现' : '已完单结算入账'
    } else if (order.status === 'cancelled') {
      settlementStatus = 'cancelled'
      settlementStatusText = '已取消订单结算'
    }

    return {
      hasPayment: true,
      payAmount,
      refundAmount,
      netPayAmount,
      staffReward,
      platformProfit,
      commissionRate: rate,
      commissionRateText: commissionText,
      platformProfitRateText: isSubsidy ? '平台加急补贴' : platformRatePercentText,
      isUrgent,
      isSubsidy,
      subsidyAmount,
      deductAmount,
      settlementStatus,
      settlementStatusText
    }
  }

  return {
    calculateStaffEarningForOrder,
    calculateAvailableAt,
    ensureStaffEarning,
    refreshStaffEarnings,
    summarizeStaffEarnings,
    adjustStaffEarningsForRefund,
    buildOrderProfitSummary
  }
}
