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
  async function readAll(collectionName, where = {}, maxLimit = 2000) {
    const rows = []
    let cursor = ''
    while (rows.length < maxLimit) {
      const condition = { ...where }
      if (cursor && db.command && typeof db.command.gt === 'function') {
        condition._id = db.command.gt(cursor)
      }
      const page = (await db.collection(collectionName).where(condition).orderBy('_id', 'asc').limit(100).get()).data || []
      rows.push(...page)
      if (page.length < 100) return rows
      const nextCursor = page[page.length - 1] && page[page.length - 1]._id
      if (!nextCursor || nextCursor === cursor) return rows
      cursor = nextCursor
    }
    return rows
  }
  return async function finance(openid, action, data) {
    if (action === 'getStaffBalance') {
      await getUser(openid)
      await refreshStaffEarnings(openid)
      const earnings = await readAll('staff_earnings', { staffOpenid: openid })
      const withdraws = (await readAll('withdraw_requests', { staffOpenid: openid })).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      const settings = await getSystemSettings()
      return { ...summarizeStaffEarnings(earnings), minWithdrawAmount: settings.settlement.minWithdrawAmount, withdraws }
    }
    if (action === 'listStaffEarnings') {
      await getUser(openid)
      await refreshStaffEarnings(openid)
      const status = safeText(data.status).trim()
      const rows = await readAll('staff_earnings', { staffOpenid: openid })
      return rows.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).filter((item) => !status || item.status === status)
    }
    if (action === 'listMyWithdraws') {
      await getUser(openid)
      return (await readAll('withdraw_requests', { staffOpenid: openid })).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    }
    if (action === 'createWithdrawRequest') {
      return createWithdrawRequest(openid, data)
    }
    throw new Error('未知 finance 操作')
  }
}
