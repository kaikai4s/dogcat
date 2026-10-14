module.exports = function createService({
  crypto,
  https,
  safeText
}) {
  function createPaymentNo() {
    return `P${crypto.randomBytes(15).toString('hex')}`
  }

  function createRefundNo() {
    return `R${crypto.randomBytes(15).toString('hex')}`
  }

  function normalizePem(value) {
    return safeText(value).trim().replace(/\\n/g, '\n')
  }

  function randomNonce(length = 32) {
    return crypto.randomBytes(length).toString('hex').slice(0, length)
  }

  function amountYuanToFen(amount) {
    const normalized = Math.round(Number(amount || 0) * 100)
    if (!Number.isSafeInteger(normalized) || normalized <= 0 || Math.abs(Number(amount) * 100 - normalized) > 0.000001) throw new Error('支付金额不正确')
    return normalized
  }

  function isProductionPaymentEnv() {
    if (process.env.NODE_ENV === 'production' || process.env.PAYMENT_ENV === 'production') return true
    const tcbEnv = String(process.env.TCB_ENV || process.env.WX_ENV_ID || process.env.SCF_NAMESPACE || '').trim().toLowerCase()
    if (tcbEnv && (tcbEnv.includes('prod') || tcbEnv.includes('production'))) return true
    return false
  }

  function assertPaymentModeAllowed(payment) {
    if (isProductionPaymentEnv() && payment.mode === 'mock') throw new Error('正式环境禁止使用模拟支付')
  }

  function getWechatPayConfig(settings) {
    const payment = settings.payment || {}
    const config = {
      appId: safeText(process.env.WECHAT_PAY_APP_ID || payment.appId).trim(),
      mchId: safeText(process.env.WECHAT_PAY_MCH_ID || payment.mchId).trim(),
      notifyUrl: safeText(process.env.WECHAT_PAY_NOTIFY_URL || payment.notifyUrl).trim(),
      certSerialNo: safeText(process.env.WECHAT_PAY_CERT_SERIAL_NO || payment.certSerialNo || payment.merchantCertSerialNo).trim(),
      apiV3Key: safeText(process.env.WECHAT_PAY_API_V3_KEY || payment.apiV3Key).trim(),
      privateKey: normalizePem(process.env.WECHAT_PAY_PRIVATE_KEY || payment.privateKey),
      platformPublicKey: normalizePem(process.env.WECHAT_PAY_PLATFORM_PUBLIC_KEY || payment.platformPublicKey),
      platformCertSerialNo: safeText(process.env.WECHAT_PAY_PLATFORM_CERT_SERIAL_NO || payment.platformCertSerialNo).trim(),
      refundEnabled: payment.refundEnabled !== false
    }
    if (!config.appId || !config.mchId || !config.notifyUrl || !config.certSerialNo || !config.apiV3Key || !config.privateKey) throw new Error('微信支付配置未完成')
    if (!/^https:\/\//i.test(config.notifyUrl)) throw new Error('微信支付回调地址必须是 HTTPS')
    return config
  }

  function getWechatTransferConfig(settings) {
    const config = getWechatPayConfig(settings)
    const transfer = (settings.staffSupplies && settings.staffSupplies.transfer) || (settings.payment && settings.payment.transfer) || {}
    const enabled = transfer.enabled === true || process.env.WECHAT_TRANSFER_ENABLED === 'true'
    const sceneId = safeText(process.env.WECHAT_TRANSFER_SCENE_ID || transfer.sceneId || transfer.transferSceneId).trim()
    const userRecvPerception = safeText(process.env.WECHAT_TRANSFER_USER_RECV_PERCEPTION || transfer.userRecvPerception).trim()
    const remark = safeText(process.env.WECHAT_TRANSFER_REMARK || transfer.remark).trim() || '宠托师服务收益提现'
    const notifyUrl = safeText(process.env.WECHAT_TRANSFER_NOTIFY_URL || transfer.notifyUrl).trim()
    const adminMaxAmount = Number(transfer.maxAmount || 0)
    const envMaxAmount = Number(process.env.WECHAT_TRANSFER_MAX_AMOUNT || 0)
    // 微信商家转账当前默认单笔上限为 200 元；商户已申请提额时再使用后台/环境变量配置。
    const maxAmount = [adminMaxAmount, envMaxAmount].filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b)[0] || 200
    let sceneReportInfos = Array.isArray(transfer.sceneReportInfos) ? transfer.sceneReportInfos : []
    if (typeof process.env.WECHAT_TRANSFER_SCENE_REPORT_INFOS === 'string' && process.env.WECHAT_TRANSFER_SCENE_REPORT_INFOS.trim()) {
      sceneReportInfos = JSON.parse(process.env.WECHAT_TRANSFER_SCENE_REPORT_INFOS)
    }
    const scenes = transfer.scenes || {}
    const primarySceneId = sceneId || (scenes.commission && scenes.commission.sceneId) || ''
    const primaryPerception = userRecvPerception || (scenes.commission && scenes.commission.userRecvPerception) || ''
    if (!enabled) throw new Error('微信提现到零钱未启用')
    if (!primarySceneId) throw new Error('微信商家转账场景 ID 未配置')
    if (!primaryPerception) throw new Error('微信商家转账收款用户感知未配置')
    if (!Number.isFinite(maxAmount) || maxAmount <= 0) throw new Error('微信提现单笔上限配置不正确')
    return { ...config, transferEnabled: enabled, transferSceneId: primarySceneId, transferRemark: remark, transferNotifyUrl: notifyUrl, transferMaxAmount: maxAmount, userRecvPerception: primaryPerception, sceneReportInfos, scenes }
  }

  function sanitizeWechatPayload(payload = {}) {
    const clone = JSON.parse(JSON.stringify(payload || {}))
    delete clone.apiV3Key
    delete clone.privateKey
    delete clone.privateKeyInput
    delete clone.platformPublicKey
    delete clone.platformPublicKeyInput
    if (clone.payer && clone.payer.openid) clone.payer = { openid: 'configured' }
    if (clone.resource && clone.resource.ciphertext) clone.resource = { ...clone.resource, ciphertext: '[encrypted]' }
    return clone
  }

  function maskOpenid(openid) {
    const text = safeText(openid).trim()
    if (!text) return ''
    return text.length <= 8 ? 'configured' : `${text.slice(0, 4)}****${text.slice(-4)}`
  }

  function sanitizeWechatTransferPayload(payload = {}) {
    const clone = sanitizeWechatPayload(payload)
    if (clone.openid) clone.openid = maskOpenid(clone.openid)
    if (clone.user_name) clone.user_name = '[encrypted]'
    if (clone.fail_reason) clone.fail_reason = safeText(clone.fail_reason).slice(0, 120)
    if (clone.transfer_scene_report_infos) clone.transfer_scene_report_infos = '[configured]'
    return clone
  }

  function encryptWechatTransferUserName(realName, config) {
    const name = safeText(realName).trim()
    if (!name) return ''
    if (!config.platformPublicKey) throw new Error('微信支付平台公钥未配置，无法加密收款人姓名')
    if (!config.platformCertSerialNo) throw new Error('微信支付平台证书序列号未配置，无法加密收款人姓名')
    return crypto.publicEncrypt({ key: config.platformPublicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, Buffer.from(name, 'utf8')).toString('base64')
  }

  function wechatPayRequest(method, path, body, config, extraHeaders = {}) {
    if (!isProductionPaymentEnv() && process.env.WECHAT_PAY_MOCK_PREPAY_ID && path.includes('/v3/pay/transactions/jsapi')) return Promise.resolve({ prepay_id: process.env.WECHAT_PAY_MOCK_PREPAY_ID })
    if (!isProductionPaymentEnv() && process.env.WECHAT_PAY_MOCK_REFUND_ID && path.includes('/v3/refund/domestic/refunds')) return Promise.resolve({ refund_id: process.env.WECHAT_PAY_MOCK_REFUND_ID, status: process.env.WECHAT_PAY_MOCK_REFUND_STATUS || 'PROCESSING' })

    return new Promise((resolve, reject) => {
      const bodyText = body ? JSON.stringify(body) : ''
      const timestamp = String(Math.floor(Date.now() / 1000))
      const nonce = randomNonce()
      const message = `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyText}\n`
      const signature = crypto.createSign('RSA-SHA256').update(message).sign(config.privateKey, 'base64')
      const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${config.certSerialNo}"`
      const req = https.request({
        hostname: 'api.mch.weixin.qq.com',
        port: 443,
        path,
        method,
        headers: {
          Authorization: authorization,
          Accept: 'application/json',
          'User-Agent': 'VipPetCare-WechatPay/1.0',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyText),
          ...extraHeaders
        }
      }, (res) => {
        let raw = ''
        res.on('data', (chunk) => { raw += chunk })
        res.on('end', () => {
          let json = {}
          try { json = raw ? JSON.parse(raw) : {} } catch (error) { return reject(new Error('微信支付响应解析失败')) }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json)
          const detail = json.detail || {}
          const detailText = [detail.field || detail.parameter, detail.issue || detail.description]
            .filter(value => safeText(value).trim())
            .join('：')
          const baseMessage = json.message || json.code || '微信支付请求失败'
          const error = new Error(detailText ? `${baseMessage}（${detailText}）` : baseMessage)
          error.code = json.code || 'WECHAT_PAY_ERROR'
          reject(error)
        })
      })
      req.on('error', reject)
      req.setTimeout(15000, () => req.destroy(new Error('微信支付请求超时')))
      if (bodyText) req.write(bodyText)
      req.end()
    })
  }

  function buildMiniProgramPayParams(prepayId, config) {
    const timeStamp = String(Math.floor(Date.now() / 1000))
    const nonceStr = randomNonce()
    const pkg = `prepay_id=${prepayId}`
    const message = `${config.appId}\n${timeStamp}\n${nonceStr}\n${pkg}\n`
    const paySign = crypto.createSign('RSA-SHA256').update(message).sign(config.privateKey, 'base64')
    return { timeStamp, nonceStr, package: pkg, signType: 'RSA', paySign }
  }

  function getHeader(headers = {}, name) {
    const foundKey = Object.keys(headers || {}).find((key) => key.toLowerCase() === name.toLowerCase())
    return foundKey ? headers[foundKey] : ''
  }

  function verifyWechatPayCallback(headers, rawBody, config) {
    if (process.env.WECHAT_PAY_SKIP_VERIFY === 'true') {
      if (isProductionPaymentEnv()) throw new Error('正式环境禁止跳过微信支付验签')
      return true
    }
    if (!config.platformPublicKey) throw new Error('微信支付平台公钥未配置')
    const timestamp = getHeader(headers, 'wechatpay-timestamp')
    const nonce = getHeader(headers, 'wechatpay-nonce')
    const signature = getHeader(headers, 'wechatpay-signature')
    if (!timestamp || !nonce || !signature) throw new Error('微信支付回调签名头缺失')
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) throw new Error('微信支付回调已过期')
    const message = `${timestamp}\n${nonce}\n${rawBody}\n`
    const ok = crypto.createVerify('RSA-SHA256').update(message).verify(config.platformPublicKey, signature, 'base64')
    if (!ok) throw new Error('微信支付回调验签失败')
    return true
  }

  function decryptWechatPayResource(resource = {}, apiV3Key = '') {
    if (!isProductionPaymentEnv() && process.env.WECHAT_PAY_MOCK_CALLBACK_RESOURCE) return JSON.parse(process.env.WECHAT_PAY_MOCK_CALLBACK_RESOURCE)
    const ciphertext = Buffer.from(resource.ciphertext || '', 'base64')
    if (ciphertext.length <= 16) throw new Error('微信支付回调密文无效')
    const authTag = ciphertext.slice(ciphertext.length - 16)
    const encrypted = ciphertext.slice(0, ciphertext.length - 16)
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(apiV3Key, 'utf8'), resource.nonce || '')
    decipher.setAuthTag(authTag)
    if (resource.associated_data) decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'))
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
    return JSON.parse(decrypted)
  }

  function mapWechatTradeState(state) {
    if (state === 'SUCCESS') return 'success'
    if (state === 'CLOSED' || state === 'REVOKED' || state === 'PAYERROR') return 'failed'
    return 'pending'
  }

  function mapWechatRefundStatus(status) {
    if (status === 'SUCCESS') return 'success'
    if (status === 'ABNORMAL' || status === 'CLOSED') return 'failed'
    return 'processing'
  }

  function validatePaymentCallbackPayload(payload, order, payment, config) {
    if (safeText(payload.mchid).trim() !== config.mchId) throw new Error('微信支付商户号不匹配')
    if (safeText(payload.appid).trim() !== config.appId) throw new Error('微信支付 AppID 不匹配')
    if (safeText(payload.out_trade_no).trim() !== payment.paymentNo) throw new Error('微信支付单号不匹配')
    if (payload.trade_state === 'SUCCESS' && !payload.transaction_id) throw new Error('微信交易号缺失')
    const paidFen = Number(payload.amount && payload.amount.total)
    if (paidFen !== amountYuanToFen(order.payAmount)) throw new Error('微信支付金额不匹配')
  }

  return {
    createPaymentNo,
    createRefundNo,
    normalizePem,
    randomNonce,
    amountYuanToFen,
    isProductionPaymentEnv,
    assertPaymentModeAllowed,
    getWechatPayConfig,
    getWechatTransferConfig,
    sanitizeWechatPayload,
    sanitizeWechatTransferPayload,
    encryptWechatTransferUserName,
    wechatPayRequest,
    buildMiniProgramPayParams,
    getHeader,
    verifyWechatPayCallback,
    decryptWechatPayResource,
    mapWechatTradeState,
    mapWechatRefundStatus,
    validatePaymentCallbackPayload
  }
}
