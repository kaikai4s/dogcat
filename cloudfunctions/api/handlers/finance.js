module.exports = function createHandler(context) {
  const {
    appendFinanceLog,
    db,
    findByClientRequestId,
    getClientRequestId,
    getSystemSettings,
    getUser,
    makeIdempotencyKey,
    now,
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
      await getUser(openid)
      const clientRequestId = getClientRequestId(data)
      const existingByRequest = await findByClientRequestId('withdraw_requests', { staffOpenid: openid, clientRequestId })
      if (existingByRequest) return existingByRequest
      await refreshStaffEarnings(openid)
      const settings = await getSystemSettings()
      const earnings = (await db.collection('staff_earnings').where({ staffOpenid: openid, status: 'available' }).get()).data || []
      const total = earnings.reduce((sum, item) => sum + Number(item.amount || 0), 0)
      const amount = Math.min(Number(data.amount || total), total)
      if (amount <= 0) throw new Error('暂无可提现收益')
      if (amount < Number(settings.settlement.minWithdrawAmount || 0)) throw new Error(`最低提现金额 ¥${settings.settlement.minWithdrawAmount}`)
      let remaining = amount
      const selected = []
      for (const earning of earnings) {
        if (remaining <= 0) break
        selected.push(earning)
        remaining -= Number(earning.amount || 0)
      }
      const time = now()
      const request = {
        staffOpenid: openid,
        openid,
        clientRequestId,
        idempotencyKey: clientRequestId || makeIdempotencyKey('withdraw', openid, time.getTime()),
        amount: selected.reduce((sum, item) => sum + Number(item.amount || 0), 0),
        status: 'pending',
        earningIds: selected.map((item) => item._id),
        accountName: safeText(data.accountName).trim(),
        accountNo: safeText(data.accountNo).trim(),
        remark: safeText(data.remark).trim(),
        auditRemark: '',
        createdAt: time,
        updatedAt: time
      }
      const created = await db.collection('withdraw_requests').add({ data: request })

      const updateResults = await Promise.all(selected.map(async (earning) => {
        try {
          const updateRes = await db.collection('staff_earnings').where({
            _id: earning._id,
            status: 'available'
          }).update({
            data: {
              status: 'withdrawing',
              withdrawRequestId: created._id,
              updatedAt: time
            }
          })
          return { earningId: earning._id, success: updateRes.stats.updated > 0 }
        } catch (error) {
          return { earningId: earning._id, success: false, error: error.message }
        }
      }))

      const failedUpdates = updateResults.filter(r => !r.success)
      if (failedUpdates.length > 0) {
        await db.collection('withdraw_requests').doc(created._id).remove()
        throw new Error('提现请求失败：部分收益记录已被其他操作占用，请刷新后重试')
      }

      await appendFinanceLog('withdraw_requested', { targetType: 'withdraw_request', targetId: created._id, staffOpenid: openid, amountDelta: -request.amount, detail: { earningIds: request.earningIds } })
      return { _id: created._id, ...request }
    }
    throw new Error('未知 finance 操作')
  }
}
