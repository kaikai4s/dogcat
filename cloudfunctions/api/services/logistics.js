const { shipmentIdentity, sameShipment } = require('../utils/logisticsShipment')
const { readOptionalDocument } = require('../utils/documentPages')

module.exports = function createService({
  db,
  getSystemSettings,
  https,
  now,
  safeText
}) {
  const EXPRESS_COMPANIES = [
    { name: '顺丰速运', code: 'sf', queryCode: 'shunfeng', tel: '95338' },
    { name: '中通快递', code: 'zto', queryCode: 'zhongtong', tel: '95311' },
    { name: '圆通速递', code: 'yto', queryCode: 'yuantong', tel: '95554' },
    { name: '韵达快递', code: 'yd', queryCode: 'yunda', tel: '95546' },
    { name: '京东快递', code: 'jd', queryCode: 'jd', tel: '950616' },
    { name: '极兔速递', code: 'jt', queryCode: 'jtexpress', tel: '956025' },
    { name: '申通快递', code: 'sto', queryCode: 'shentong', tel: '95543' },
    { name: '中国邮政EMS', code: 'ems', queryCode: 'ems', tel: '11183' },
    { name: '德邦快递', code: 'dbl', queryCode: 'debangwuliu', tel: '95353' },
    { name: '跨越速运', code: 'ky', queryCode: 'kuayue', tel: '95324' },
    { name: '丹鸟物流', code: 'dn', queryCode: 'danniao', tel: '400-855-5566' }
  ]

  function listExpressCompanies() {
    return EXPRESS_COMPANIES
  }

  function normalizeExpressCompany(nameOrCode = '') {
    const raw = safeText(nameOrCode).trim().toLowerCase()
    if (!raw) return { name: '快递配送', code: 'other', queryCode: 'auto', tel: '' }
    const matched = EXPRESS_COMPANIES.find((item) => {
      const n = item.name.toLowerCase()
      const c = item.code.toLowerCase()
      const q = item.queryCode.toLowerCase()
      return n.includes(raw) || raw.includes(n) || c === raw || q === raw
    })
    return matched || { name: safeText(nameOrCode).trim() || '快递配送', code: 'other', queryCode: 'auto', tel: '' }
  }

  const companyNameKey = value => safeText(value).toLowerCase().replace(/中国|速运|速递|快递|物流|快运|\s/g, '')
  let juheCompanies = null
  let juheCompaniesExpires = 0
  let juheCompaniesKey = ''
  let juheCompaniesPending = null

  async function juheRequest(path, fields) {
    const postData = new URLSearchParams(fields).toString()
    const response = await requestHttps({ hostname: 'v.juhe.cn', path, method: 'POST', headers: {
      'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData)
    } }, postData)
    if (response.statusCode !== 200 || !response.data || Number(response.data.error_code) !== 0) throw new Error('物流查询暂不可用，请稍后重试')
    return response.data.result
  }

  async function juheCompanyCode(key, company, originalName) {
    const fingerprint = require('crypto').createHash('sha256').update(key).digest('hex')
    if (juheCompaniesKey !== fingerprint || juheCompaniesExpires <= Date.now()) {
      if (!juheCompaniesPending || juheCompaniesKey !== fingerprint) {
        juheCompaniesKey = fingerprint
        juheCompaniesPending = juheRequest('/exp/com', { key }).then(rows => {
          if (!Array.isArray(rows)) throw new Error('快递公司列表暂不可用')
          const valid = rows.filter(row => row && /^[a-zA-Z0-9_-]+$/.test(row.no || '') && row.com)
          if (!valid.length) throw new Error('快递公司列表暂不可用')
          juheCompanies = valid
          juheCompaniesExpires = Date.now() + 24 * 3600 * 1000
          return valid
        }).finally(() => { juheCompaniesPending = null })
      }
      await juheCompaniesPending
    }
    const names = new Set([companyNameKey(company.name), companyNameKey(originalName)])
    const raw = safeText(originalName).trim().toLowerCase()
    const row = juheCompanies.find(item => item.no.toLowerCase() === raw || names.has(companyNameKey(item.com)))
    if (!row) throw new Error('暂不支持该快递公司，请联系商家核对快递公司名称')
    return row.no
  }

  async function fetchJuheLogistics(key, company, order) {
    const com = await juheCompanyCode(key, company, order.expressCompany)
    const phone = safeText(order.shippingAddress && order.shippingAddress.contactPhone).replace(/\D/g, '')
    const receiverPhone = phone.length >= 4 ? phone.slice(-4) : ''
    if (['sf', 'zto', 'zt', 'ky', 'kyexpress'].includes(com.toLowerCase()) && !receiverPhone) throw new Error('该快递查询需要收件手机号后四位，请联系商家核对收货信息')
    const fields = { key, com, no: order.trackingNo, dtype: 'json' }
    if (receiverPhone) fields.receiverPhone = receiverPhone
    const result = await juheRequest('/exp/index', fields)
    if (!result || !Array.isArray(result.list)) throw new Error('暂未查询到物流轨迹，请稍后再试')
    if (result.no && String(result.no) !== String(order.trackingNo)) throw new Error('物流查询结果与当前运单不一致')
    const states = {
      PENDING: ['pending', '待查询'], NO_RECORD: ['pending', '暂无轨迹'], ERROR: ['error', '查询异常'],
      IN_TRANSIT: ['in_transit', '运输中'], DELIVERING: ['delivering', '派送中'], SIGNED: ['delivered', '已签收'],
      REJECTED: ['rejected', '拒签'], PROBLEM: ['problem', '疑难件'], INVALID: ['invalid', '无效件'],
      TIMEOUT: ['timeout', '超时件'], FAILED: ['failed', '派送失败'], SEND_BACK: ['returned', '退回'], TAKING: ['picked_up', '已揽收']
    }
    const [statusCode, stateText] = states[result.status_detail] || ['unknown', '状态待更新']
    const traces = result.list.filter(item => item && item.remark).map(item => ({
      time: safeText(item.datetime), context: safeText(item.remark), status: 'in_transit', statusText: '物流动态'
    })).sort((a, b) => String(b.time).localeCompare(String(a.time)))
    if (traces.length) Object.assign(traces[0], { status: statusCode, statusText: stateText })
    // Juhe status=1 only means the record is final; rejected/returned shipments are not signed deliveries.
    return { expressCompany: safeText(result.company) || company.name, companyCode: company.code, companyTel: company.tel,
      trackingNo: order.trackingNo, shippedAt: order.shippedAt || null, statusCode, stateText,
      isDelivered: result.status_detail === 'SIGNED', isFinal: String(result.status) === '1', traces,
      isSimulated: false, provider: 'juhe', message: traces.length ? '' : '暂未查询到物流轨迹，请稍后再试' }
  }

  async function queryOrderLogistics(order) {
    if (!order) throw new Error('订单不存在')
    if (!order.trackingNo) return { hasLogistics: false, message: '订单尚未发货，暂无物流信息' }
    const company = normalizeExpressCompany(order.expressCompany)
    const settings = typeof getSystemSettings === 'function' ? await getSystemSettings({ includeSecrets: true }) : {}
    const config = settings.logistics || {}
    const provider = config.provider || 'juhe'
    const base = { hasLogistics: true, expressCompany: company.name, companyCode: company.code, companyTel: company.tel,
      trackingNo: order.trackingNo, statusCode: 'pending', stateText: '暂无轨迹', isDelivered: false, traces: [], isSimulated: false, provider }
    if (config.enabled === false) return { ...base, message: '物流查询暂未开启，请稍后再试' }
    // Never reuse simulated records or records belonging to a previous carrier/tracking number.
    const cache = order.logisticsCache
    if (cache && cache.isSimulated === false && cache.provider === provider && cache.trackingNo === order.trackingNo && cache.companyCode === company.code && sameShipment(order, cache.shipment)) {
      const age = new Date(now()).getTime() - new Date(cache.updatedAt || 0).getTime()
      if (age >= 0 && (age < 30 * 60 * 1000 || cache.isDelivered)) return { ...base, ...cache }
    }
    let result
    try {
      if (provider === 'juhe') {
        const key = safeText(config.juheKey || process.env.JUHE_EXP_KEY).trim()
        if (!key) return { ...base, message: '物流查询暂未配置，请联系商家' }
        result = await fetchJuheLogistics(key, company, order)
      } else if (provider === 'aliyun') {
        const appCode = safeText(config.appCode || process.env.ALIYUN_LOGISTICS_APPCODE).trim()
        if (appCode) result = await fetchAliyunLogistics(appCode, order.trackingNo, company, order)
      } else if (provider === 'kuaidi100') {
        const key = safeText(config.key || process.env.KUAIDI100_KEY).trim()
        const customer = safeText(config.customer || process.env.KUAIDI100_CUSTOMER).trim()
        if (key && customer) result = await fetchKuaidi100Logistics(customer, key, order.trackingNo, company, order)
      }
    } catch (_) {
      return { ...base, message: '暂未获取到物流信息，请核对快递公司、运单和收件手机号后稍后重试' }
    }
    if (!result) return { ...base, message: '暂未获取到物流信息，请稍后重试' }
    if (result.traces.length) {
      const cached = await db.runTransaction(async tx => {
        const latest = await readOptionalDocument(tx, 'mall_orders', order._id)
        if (!sameShipment(latest, order)) return false
        await tx.collection('mall_orders').doc(order._id).update({ data: {
          logisticsCache: { ...result, shipment: shipmentIdentity(order), updatedAt: now() }
        } })
        return true
      }).catch(() => null)
      if (cached === false) return { ...base, message: '发货信息已更新，请重新查询物流' }
    }
    return { ...base, ...result }
  }

  function requestHttps(options, postData = null, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      if (!https || typeof https.request !== 'function') {
        return reject(new Error('https module unavailable'))
      }
      const req = https.request({ ...options, timeout: timeoutMs }, (res) => {
        if (typeof res.setEncoding === 'function') res.setEncoding('utf8')
        let body = ''
        let bytes = 0
        res.on('error', () => reject(new Error('物流接口响应异常')))
        res.on('aborted', () => reject(new Error('物流接口响应中断')))
        res.on('data', chunk => {
          bytes += Buffer.byteLength(chunk)
          if (bytes > 1024 * 1024) { req.destroy(); reject(new Error('物流接口响应过大')); return }
          body += chunk
        })
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, data: JSON.parse(body) })
          } catch (e) {
            resolve({ statusCode: res.statusCode, raw: body })
          }
        })
      })
      req.on('timeout', () => { req.destroy(); reject(new Error('物流接口请求超时')) })
      req.on('error', err => reject(err))
      if (postData) req.write(postData)
      req.end()
    })
  }

  async function fetchAliyunLogistics(appCode, trackingNo, company, order) {
    try {
      const type = company.queryCode && company.queryCode !== 'auto' ? company.queryCode : ''
      const path = `/kdi?no=${encodeURIComponent(trackingNo)}${type ? `&type=${encodeURIComponent(type)}` : ''}`
      const res = await requestHttps({
        hostname: 'wuliu.market.alicloudapi.com',
        path,
        method: 'GET',
        headers: {
          Authorization: `APPCODE ${appCode}`
        }
      })
      const payload = res.data
      if (payload && (payload.status === '0' || payload.code === 'OK' || payload.success === true) && payload.result) {
        const r = payload.result
        const rawList = r.list || []
        const traces = rawList.map((item, idx) => ({
          time: item.time || '',
          context: item.status || item.context || '',
          status: idx === 0 && (r.deliverystatus === '3' || r.issign === '1') ? 'delivered' : 'in_transit',
          statusText: idx === 0 && (r.deliverystatus === '3' || r.issign === '1') ? '已签收' : '运输中'
        }))
        const isDelivered = r.deliverystatus === '3' || r.issign === '1'
        return {
          expressCompany: r.expName || company.name,
          companyCode: company.code,
          companyTel: r.expPhone || company.tel,
          trackingNo,
          shippedAt: order.shippedAt || null,
          statusCode: isDelivered ? 'delivered' : 'in_transit',
          stateText: isDelivered ? '已签收' : '运输中',
          isDelivered,
          traces,
          isSimulated: false,
          provider: 'aliyun'
        }
      }
    } catch (e) {
      console.warn('[logistics] Aliyun API query failed')
    }
    return null
  }

  async function fetchKuaidi100Logistics(customer, key, trackingNo, company, order) {
    try {
      const crypto = require('crypto')
      const com = company.queryCode || 'auto'
      const param = JSON.stringify({ com, num: trackingNo })
      const sign = crypto.createHash('md5').update(`${param}${key}${customer}`).digest('hex').toUpperCase()
      const postData = `customer=${encodeURIComponent(customer)}&sign=${encodeURIComponent(sign)}&param=${encodeURIComponent(param)}`
      const res = await requestHttps({
        hostname: 'poll.kuaidi100.com',
        path: '/poll/query.do',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, postData)
      const r = res.data
      if (r && Array.isArray(r.data) && r.data.length) {
        const traces = r.data.map((item, idx) => ({
          time: item.time || item.ftime || '',
          context: item.context || '',
          status: idx === 0 && r.state === '3' ? 'delivered' : 'in_transit',
          statusText: idx === 0 && r.state === '3' ? '已签收' : '运输中'
        }))
        const isDelivered = r.state === '3'
        return {
          expressCompany: company.name,
          companyCode: company.code,
          companyTel: company.tel,
          trackingNo,
          shippedAt: order.shippedAt || null,
          statusCode: isDelivered ? 'delivered' : 'in_transit',
          stateText: isDelivered ? '已签收' : '运输中',
          isDelivered,
          traces,
          isSimulated: false,
          provider: 'kuaidi100'
        }
      }
    } catch (e) {
      console.warn('[logistics] Kuaidi100 API query failed')
    }
    return null
  }

  return {
    EXPRESS_COMPANIES,
    listExpressCompanies,
    normalizeExpressCompany,
    queryOrderLogistics
  }
}
