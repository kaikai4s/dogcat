function detectRiskContactBypass(text) {
  if (!text || typeof text !== 'string') return { isRisk: false }
  const clean = text.toLowerCase().replace(/[\s\-_,，.。:：;；/\\*#@!！?？~`]/g, '')

  // 1. 手机号/电话号码模式检测 (11位大陆手机号，或常见座机)
  const phoneRegex = /(?:1[3-9]\d{9})|(?:0\d{2,3}\d{7,8})/
  if (phoneRegex.test(clean)) {
    return { isRisk: true, reason: '包含电话/手机号码', keyword: 'phone_number' }
  }

  // 2. 中文数字转写手机号检测 (如 一三八...)
  const cnDigits = {
    '零': '0', '一': '1', '二': '2', '两': '2', '三': '3', '四': '4',
    '五': '5', '六': '6', '七': '7', '八': '8', '九': '9',
    '壹': '1', '贰': '2', '叁': '3', '肆': '4', '伍': '5',
    '陆': '6', '柒': '7', '捌': '8', '玖': '9'
  }
  let cnConverted = ''
  for (const ch of clean) {
    cnConverted += cnDigits[ch] !== undefined ? cnDigits[ch] : ch
  }
  if (phoneRegex.test(cnConverted)) {
    return { isRisk: true, reason: '包含中文数字电话号码', keyword: 'cn_phone_number' }
  }

  // 3. 社交账号引流/跳单敏感词检测
  const bypassKeywords = [
    '微信', '微信号', '加微', '加v', '加我v', '发我v', '留个v', '私聊', '私下',
    'vx', 'wx', 'weixin', 'wechat', 'qq', '企鹅号', '手机号', '电话号', '电话号码',
    '联系电话', '留电话', '打我电话', '加我电话', '转账', '支付宝', '私下转',
    '走线下', '不走平台', '绕过平台', '便宜点私下', '现金交易'
  ]

  for (const kw of bypassKeywords) {
    if (clean.includes(kw)) {
      return { isRisk: true, reason: `包含疑似导流词汇（${kw}）`, keyword: kw }
    }
  }

  return { isRisk: false }
}

module.exports = {
  detectRiskContactBypass
}
