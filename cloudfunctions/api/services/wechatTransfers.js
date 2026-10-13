module.exports = function createService({
  crypto,
  db,
  getSystemSettings,
  getWechatTransferConfig,
  wechatPayRequest,
  encryptWechatTransferUserName,
  sanitizeWechatTransferPayload,
  markWechatWithdrawalPaid,
  markWechatWithdrawalFailed,
  now,
  safeText
}) {
  function cents(value) {
    const amount = Number(value)
    const result = Math.round(amount * 100)
    if (!Number.isFinite(amount) || !Number.isSafeInteger(result) || result <= 0 || Math.abs(amount * 100 - result) > 0.000001) throw new Error('提现金额不正确')
    return result
  }

  function createOutBillNo(withdrawId) {
    const hash = crypto.createHash('sha256').update(`wechat_withdraw:${withdrawId}`).digest('hex').slice(0, 20).toUpperCase()
    return `WD${hash}`
  }

  function mapTransferState(state) {
    const normalized = safeText(state).trim().toUpperCase()
    if (normalized === 'SUCCESS') return 'success'
    if (['FAIL', 'CANCELLED', 'CLOSED'].includes(normalized)) return 'failed'
    if (['ACCEPTED', 'PROCESSING', 'WAIT_USER_CONFIRM', 'TRANSFERING'].includes(normalized)) return 'processing'
    return 'unknown'
  }

  async function readWechatWithdrawal(withdrawId) {
    const res = await db.collection('withdraw_requests').doc(withdrawId).get().catch(() => ({ data: null }))
    const request = res && res.data
    if (!request) throw new Error('提现申请不存在')
    if (request.payoutChannel !== 'wechat_wallet') throw new Error('非微信提现单不能执行微信零钱转账')
    return request
  }

  async function ensureTransferIntent(withdrawId, operator = {}) {
    return db.runTransaction(async tx => {
      const request = (await tx.collection('withdraw_requests').doc(withdrawId).get()).data
      if (!request) throw new Error('提现申请不存在')
      if (request.payoutChannel !== 'wechat_wallet') throw new Error('非微信提现单不能执行微信零钱转账')
      if (request.status === 'paid') return request
      if (!['approved', 'transferring', 'transfer_failed'].includes(request.status)) throw new Error('仅审核通过的微信提现单可发起转账')
      const time = now()
      const outBillNo = safeText(request.outBillNo || request.outDetailNo).trim() || createOutBillNo(withdrawId)
      const patch = {
        outBillNo,
        outDetailNo: outBillNo,
        transferStatus: request.transferStatus || 'queued',
        transferPreparedAt: request.transferPreparedAt || time,
        transferPreparedByOpenid: request.transferPreparedByOpenid || operator.openid || '',
        updatedAt: time
      }
      await tx.collection('withdraw_requests').doc(withdrawId).update({ data: patch })
      return { ...request, ...patch }
    })
  }

  function buildTransferPayload(request, config) {
    const amountFen = request.amountFen || cents(request.amount)
    const maxFen = cents(config.transferMaxAmount)
    if (amountFen > maxFen) throw new Error(`微信提现金额超过单笔上限 ¥${config.transferMaxAmount}`)
    const payload = {
      appid: config.appId,
      out_bill_no: request.outBillNo,
      transfer_scene_id: config.transferSceneId,
      openid: request.recipientOpenid || request.staffOpenid,
      transfer_amount: amountFen,
      transfer_remark: safeText(config.transferRemark || request.remark).trim() || '宠托师服务收益提现',
      user_recv_perception: config.userRecvPerception
    }
    if (config.transferNotifyUrl) payload.notify_url = config.transferNotifyUrl
    if (Array.isArray(config.sceneReportInfos) && config.sceneReportInfos.length) {
      payload.transfer_scene_report_infos = config.sceneReportInfos
        .map(item => ({ info_type: safeText(item && item.info_type).trim(), info_content: safeText(item && item.info_content).trim() }))
        .filter(item => item.info_type && item.info_content)
    }
    const recipientName = safeText(request.recipientName || request.accountName).trim()
    if (recipientName) payload.user_name = encryptWechatTransferUserName(recipientName, config)
    return payload
  }

  async function patchTransferProcessing(withdrawId, patch = {}) {
    const time = now()
    await db.collection('withdraw_requests').doc(withdrawId).update({ data: {
      status: 'transferring',
      transferStatus: 'processing',
      transferSubmittedAt: patch.transferSubmittedAt || time,
      lastTransferCheckedAt: time,
      updatedAt: time,
      ...patch
    } })
  }

  async function submitWechatWithdrawalTransfer(withdrawId, operator = {}) {
    const prepared = await ensureTransferIntent(withdrawId, operator)
    if (prepared.status === 'paid') return prepared
    const settings = await getSystemSettings({ includeSecrets: true })
    const config = getWechatTransferConfig(settings)
    const payload = buildTransferPayload(prepared, config)
    const headers = payload.user_name ? { 'Wechatpay-Serial': config.platformCertSerialNo } : {}
    const attempt = Number(prepared.transferAttemptCount || 0) + 1
    await db.collection('withdraw_requests').doc(withdrawId).update({ data: {
      status: 'transferring',
      transferStatus: 'submitting',
      transferAttemptCount: attempt,
      lastTransferError: '',
      updatedAt: now()
    } })
    try {
      const response = await wechatPayRequest('POST', '/v3/fund-app/mch-transfer/transfer-bills', payload, config, headers)
      return applyWechatTransferResult(withdrawId, response, 'submit')
    } catch (error) {
      const uncertain = ['ETIMEDOUT', 'ECONNRESET', 'WECHAT_PAY_ERROR'].includes(error.code) || /超时|timeout|系统|SYSTEM/i.test(error.message || '')
      const time = now()
      await db.collection('withdraw_requests').doc(withdrawId).update({ data: {
        status: 'transferring',
        transferStatus: uncertain ? 'unknown' : 'failed',
        lastTransferError: safeText(error.message || '微信转账提交失败').slice(0, 500),
        lastTransferCheckedAt: time,
        updatedAt: time
      } })
      if (!uncertain) return markWechatWithdrawalFailed(withdrawId, { message: error.message, state: error.code || 'FAIL' })
      return { _id: withdrawId, status: 'transferring', transferStatus: 'unknown', lastTransferError: error.message }
    }
  }

  async function queryWechatWithdrawalTransfer(withdrawId) {
    const request = await readWechatWithdrawal(withdrawId)
    const outBillNo = safeText(request.outBillNo || request.outDetailNo).trim()
    if (!outBillNo) throw new Error('微信提现单号缺失')
    const settings = await getSystemSettings({ includeSecrets: true })
    const config = getWechatTransferConfig(settings)
    const response = await wechatPayRequest('GET', `/v3/fund-app/mch-transfer/transfer-bills/out-bill-no/${encodeURIComponent(outBillNo)}?mchid=${encodeURIComponent(config.mchId)}`, null, config)
    return applyWechatTransferResult(withdrawId, response, 'query')
  }

  async function applyWechatTransferResult(withdrawId, response = {}, source = 'query') {
    const state = safeText(response.state || response.transfer_state || response.status).trim().toUpperCase()
    const mapped = mapTransferState(state)
    const sanitized = sanitizeWechatTransferPayload(response)
    if (mapped === 'success') {
      return markWechatWithdrawalPaid(withdrawId, {
        state,
        transferBillNo: response.transfer_bill_no,
        rawTransferResponse: sanitized
      })
    }
    if (mapped === 'failed') {
      return markWechatWithdrawalFailed(withdrawId, {
        state,
        failReason: response.fail_reason || response.failReason,
        rawTransferResponse: sanitized
      })
    }
    await patchTransferProcessing(withdrawId, {
      transferStatus: mapped === 'unknown' ? 'unknown' : 'processing',
      wechatTransferState: state || 'PROCESSING',
      wechatTransferBillNo: safeText(response.transfer_bill_no).trim(),
      wechatPackageInfo: safeText(response.package_info).trim(),
      rawTransferResponse: sanitized,
      lastTransferSource: source
    })
    const latest = await db.collection('withdraw_requests').doc(withdrawId).get().catch(() => ({ data: null }))
    return { request: latest.data, changed: true }
  }

  async function retryWechatWithdrawalTransfer(withdrawId, operator = {}) {
    const request = await readWechatWithdrawal(withdrawId)
    if (!['approved', 'transferring', 'transfer_failed'].includes(request.status)) throw new Error('当前状态不可重试微信提现')
    if (request.transferStatus === 'unknown' || request.transferStatus === 'processing') return queryWechatWithdrawalTransfer(withdrawId)
    return submitWechatWithdrawalTransfer(withdrawId, operator)
  }

  async function reconcileWechatTransfers(limit = 10) {
    const rows = (await db.collection('withdraw_requests')
      .where({ payoutChannel: 'wechat_wallet' })
      .limit(Math.min(Math.max(Number(limit || 10), 1), 20))
      .get().catch(() => ({ data: [] }))).data || []
    const pending = rows.filter(item => ['approved', 'transferring'].includes(safeText(item.status).trim()) || ['processing', 'unknown', 'submitting'].includes(safeText(item.transferStatus).trim()))
    const results = []
    for (const item of pending.slice(0, limit)) {
      try {
        if (item.outBillNo || item.outDetailNo) results.push(await queryWechatWithdrawalTransfer(item._id))
        else results.push(await submitWechatWithdrawalTransfer(item._id, { openid: 'scheduled' }))
      } catch (error) {
        await db.collection('withdraw_requests').doc(item._id).update({ data: { lastTransferError: safeText(error.message).slice(0, 500), lastTransferCheckedAt: now(), updatedAt: now() } }).catch(() => {})
      }
    }
    return { checked: results.length }
  }

  return {
    createOutBillNo,
    mapTransferState,
    submitWechatWithdrawalTransfer,
    queryWechatWithdrawalTransfer,
    applyWechatTransferResult,
    retryWechatWithdrawalTransfer,
    reconcileWechatTransfers
  }
}
