module.exports = function createService({
  crypto,
  https,
  safeText
}) {
  function createPaymentNo() {
    return `P${Date.now()}${Math.floor(Math.random() * 1000)}`
  }

  function createRefundNo() {
    return `R${Date.now()}${Math.floor(Math.random() * 1000)}`
  }

  function normalizePem(value) {
    return safeText(value).trim().replace(/\\n/g, '\n')
  }

  function randomNonce(length = 32) {
    return crypto.randomBytes(length).toString('hex').slice(0, length)
  }

  function amountYuanToFen(amount) {
    const normalized = Math.round(Number(amount || 0) * 100)
    if (!Number.isFinite(normalized) || normalized <= 0) throw new Error('支付金额不正确')
    return normalized
  }

  function isProductionPaymentEnv() {
    return process.env.NODE_ENV === 'production' || process.env.PAYMENT_ENV === 'production'
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
      refundEnabled: payment.refundEnabled !== false
    }
    if (!config.appId || !config.mchId || !config.notifyUrl || !config.certSerialNo || !config.apiV3Key || !config.privateKey) throw new Error('微信支付配置未完成')
    if (!/^https:\/\//i.test(config.notifyUrl)) throw new Error('微信支付回调地址必须是 HTTPS')
    return config
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

  function wechatPayRequest(method, path, body, config) {
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
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyText)
        }
      }, (res) => {
        let raw = ''
        res.on('data', (chunk) => { raw += chunk })
        res.on('end', () => {
          let json = {}
          try { json = raw ? JSON.parse(raw) : {} } catch (error) { return reject(new Error('微信支付响应解析失败')) }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json)
          reject(new Error(json.message || json.code || '微信支付请求失败'))
        })
      })
      req.on('error', reject)
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
    sanitizeWechatPayload,
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
