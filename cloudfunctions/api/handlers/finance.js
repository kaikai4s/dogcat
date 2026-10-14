module.exports = function createHandler(context) {
  const {
    createWithdrawRequest,
    createUserAssetWithdraw,
    getUserAssetSummary,
    bindInviteCode,
    db,
    readScopedDocuments,
    getSystemSettings,
    getUser,
    getWechatTransferQuotaSnapshot,
    queryWechatWithdrawalTransfer,
    refreshStaffEarnings,
    safeText,
    summarizeStaffEarnings
  } = context
  const readAll = readScopedDocuments
  return async function finance(openid, action, data) {
    if (action === 'getStaffBalance') {
      await getUser(openid)
      await refreshStaffEarnings(openid)
      const earnings = await readAll('staff_earnings', { staffOpenid: openid })
      const withdraws = (await readAll('withdraw_requests', { staffOpenid: openid })).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      const settings = await getSystemSettings()
      const balance = summarizeStaffEarnings(earnings)
      const assetSummary = await getUserAssetSummary(openid).catch(() => null)
      const wechatTransferQuota = typeof getWechatTransferQuotaSnapshot === 'function'
        ? await getWechatTransferQuotaSnapshot(openid, Math.round(Number(balance.availableAmount || balance.available || 0) * 100)).catch(() => null)
        : null
      return { ...balance, minWithdrawAmount: settings.settlement.minWithdrawAmount, withdraws, assetSummary, wechatTransferQuota }
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
    if (action === 'queryMyWithdrawTransfer') {
      await getUser(openid)
      const id = safeText(data && data.id).trim()
      if (!id) throw new Error('缺少提现申请 ID')
      const request = (await db.collection('withdraw_requests').doc(id).get().catch(() => ({ data: null }))).data
      if (!request || request.staffOpenid !== openid) throw new Error('无权查询该提现申请')
      const result = await queryWechatWithdrawalTransfer(id)
      return { id, status: result.request && result.request.status, transferStatus: result.request && result.request.transferStatus }
    }
    if (action === 'getMyWithdrawTransferConfirmation') {
      await getUser(openid)
      const id = safeText(data && data.id).trim()
      if (!id) throw new Error('缺少提现申请 ID')
      const request = (await db.collection('withdraw_requests').doc(id).get().catch(() => ({ data: null }))).data
      if (!request || request.staffOpenid !== openid) throw new Error('无权确认该提现申请')
      if (request.payoutChannel !== 'wechat_wallet') throw new Error('仅微信提现单支持收款确认')
      const settings = await getSystemSettings()
      return {
        status: request.wechatTransferState || request.transferStatus || request.status,
        mchId: settings.payment && settings.payment.mchId || '',
        appId: settings.payment && settings.payment.appId || '',
        packageInfo: request.wechatPackageInfo || request.transferPackageInfo || ''
      }
    }
    if (action === 'createWithdrawRequest') {
      return createWithdrawRequest(openid, data)
    }
    if (action === 'getUserAssetSummary') {
      return getUserAssetSummary(openid)
    }
    if (action === 'createUserAssetWithdraw') {
      return createUserAssetWithdraw(openid, data)
    }
    if (action === 'bindInviteCode') {
      return bindInviteCode(openid, data)
    }
    throw new Error('未知 finance 操作')
  }
}
