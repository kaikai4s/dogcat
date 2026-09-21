module.exports = function createService({
  appendFinanceLog,
  db,
  getSystemSettings,
  now,
  parseDateValue
}) {
  async function calculateStaffEarningForOrder(order) {
    if (!order || !order.payAmount) return { earningAmount: 0, commissionRate: 0.7 }
    const settings = await getSystemSettings()
    const rate = Number(settings.settlement.staffCommissionRate || 0.7)
    const grossAmount = Number(order.payAmount || 0)
    const earningAmount = Math.round(grossAmount * rate * 100) / 100
    return { earningAmount, commissionRate: rate }
  }

  function calculateAvailableAt(completedAt, delayDays) {
    const base = parseDateValue(completedAt) || now()
    return new Date(base.getTime() + Math.max(Number(delayDays || 0), 0) * 86400000)
  }

  async function ensureStaffEarning(order, completedAt = now()) {
    if (!order || !order._id || !order.staffOpenid) return null
    const existing = await db.collection('staff_earnings').where({ orderId: order._id }).limit(1).get()
    if (existing.data[0]) return existing.data[0]
    const settings = await getSystemSettings()
    const rate = Number(settings.settlement.staffCommissionRate || 0.7)
    const grossAmount = Number(order.payAmount || 0)
    const earningAmount = Math.round(grossAmount * rate * 100) / 100
    const time = now()
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
      status: settings.settlement.settlementDelayDays > 0 ? 'pending' : 'available',
      availableAt: calculateAvailableAt(completedAt, settings.settlement.settlementDelayDays),
      withdrawRequestId: '',
      frozenReason: '',
      createdAt: time,
      updatedAt: time
    }
    const created = await db.collection('staff_earnings').add({ data: earning })
    await appendFinanceLog('staff_earning_created', { targetType: 'staff_earning', targetId: created._id, orderId: order._id, staffOpenid: order.staffOpenid, amountDelta: earningAmount, detail: { commissionRate: rate } })
    return { _id: created._id, ...earning }
  }

  async function refreshStaffEarnings(openid = '') {
    const query = openid ? { staffOpenid: openid, status: 'pending' } : { status: 'pending' }
    const res = await db.collection('staff_earnings').where(query).get()
    const time = now()
    for (const earning of res.data || []) {
      const availableAt = parseDateValue(earning.availableAt)
      if (availableAt && availableAt.getTime() <= time.getTime()) {
        const result = await db.collection('staff_earnings').where({ _id: earning._id, status: 'pending' }).update({ data: { status: 'available', updatedAt: time } })
        if (result.stats.updated) earning.status = 'available'
      }
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
