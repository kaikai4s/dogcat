module.exports = function createHandler(context) {
  const {
    createWithdrawRequest,
    db,
    getSystemSettings,
    getUser,
    refreshStaffEarnings,
    safeText,
    summarizeStaffEarnings
  } = context
  return async function finance(openid, action, data) {
    if (action === 'getStaffBalance') {
      await getUser(openid)
      await refreshStaffEarnings(openid)
      const earnings = (await db.collection('staff_earnings').where({ staffOpenid: openid }).get()).data || []
      const withdraws = (await db.collection('withdraw_requests').where({ staffOpenid: openid }).orderBy('createdAt', 'desc').get()).data || []
      const settings = await getSystemSettings()
      return { ...summarizeStaffEarnings(earnings), minWithdrawAmount: settings.settlement.minWithdrawAmount, withdraws }
    }
    if (action === 'listStaffEarnings') {
      await getUser(openid)
      await refreshStaffEarnings(openid)
      const status = safeText(data.status).trim()
      const res = await db.collection('staff_earnings').where({ staffOpenid: openid }).orderBy('createdAt', 'desc').get()
      return (res.data || []).filter((item) => !status || item.status === status)
    }
    if (action === 'listMyWithdraws') {
      await getUser(openid)
      const res = await db.collection('withdraw_requests').where({ staffOpenid: openid }).orderBy('createdAt', 'desc').get()
      return res.data || []
    }
    if (action === 'createWithdrawRequest') {
      return createWithdrawRequest(openid, data)
    }
    throw new Error('未知 finance 操作')
  }
}
