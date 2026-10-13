const https = require('https')
const querystring = require('querystring')

/**
 * 验证 18 位中华人民共和国居民身份证号（GB 11643-1999 校验码算法）
 */
function isValidIdCard(idCard) {
  if (!idCard || typeof idCard !== 'string') return false
  const id = idCard.trim().toUpperCase()
  if (!/^\d{17}[\dX]$/.test(id)) return false

  const year = parseInt(id.substring(6, 10), 10)
  const month = parseInt(id.substring(10, 12), 10)
  const day = parseInt(id.substring(12, 14), 10)
  const currentYear = new Date().getFullYear()

  if (year < 1900 || year > currentYear) return false
  if (month < 1 || month > 12) return false
  const maxDays = new Date(year, month, 0).getDate()
  if (day < 1 || day > maxDays) return false

  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  const checkCodes = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']

  let sum = 0
  for (let i = 0; i < 17; i++) {
    sum += parseInt(id[i], 10) * weights[i]
  }
  const expectedCheckCode = checkCodes[sum % 11]
  return id[17] === expectedCheckCode
}

/**
 * 身份证脱敏：前 6 位 + 8 个星号 + 后 4 位
 */
function maskIdCard(idCard) {
  if (!idCard || typeof idCard !== 'string') return ''
  const trimmed = idCard.trim().toUpperCase()
  if (trimmed.length === 18) {
    return trimmed.substring(0, 6) + '********' + trimmed.substring(14)
  }
  return trimmed
}

/**
 * 验证中文真实姓名（2-20 位汉字，支持少数民族点符 ·）
 */
function isValidRealName(name) {
  if (!name || typeof name !== 'string') return false
  const trimmed = name.trim()
  return /^[\u4e00-\u9fa5·]{2,20}$/.test(trimmed)
}

/**
 * 验证大陆手机号（11 位数字）
 */
function isValidMobile(mobile) {
  if (!mobile || typeof mobile !== 'string') return false
  return /^1[3-9]\d{9}$/.test(mobile.trim())
}

module.exports = function createRealNameVerificationService(context = {}) {
  const { now, safeText } = context

  /**
   * 发送 HTTP 请求到聚合数据
   */
  function requestJuheApi(url, postData, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url)
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: timeoutMs
      }

      const req = https.request(options, (res) => {
        let responseBody = ''
        res.on('data', (chunk) => {
          responseBody += chunk
        })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(responseBody)
            resolve(parsed)
          } catch (err) {
            reject(new Error(`聚合数据实名接口返回格式异常: ${responseBody}`))
          }
        })
      })

      req.on('timeout', () => {
        req.destroy()
        reject(new Error('聚合数据实名核验接口请求超时'))
      })

      req.on('error', (err) => {
        reject(new Error(`聚合数据实名接口网络连接失败: ${err.message}`))
      })

      req.write(postData)
      req.end()
    })
  }

  /**
   * 运营商三要素（姓名、身份证、手机号）核验
   *
   * @param {Object} params
   * @param {string} params.realname 真实姓名
   * @param {string} params.idcard 身份证号码
   * @param {string} params.mobile 手机号码
   * @param {string} [params.apiKey] 聚合数据 AppKey
   * @param {boolean} [params.mock] 是否强制 Mock 模式
   */
  async function verifyTelecomThreeElements({ realname, idcard, mobile, apiKey, mock }) {
    const cleanName = safeText ? safeText(realname).trim() : String(realname || '').trim()
    const cleanId = String(idcard || '').trim().toUpperCase()
    const cleanPhone = String(mobile || '').trim()

    if (!isValidRealName(cleanName)) {
      throw new Error('真实姓名格式不正确（须为2-20位中文字符）')
    }
    if (!isValidIdCard(cleanId)) {
      throw new Error('身份证号码格式不正确，请输入有效的18位居民身份证号码')
    }
    if (!isValidMobile(cleanPhone)) {
      throw new Error('手机号码格式不正确，请输入有效的11位中国大陆手机号码')
    }

    const key = apiKey || process.env.JUHE_TELECOM_KEY || ''
    const isMock = mock === true || !key || key === 'MOCK' || key === 'TEST'

    if (isMock) {
      // Mock 测试模式：特定测试关键字模拟不同返回
      if (cleanId.includes('000000') || cleanPhone.endsWith('0000')) {
        return {
          success: false,
          verified: false,
          resCode: '21',
          message: '三要素核验不一致：姓名与手机号实名信息不匹配',
          isMock: true,
          verifiedAt: now ? now() : new Date().toISOString()
        }
      }
      return {
        success: true,
        verified: true,
        resCode: '11',
        message: '三要素身份验证一致',
        isMock: true,
        verifiedAt: now ? now() : new Date().toISOString(),
        orderId: `MOCK_${Date.now()}`
      }
    }

    const postData = querystring.stringify({
      key,
      realname: cleanName,
      idcard: cleanId,
      mobile: cleanPhone,
      detail: 1,
      showid: 1
    })

    const response = await requestJuheApi('https://v.juhe.cn/telecom/query', postData)

    if (response.error_code === 0) {
      const resData = response.result || {}
      if (resData.res === 1) {
        return {
          success: true,
          verified: true,
          resCode: String(resData.rescode || '11'),
          message: resData.resmsg || '三要素身份验证一致',
          orderId: resData.orderid || '',
          operatorType: resData.type || '',
          province: resData.province || '',
          city: resData.city || '',
          verifiedAt: now ? now() : new Date().toISOString()
        }
      }

      // res === 2 不一致，解析细分原因
      const resCode = String(resData.rescode || '24')
      let message = resData.resmsg || '三要素身份验证不一致'
      if (resCode === '21') {
        message = '姓名与手机号实名登记不一致'
      } else if (resCode === '22') {
        message = '身份证号码与手机号实名登记不一致'
      } else if (resCode === '23') {
        message = '姓名与身份证号码均与手机号实名登记不一致'
      } else if (resCode === '24') {
        message = '三要素核验不一致，请确认手机号是否为本人身份证实名办理'
      }

      return {
        success: false,
        verified: false,
        resCode,
        message,
        orderId: resData.orderid || '',
        verifiedAt: now ? now() : new Date().toISOString()
      }
    }

    // 错误码统一转换
    if (response.error_code === 220803) {
      return {
        success: false,
        verified: false,
        resCode: 'NOT_FOUND',
        message: '运营商查询无此记录，请核对手机号与身份证信息'
      }
    }
    if (response.error_code === 220807) {
      return {
        success: false,
        verified: false,
        resCode: 'INVALID_PARAM',
        message: response.reason || '实名参数错误，请检查姓名或证件号'
      }
    }
    if (response.error_code === 10012) {
      throw new Error('实名核验接口调用次数已超限，请联系平台管理员续费')
    }

    throw new Error(response.reason || `实名核验服务异常(错误码:${response.error_code})`)
  }

  return {
    isValidIdCard,
    maskIdCard,
    isValidRealName,
    isValidMobile,
    verifyTelecomThreeElements
  }
}
