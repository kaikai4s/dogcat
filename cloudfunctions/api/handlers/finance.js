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
    submitWechatWithdrawalTransfer,
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
      return { ...balance, minWithdrawAmount: Math.max(0.10, Number(settings.settlement.minWithdrawAmount || 0)), withdraws, assetSummary, wechatTransferQuota }
    }
    if (action === 'listStaffEarnings') {
      await getUser(openid)
      await refreshStaffEarnings(openid)
      const status = safeText(data.status).trim()
      const rows = await readAll('staff_earnings', { staffOpenid: openid })
      return rows
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
        .filter((item) => !status || item.status === status)
        .map((item) => {
          const { grossAmount, ...safeItem } = item
          return safeItem
        })
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
      const applicantOpenid = safeText(request && (request.staffOpenid || request.userOpenid || request.recipientOpenid || request.openid)).trim()
      if (!request || applicantOpenid !== openid) throw new Error('无权查询该提现申请')
      if (request.status === 'paid' || !safeText(request.outBillNo || request.outDetailNo).trim()) {
        return {
          id,
          status: request.status,
          transferStatus: request.transferStatus,
          wechatTransferState: request.wechatTransferState,
          paidAt: request.paidAt
        }
      }
      const result = await queryWechatWithdrawalTransfer(id)
      const current = (result && result.request) || (await db.collection('withdraw_requests').doc(id).get().catch(() => ({ data: null }))).data
      return {
        id,
        status: current && current.status,
        transferStatus: current && current.transferStatus,
        wechatTransferState: current && current.wechatTransferState,
        paidAt: current && current.paidAt
      }
    }
    if (action === 'getMyWithdrawTransferConfirmation') {
      await getUser(openid)
      const id = safeText(data && data.id).trim()
      if (!id) throw new Error('缺少提现申请 ID')
      const request = (await db.collection('withdraw_requests').doc(id).get().catch(() => ({ data: null }))).data
      const applicantOpenid = safeText(request && (request.staffOpenid || request.userOpenid || request.recipientOpenid || request.openid)).trim()
      if (!request || applicantOpenid !== openid) throw new Error('无权确认该提现申请')
      if (request.payoutChannel !== 'wechat_wallet') throw new Error('仅微信提现单支持收款确认')
      const settings = await getSystemSettings()
      let packageInfo = safeText(request.wechatPackageInfo || request.transferPackageInfo).trim()
      let transferState = safeText(request.wechatTransferState || request.transferStatus || request.status).trim().toUpperCase()

      // 如果当前是待收款人确认收款，但 packageInfo 缺失（例如曾被历史状态查询置空），
      // 依据微信支付官方规范：使用原商户单号与参数重新调用发起转账，微信支持3天内幂等返回原单据及 package_info。
      if (transferState === 'WAIT_USER_CONFIRM' && !packageInfo && typeof submitWechatWithdrawalTransfer === 'function') {
        try {
          const res = await submitWechatWithdrawalTransfer(id, { openid })
          const updatedReq = res && res.request ? res.request : (await db.collection('withdraw_requests').doc(id).get().catch(() => ({ data: null }))).data
          if (updatedReq) {
            packageInfo = safeText(updatedReq.wechatPackageInfo || updatedReq.transferPackageInfo).trim()
            transferState = safeText(updatedReq.wechatTransferState || updatedReq.transferStatus || updatedReq.status).trim().toUpperCase()
          }
        } catch (err) {
          console.error('[finance:getMyWithdrawTransferConfirmation] 恢复 package_info 失败:', err)
        }
      }

      return {
        status: transferState,
        mchId: settings.payment && settings.payment.mchId || '',
        appId: settings.payment && settings.payment.appId || '',
        packageInfo
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
