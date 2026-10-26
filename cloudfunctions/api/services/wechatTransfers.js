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
  prepareWechatSubmissionQuota,
  now,
  safeText
}) {
  // Frontend validation uses ¥0.10. The backend keeps only a one-fen floor
  // so review/retry of an existing request is not blocked by that UI rule.
  const WECHAT_MIN_TRANSFER_CENTS = 1
  const WECHAT_MAX_TRANSFER_CENTS = 20000

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

  async function ensureTransferIntent(withdrawId, operator = {}, settings = null) {
    return db.runTransaction(async tx => {
      const request = (await tx.collection('withdraw_requests').doc(withdrawId).get()).data
      if (!request) throw new Error('提现申请不存在')
      if (request.payoutChannel !== 'wechat_wallet') throw new Error('非微信提现单不能执行微信零钱转账')
      if (request.status === 'paid') return request
      if (!['approved', 'transferring', 'transfer_failed'].includes(request.status)) throw new Error('仅审核通过的微信提现单可发起转账')
      if (request.transferSubmittedAt && (!request.transferMchId || !request.transferAppId) && operator.gatewayBillConfirmed !== true) {
        throw new Error('历史转账缺少原商户信息，请先人工核对原单')
      }
      if (!request.assetType || request.assetType === 'staff') {
        for (const id of request.earningIds || []) {
          const earning = (await tx.collection('staff_earnings').doc(id).get()).data
          if (earning?.pendingRefundIds?.length) throw new Error('关联订单退款处理中，暂不可发起提现打款')
        }
      }
      const validationConfig = getWechatTransferConfig(settings || await getSystemSettings({ includeSecrets: true }))
      if ((request.transferMchId && request.transferMchId !== validationConfig.mchId) ||
          (request.transferAppId && request.transferAppId !== validationConfig.appId)) throw new Error('原转账商户或小程序配置已变化，请先核对原单')
      validateTransferAmount(request, validationConfig)
      const recipientOpenid = safeText(request.recipientOpenid || request.staffOpenid || request.userOpenid || request.openid).trim()
      if (!recipientOpenid) throw new Error('微信提现收款openid缺失，无法发起转账')
      const time = now()
      const outBillNo = safeText(request.outBillNo || request.outDetailNo).trim() || createOutBillNo(withdrawId)
      const patch = {
        ...(validationConfig.mchId ? { transferMchId: validationConfig.mchId } : {}),
        ...(validationConfig.appId ? { transferAppId: validationConfig.appId } : {}),
        outBillNo,
        outDetailNo: outBillNo,
        // Backfill requests created before recipientOpenid was persisted. The
        // same value is used in the actual transfer payload and admin display.
        recipientOpenid,
        transferStatus: request.transferStatus || 'queued',
        transferPreparedAt: request.transferPreparedAt || time,
        transferPreparedByOpenid: request.transferPreparedByOpenid || operator.openid || '',
        updatedAt: time
      }
      await prepareWechatSubmissionQuota(tx, { _id: withdrawId, ...request, ...patch }, { settings })
      await tx.collection('withdraw_requests').doc(withdrawId).update({ data: patch })
      return { ...request, ...patch }
    })
  }

  function normalizeTransferPerception(perception) {
    const text = safeText(perception).trim()
    if (!text) return ''
    // 微信支付商家转账官方规范：在“佣金报酬”(1005)场景下，user_recv_perception 参数不支持直接传入“佣金报酬”，
    // 否则微信接口会直接返回 INVALID_REQUEST 报错：“暂不支持展示当前传入的用户收款场景”。
    // 该场景微信官方支持的枚举为：“劳务报酬”、“报销款”、“企业补贴”、“开工利是”（留空则默认展示为“劳务报酬”）。
    // 若配置或传入了“佣金报酬”，自动规范化修正为合规的“劳务报酬”，彻底杜绝接口拦截报错。
    if (text === '佣金报酬') return '劳务报酬'
    return text
  }

  function resolveTransferScene(request, config) {
    const scenes = config.scenes || {}
    const commissionScene = scenes.commission || {}
    const primarySceneId = safeText(config.transferSceneId || commissionScene.sceneId).trim()

    let targetKey = 'commission'
    if (request.assetType === 'user') {
      targetKey = 'marketing'
    } else if (request.assetType === 'reimbursement' || request.reimbursementId) {
      targetKey = 'reimbursement'
    }

    const specific = scenes[targetKey]
    const specificSceneId = safeText(specific && specific.sceneId).trim()

    // 若商户单独配置了与主场景不同的有效独立场景（如已在微信商户平台开通多个转账场景）：
    if (specific && specificSceneId && specificSceneId !== primarySceneId) {
      const reports = Array.isArray(specific.sceneReportInfos) && specific.sceneReportInfos.length ? specific.sceneReportInfos : config.sceneReportInfos
      const customPerception = normalizeTransferPerception(specific.userRecvPerception || config.userRecvPerception)
      return {
        sceneId: specificSceneId,
        userRecvPerception: customPerception,
        sceneReportInfos: reports,
        remark: safeText(specific.remark || (targetKey === 'marketing' ? '邀请活动收益提现' : '一次性用品采购报销')).trim()
      }
    }

    // 单场景模式（统一复用商户已开通的“佣金报酬”场景）：
    // 在微信支付规范中，1005 佣金报酬支持通过【岗位类型】+【报酬说明】向平台推广顾问发放邀请返佣款
    const rawCommissionPerception = safeText(commissionScene.userRecvPerception || config.userRecvPerception).trim()
    const defaultCommissionPerception = normalizeTransferPerception(rawCommissionPerception) || '劳务报酬'

    if (targetKey === 'marketing') {
      const customReports = Array.isArray(specific && specific.sceneReportInfos) && specific.sceneReportInfos.length
        ? specific.sceneReportInfos
        : [
            { info_type: '岗位类型', info_content: '平台推广顾问' },
            { info_type: '报酬说明', info_content: '邀请好友推广佣金提现' }
          ]
      const marketingPerception = normalizeTransferPerception((specific && specific.userRecvPerception) || defaultCommissionPerception) || '劳务报酬'
      return {
        sceneId: primarySceneId,
        userRecvPerception: marketingPerception,
        sceneReportInfos: customReports,
        remark: safeText((specific && specific.remark) || '邀请好友推广佣金提现').trim()
      }
    }

    if (targetKey === 'reimbursement') {
      const customReports = Array.isArray(specific && specific.sceneReportInfos) && specific.sceneReportInfos.length
        ? specific.sceneReportInfos
        : [
            { info_type: '岗位类型', info_content: '宠托师' },
            { info_type: '报酬说明', info_content: '一次性服务用品采购报销' }
          ]
      const reimbPerception = normalizeTransferPerception((specific && specific.userRecvPerception) || '报销款') || '报销款'
      return {
        sceneId: primarySceneId,
        userRecvPerception: reimbPerception,
        sceneReportInfos: customReports,
        remark: safeText((specific && specific.remark) || '一次性用品采购报销').trim()
      }
    }

    // 宠托师服务收益提现
    const reports = Array.isArray(commissionScene.sceneReportInfos) && commissionScene.sceneReportInfos.length
      ? commissionScene.sceneReportInfos
      : (Array.isArray(config.sceneReportInfos) && config.sceneReportInfos.length
          ? config.sceneReportInfos
          : [
              { info_type: '岗位类型', info_content: '宠托师' },
              { info_type: '报酬说明', info_content: '宠托师上门服务收益提现' }
            ])
    return {
      sceneId: primarySceneId,
      userRecvPerception: defaultCommissionPerception,
      sceneReportInfos: reports,
      remark: safeText(commissionScene.remark || config.transferRemark || request.remark || '宠托师服务收益提现').trim()
    }
  }

  function buildTransferPayload(request, config) {
    const amountFen = validateTransferAmount(request, config)
    const scene = resolveTransferScene(request, config)
    const recipientOpenid = safeText(request.recipientOpenid || request.staffOpenid || request.userOpenid || request.openid).trim()
    if (!recipientOpenid) throw new Error('微信提现收款openid缺失，无法发起转账')
    const perception = normalizeTransferPerception(scene.userRecvPerception)
    const payload = {
      appid: config.appId,
      out_bill_no: request.outBillNo,
      transfer_scene_id: scene.sceneId,
      openid: recipientOpenid,
      transfer_amount: amountFen,
      transfer_remark: safeText(scene.remark || request.remark).trim()
    }
    if (perception) {
      payload.user_recv_perception = perception
    }
    if (config.transferNotifyUrl) payload.notify_url = config.transferNotifyUrl
    if (Array.isArray(scene.sceneReportInfos) && scene.sceneReportInfos.length) {
      payload.transfer_scene_report_infos = scene.sceneReportInfos
        .map(item => ({ info_type: safeText(item && item.info_type).trim(), info_content: safeText(item && item.info_content).trim() }))
        .filter(item => item.info_type && item.info_content)
    }
    const recipientName = safeText(request.recipientName || request.accountName).trim()
    if (recipientName) payload.user_name = encryptWechatTransferUserName(recipientName, config)
    return payload
  }

  function validateTransferAmount(request, config) {
    const amountFen = request.amountFen || cents(request.amount)
    if (amountFen < WECHAT_MIN_TRANSFER_CENTS) throw new Error('微信提现金额必须至少为 ¥0.01')
    const configuredMaxFen = cents(config.transferMaxAmount)
    const maxFen = Math.min(WECHAT_MAX_TRANSFER_CENTS, configuredMaxFen)
    if (amountFen > maxFen) {
      const maxYuan = (maxFen / 100).toFixed(2)
      throw new Error(`微信提现金额超过单笔上限 ¥${maxYuan}`)
    }
    return amountFen
  }

  async function patchTransferProcessing(withdrawId, patch = {}, { allowRetry = false, incrementAttempt = false } = {}) {
    return db.runTransaction(async tx => {
      const request = (await tx.collection('withdraw_requests').doc(withdrawId).get()).data
      if (!request) throw new Error('提现申请不存在')
      if (!['approved', 'transferring', ...(allowRetry ? ['transfer_failed'] : [])].includes(request.status)) return { request, changed: false }
      const time = now()
      const updated = {
        status: 'transferring', transferStatus: 'processing',
        transferSubmittedAt: request.transferSubmittedAt || time,
        lastTransferCheckedAt: new Date(Math.max(new Date(time).getTime(), (new Date(request.lastTransferCheckedAt || 0).getTime() || 0) + 1)), updatedAt: time, ...patch,
        ...(incrementAttempt ? { transferAttemptCount: Number(request.transferAttemptCount || 0) + 1 } : {})
      }
      await tx.collection('withdraw_requests').doc(withdrawId).update({ data: updated })
      return { request: { ...request, ...updated }, changed: true }
    })
  }

  async function submitWechatWithdrawalTransfer(withdrawId, operator = {}) {
    const settings = await getSystemSettings({ includeSecrets: true })
    let prepared
    try {
      prepared = await ensureTransferIntent(withdrawId, operator, settings)
    } catch (error) {
      if (String(error.message || error.errMsg || error).includes('额度') || String(error.message || error.errMsg || error).includes('当日全平台转帐额度受限')) {
        await db.collection('withdraw_requests').doc(withdrawId).update({ data: { lastTransferError: safeText(error.message || error).slice(0, 500), lastTransferCheckedAt: now(), updatedAt: now() } }).catch(() => {})
      }
      throw error
    }
    if (prepared.status === 'paid') return prepared
    const config = getWechatTransferConfig(settings)
    const payload = buildTransferPayload(prepared, config)
    const headers = payload.user_name ? { 'Wechatpay-Serial': config.platformCertSerialNo } : {}
    const submitting = await patchTransferProcessing(withdrawId, { transferStatus: 'submitting', lastTransferError: '' }, { allowRetry: true, incrementAttempt: true })
    if (!submitting.changed) return submitting
    try {
      const response = await wechatPayRequest('POST', '/v3/fund-app/mch-transfer/transfer-bills', payload, config, headers)
      return applyWechatTransferResult(withdrawId, response, 'submit')
    } catch (error) {
      const failed = await patchTransferProcessing(withdrawId, {
        // A transport or parsing error never proves that funds did not move.
        // Only an explicit terminal gateway state may release transfer quota.
        transferStatus: 'unknown',
        lastTransferError: safeText(error.message || '微信转账提交失败').slice(0, 500)
      })
      if (!failed.changed) return failed
      return { ...failed.request, request: failed.request, changed: true }
    }
  }

  async function queryWechatWithdrawalTransfer(withdrawId, { retryMissing = false } = {}) {
    const request = await readWechatWithdrawal(withdrawId)
    const outBillNo = safeText(request.outBillNo || request.outDetailNo).trim()
    if (!outBillNo) throw new Error('微信提现单号缺失')
    const settings = await getSystemSettings({ includeSecrets: true })
    const config = getWechatTransferConfig(settings)
    // 当前商家转账查询接口只接受路径参数 out_bill_no；mchid 不在该接口的请求参数中。
    if ((request.transferMchId && request.transferMchId !== config.mchId) ||
        (request.transferAppId && request.transferAppId !== config.appId)) throw new Error('原转账商户或小程序配置已变化，请先核对原单')
    let response
    try {
      response = await wechatPayRequest('GET', `/v3/fund-app/mch-transfer/transfer-bills/out-bill-no/${encodeURIComponent(outBillNo)}`, null, config)
    } catch (error) {
      if (retryMissing && error.code === 'RESOURCE_NOT_EXISTS' && ['approved', 'transferring', 'transfer_failed'].includes(request.status)) {
        if (request.transferSubmittedAt && (!request.transferMchId || !request.transferAppId)) throw new Error('历史转账缺少原商户信息，请先人工核对原单')
        // Resume the original authorized intent with its original bill number.
        return submitWechatWithdrawalTransfer(withdrawId, { openid: 'recover_missing_transfer' })
      }
      throw error
    }
    const result = await applyWechatTransferResult(withdrawId, response, 'query')
    const current = result && result.request
    const state = safeText(current && (current.wechatTransferState || current.status)).trim().toUpperCase()
    // 微信支付商家转账规范：GET 查询单接口不返回 package_info，仅 POST 发起接口返回。
    // 若微信侧处于待收款人确认 (WAIT_USER_CONFIRM)，但本地缺失 package_info，
    // 依据微信支付官方重入规范：使用相同 out_bill_no 重新发起转账（POST），微信会幂等返回原单据及 package_info。
    if (state === 'WAIT_USER_CONFIRM' && !safeText(current && (current.wechatPackageInfo || current.transferPackageInfo)).trim()) {
      try {
        return await submitWechatWithdrawalTransfer(withdrawId, { openid: 'auto_recover_package_info', gatewayBillConfirmed: true })
      } catch (err) {
        console.warn('[queryWechatWithdrawalTransfer] 自动幂等恢复 package_info 失败:', err)
      }
    }
    return result
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
        gatewayTerminalConfirmed: true,
        failReason: response.fail_reason || response.failReason,
        rawTransferResponse: sanitized
      })
    }
    const packageInfo = safeText(response.package_info || response.packageInfo).trim()
    const patch = {
      transferStatus: mapped === 'unknown' ? 'unknown' : 'processing',
      wechatTransferState: state || 'PROCESSING',
      wechatTransferBillNo: safeText(response.transfer_bill_no).trim(),
      rawTransferResponse: sanitized,
      lastTransferSource: source
    }
    if (packageInfo) {
      patch.wechatPackageInfo = packageInfo
    }
    return patchTransferProcessing(withdrawId, patch)
  }

  async function retryWechatWithdrawalTransfer(withdrawId, operator = {}) {
    const request = await readWechatWithdrawal(withdrawId)
    if (!['approved', 'transferring', 'transfer_failed'].includes(request.status)) throw new Error('当前状态不可重试微信提现')
    if (['unknown', 'processing', 'submitting'].includes(request.transferStatus)) return queryWechatWithdrawalTransfer(withdrawId, { retryMissing: true })
    return submitWechatWithdrawalTransfer(withdrawId, operator)
  }

  async function reconcileWechatTransfers(limit = 10) {
    const maxLimit = Math.min(Math.max(Number(limit || 10), 1), 20)
    const statusFilter = db.command && typeof db.command.in === 'function' ? db.command.in(['approved', 'transferring', 'transfer_failed']) : undefined
    const query = statusFilter
      ? db.collection('withdraw_requests').where({ payoutChannel: 'wechat_wallet', status: statusFilter })
      : db.collection('withdraw_requests').where({ payoutChannel: 'wechat_wallet' })
    const rows = (await query.orderBy('lastTransferCheckedAt', 'asc').orderBy('_id', 'asc').limit(maxLimit).get()).data || []
    const pending = rows.filter(item => ['approved', 'transferring', 'transfer_failed'].includes(safeText(item.status).trim()) || ['processing', 'unknown', 'submitting'].includes(safeText(item.transferStatus).trim()))
    const results = []
    for (const item of pending.slice(0, maxLimit)) {
      // Advance the scheduling timestamp before I/O, including failures and
      // terminal-state no-ops, so waiting or broken requests cannot monopolize a batch.
      const checkedAt = new Date(Math.max(new Date(now()).getTime(), (new Date(item.lastTransferCheckedAt || 0).getTime() || 0) + 1))
      await db.collection('withdraw_requests').doc(item._id).update({ data: { lastTransferCheckedAt: checkedAt } })
      try {
        if (item.outBillNo || item.outDetailNo) results.push(await queryWechatWithdrawalTransfer(item._id, { retryMissing: true }))
        else results.push(await submitWechatWithdrawalTransfer(item._id, { openid: 'scheduled' }))
      } catch (error) {
        await db.collection('withdraw_requests').doc(item._id).update({ data: { lastTransferError: safeText(error.message).slice(0, 500), updatedAt: now() } }).catch(() => {})
      }
    }
    return { checked: results.length }
  }

  return {
    createOutBillNo,
    mapTransferState,
    resolveTransferScene,
    buildTransferPayload,
    submitWechatWithdrawalTransfer,
    queryWechatWithdrawalTransfer,
    applyWechatTransferResult,
    retryWechatWithdrawalTransfer,
    reconcileWechatTransfers
  }
}
