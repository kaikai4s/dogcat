// Only check newly entered text. Blank inputs keep the saved keys on the server.
// This checks PEM completeness, not whether the key matches the merchant certificate.
function paymentKeyInputIssue(payment = {}) {
  const fields = [
    ['privateKeyInput', ['PRIVATE KEY', 'RSA PRIVATE KEY'], '商户私钥格式不完整，请重新复制 apiclient_key.pem 的全部内容，包含 BEGIN 和 END 两行'],
    ['platformPublicKeyInput', ['PUBLIC KEY', 'RSA PUBLIC KEY', 'CERTIFICATE'], '平台公钥格式不完整，请复制微信支付平台公钥或平台证书的全部内容，包含 BEGIN 和 END 两行']
  ]
  for (const [field, labels, message] of fields) {
    const value = String(payment[field] || '').replace(/\\n/g, '\n').trim()
    if (!value) continue
    const complete = labels.some(label => {
      const pattern = new RegExp(`^-----BEGIN ${label}-----\\r?\\n([A-Za-z0-9+/=\\r\\n]+)\\r?\\n-----END ${label}-----$`)
      const match = value.match(pattern)
      if (!match) return false
      const body = match[1].replace(/[\r\n]/g, '')
      return body.length > 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body)
    })
    if (!complete) return message
  }
  return ''
}

module.exports = { paymentKeyInputIssue }
