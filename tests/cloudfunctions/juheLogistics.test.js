const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const createLogistics = require('../../cloudfunctions/api/services/logistics')
const createMallCatalog = require('../../cloudfunctions/api/services/mallCatalog')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const KEY = 'TEST_JUHE_KEY_1234567890'
const carriers = [{ com: '顺丰', no: 'sf' }, { com: '中通', no: 'zto' }, { com: '圆通', no: 'yt' }, { com: '跨越', no: 'ky' }]
const order = patch => ({ _id: 'o', clientOpenid: 'user', status: 'shipped', expressCompany: '顺丰速运', trackingNo: 'SF1234567890',
  shippedAt: '2026-10-23T01:00:00Z', shippingAddress: { contactPhone: '13812340007' }, ...patch })
function setup({ detail = 'IN_TRANSIT', final = '0', failure, orders, enabled = true, resultPatch = {}, beforeResponse } = {}) {
  const db = createCollectionStore({ mall_orders: orders || [order()] })
  const requests = []
  const https = { request(options, callback) {
    const req = new EventEmitter()
    let body = ''
    req.write = text => { body += text }
    req.destroy = () => {}
    req.end = () => queueMicrotask(() => {
      requests.push({ options, params: new URLSearchParams(body) })
      if (failure === 'network') { req.emit('error', new Error('network error containing ' + KEY)); return }
      if (failure === 'timeout') { req.emit('timeout'); return }
      const res = new EventEmitter()
      res.statusCode = failure === 'http' ? 502 : 200
      callback(res)
      if (beforeResponse && options.path === '/exp/index') beforeResponse(db)
      const payload = options.path === '/exp/com' ? { error_code: 0, result: carriers } : {
        error_code: failure === 'provider' ? 20404 : 0, reason: failure ? KEY : 'success',
        result: { no: 'SF1234567890', company: '顺丰', status: final, status_detail: detail, list: [
          { datetime: '2026-10-23 08:00:00', remark: '已揽收' }, { datetime: '2026-10-23 10:00:00', remark: '运输中' }
        ], ...resultPatch }
      }
      res.emit('data', failure === 'json' ? 'not json' : JSON.stringify(payload))
      res.emit('end')
    })
    return req
  } }
  const config = { enabled, provider: 'juhe', juheKey: KEY }
  const logistics = createLogistics({ db, https, getSystemSettings: async options => {
    assert.equal(options.includeSecrets, true)
    return { logistics: config }
  }, now: () => new Date('2026-10-23T12:00:00Z'), safeText: s => String(s || '') })
  return { db, logistics, requests, config }
}

test('Juhe posts official carrier code, tracking number and only the last four phone digits; latest event appears first', async () => {
  const { db, logistics, requests } = setup()
  const result = await logistics.queryOrderLogistics(order())
  assert.equal(requests.length, 2)
  assert.equal(requests[0].options.path, '/exp/com')
  const request = requests[1]
  assert.equal(request.options.hostname, 'v.juhe.cn')
  assert.equal(request.options.method, 'POST')
  assert.equal(request.options.path, '/exp/index')
  assert.equal(request.options.headers['Content-Type'], 'application/x-www-form-urlencoded')
  assert.equal(request.params.get('com'), 'sf')
  assert.equal(request.params.get('no'), 'SF1234567890')
  assert.equal(request.params.get('key'), KEY)
  assert.equal(request.params.get('receiverPhone'), '0007')
  assert.equal(request.params.get('dtype'), 'json')
  assert.ok(!request.params.toString().includes('13812340007'))
  assert.equal(result.provider, 'juhe')
  assert.equal(result.traces[0].time, '2026-10-23 10:00:00')
  assert.equal(result.isDelivered, false)
  assert.equal(result.stateText, '运输中')
  assert.ok(!JSON.stringify(result).includes(KEY))
  assert.ok(!JSON.stringify(db.state.mall_orders[0].logisticsCache).includes(KEY))
  await logistics.queryOrderLogistics(db.state.mall_orders[0])
  assert.equal(requests.length, 2)
})

for (const detail of ['SIGNED', 'REJECTED', 'SEND_BACK', 'FAILED', null]) {
  test(`Juhe final status ${detail} marks delivered only for SIGNED`, async () => {
    const { logistics } = setup({ detail, final: '1' })
    const result = await logistics.queryOrderLogistics(order({ status: 'completed' }))
    assert.equal(result.isDelivered, detail === 'SIGNED')
    assert.equal(result.isFinal, true)
    if (detail !== 'SIGNED') assert.notEqual(result.statusCode, 'delivered')
  })
}

for (const failure of ['network', 'timeout', 'http', 'provider', 'json']) {
  test(`Juhe ${failure} failure does not publish fake events, secrets or delivered status`, async () => {
    const { logistics, db } = setup({ failure })
    const result = await logistics.queryOrderLogistics(order({ status: 'completed' }))
    assert.equal(result.isDelivered, false)
    assert.deepEqual(result.traces, [])
    assert.ok(result.message)
    assert.ok(!JSON.stringify(result).includes(KEY))
    assert.equal(db.state.mall_orders[0].logisticsCache, undefined)
  })
}

test('missing or disabled credentials and unsupported carriers do not invent tracking updates', async () => {
  const { logistics, config, requests } = setup()
  config.juheKey = ''
  const missing = await logistics.queryOrderLogistics(order())
  assert.match(missing.message, /未配置/)
  assert.equal(requests.length, 0)
  config.juheKey = KEY
  config.enabled = false
  assert.match((await logistics.queryOrderLogistics(order())).message, /未开启/)
  assert.equal(requests.length, 0)
  config.enabled = true
  const unsupported = await logistics.queryOrderLogistics(order({ expressCompany: '不存在的快递' }))
  assert.equal(unsupported.traces.length, 0)
  assert.equal(requests.length, 1)
})

test('carrier code comes from the provider directory instead of another providers code map', async () => {
  const { logistics, requests } = setup()
  await logistics.queryOrderLogistics(order({ expressCompany: '圆通速递' }))
  assert.equal(requests[1].params.get('com'), 'yt')
  await logistics.queryOrderLogistics(order({ expressCompany: '中通快递' }))
  assert.equal(requests[2].params.get('com'), 'zto')
  assert.equal(requests.filter(r => r.options.path === '/exp/com').length, 1)
})

test('required phone suffix is checked before querying sensitive carriers; empty and mismatched responses stay pending', async () => {
  const { logistics, requests } = setup()
  const result = await logistics.queryOrderLogistics(order({ shippingAddress: {} }))
  assert.equal(result.isDelivered, false)
  assert.equal(requests.filter(r => r.options.path === '/exp/index').length, 0)
  for (const resultPatch of [{ list: [] }, { no: 'OTHER' }]) {
    const fixture = setup({ resultPatch })
    const result = await fixture.logistics.queryOrderLogistics(order())
    assert.equal(result.isDelivered, false)
    assert.equal(result.traces.length, 0)
  }
})

test('old simulated caches and previous tracking numbers cannot bypass the live query', async () => {
  for (const patch of [{ isSimulated: true }, { trackingNo: 'OLD' }, { provider: 'aliyun' }]) {
    const { logistics, requests } = setup()
    const cache = { provider: 'juhe', companyCode: 'sf', trackingNo: 'SF1234567890', isSimulated: false, isDelivered: true,
      traces: [{ time: '2026-10-23', context: 'stale signed event' }], updatedAt: '2026-10-23T11:59:00Z', ...patch }
    const result = await logistics.queryOrderLogistics(order({ logisticsCache: cache }))
    assert.equal(requests.length, 2)
    assert.equal(result.isDelivered, false)
  }
})

test('the mall scheduler ignores old simulated signed-delivery records', async () => {
  const db = createCollectionStore({ mall_orders: [order({ logisticsCache: { isDelivered: true, isSimulated: true } })] })
  const service = createMallCatalog({ db, now: () => new Date('2026-10-23T12:00:00Z') })
  assert.deepEqual(await service.autoCompleteDeliveredMallOrders(), [])
  assert.equal(db.state.mall_orders[0].status, 'shipped')
})

const makeApi = (db, openid) => loadCloudFunction('api', db, openid)
test('admin saves a Juhe key, blank input retains it, and public settings/audit logs never expose it', async () => {
  const db = createCollectionStore({ users: [{ _id: 'a', openid: 'admin', roles: ['admin'], status: 'active' }] })
  const api = makeApi(db, 'admin')
  const save = settings => api.main({ module: 'admin', action: 'saveSystemSettings', data: { logistics: settings } })
  const saved = await save({ provider: 'juhe', enabled: true, juheKeyInput: KEY })
  assert.equal(saved.ok, true, saved.message)
  assert.equal(saved.data.logistics.juheKeyConfigured, true)
  assert.ok(!JSON.stringify(saved.data).includes(KEY))
  assert.equal(db.state.platform_configs.find(r => r.key === 'system_settings').value.logistics.juheKey, KEY)
  assert.equal((await save({ provider: 'juhe', juheKeyInput: '' })).ok, true)
  assert.equal(db.state.platform_configs.find(r => r.key === 'system_settings').value.logistics.juheKey, KEY)
  const settings = await api.main({ module: 'admin', action: 'getSystemSettings', data: {} })
  assert.equal(settings.ok, true, settings.message)
  assert.ok(!JSON.stringify(settings).includes(KEY))
  const publicSettings = await api.main({ module: 'system', action: 'getSettings', data: {} })
  assert.equal(publicSettings.ok, true, publicSettings.message)
  assert.ok(!JSON.stringify(publicSettings).includes(KEY))
  assert.ok(!JSON.stringify(db.state.admin_operation_logs || []).includes(KEY))
})

test('ordinary clients cannot save logistics credentials', async () => {
  const db = createCollectionStore({ users: [{ _id: 'u', openid: 'user', roles: ['client'], status: 'active' }] })
  const result = await makeApi(db, 'user').main({ module: 'admin', action: 'saveSystemSettings', data: { logistics: { juheKeyInput: KEY, provider: 'juhe' } } })
  assert.equal(result.ok, false)
  assert.ok(!(db.state.platform_configs || []).some(r => r.key === 'system_settings'))
})

for (const refundStatus of ['none', 'applied', 'return_shipped']) {
  test(`verified signed logistics ${refundStatus === 'none' ? 'complete the shipment' : 'preserve active refunds: ' + refundStatus}`, async () => {
    const db = createCollectionStore({ mall_orders: [order({ refundStatus })] })
    const handler = require('../../cloudfunctions/api/handlers/mall')({ db, checkLogisticsQueryRateLimit: async () => {}, getUser: async () => ({}),
      getDocOrNull: async () => structuredClone(db.state.mall_orders[0]),
      queryOrderLogistics: async () => ({ hasLogistics: true, isDelivered: true, isSimulated: false }), now: () => new Date() })
    const result = await handler('user', 'queryOrderLogistics', { orderId: 'o' })
    assert.equal(db.state.mall_orders[0].status, refundStatus === 'none' ? 'completed' : 'shipped')
    assert.equal(result.orderStatusUpdated, refundStatus === 'none' ? 'completed' : undefined)
  })
}

test('a newly applied refund during the provider request prevents automatic receipt', async () => {
  const db = createCollectionStore({ mall_orders: [order({ refundStatus: 'none' })] })
  const handler = require('../../cloudfunctions/api/handlers/mall')({ db, checkLogisticsQueryRateLimit: async () => {}, getUser: async () => ({}),
    getDocOrNull: async () => structuredClone(db.state.mall_orders[0]), now: () => new Date(),
    queryOrderLogistics: async () => {
      db.state.mall_orders[0].refundStatus = 'applied'
      return { hasLogistics: true, isDelivered: true, isSimulated: false }
    } })
  const result = await handler('user', 'queryOrderLogistics', { orderId: 'o' })
  assert.equal(result.orderStatusUpdated, undefined)
  assert.equal(db.state.mall_orders[0].status, 'shipped')
})

test('delegated admins cannot replace logistics credentials through the global settings API', async () => {
  const db = createCollectionStore({ users: [{ _id: 'a', openid: 'admin', roles: ['admin'], status: 'active' }],
    admin_access_config: [{ _id: 'policy', enabled: true, ownerOpenid: 'owner' }],
    admin_groups: [{ _id: 'g', enabled: true, permissions: ['admin.getSystemSettings'] }],
    admin_memberships: [{ _id: 'a', groupIds: ['g'] }] })
  const result = await makeApi(db, 'admin').main({ module: 'admin', action: 'saveSystemSettings', data: { logistics: { provider: 'juhe', juheKeyInput: KEY } } })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ADMIN_FORBIDDEN')
})

test('admin logistics query cannot bypass a refund opened while requesting the provider', async () => {
  const db = createCollectionStore({ mall_orders: [order({ refundStatus: 'none' })] })
  const handler = require('../../cloudfunctions/api/handlers/adminMall')({ db, checkLogisticsQueryRateLimit: async () => {}, requireAdmin: async () => ({}),
    getDocOrNull: async () => structuredClone(db.state.mall_orders[0]), now: () => new Date(),
    queryOrderLogistics: async () => {
      db.state.mall_orders[0].refundStatus = 'applied'
      return { hasLogistics: true, isDelivered: true, isSimulated: false }
    } })
  const result = await handler('admin', 'queryOrderLogistics', { orderId: 'o' })
  assert.equal(result.orderStatusUpdated, undefined)
  assert.equal(db.state.mall_orders[0].status, 'shipped')
})

const { shipmentIdentity } = require('../../cloudfunctions/api/utils/logisticsShipment')
test('reshipping clears old delivery evidence and stays shipped until the new shipment is delivered', async () => {
  const oldOrder = order({ status: 'completed', paymentStatus: 'paid', refundStatus: 'none', shippedAt: '2026-10-01T00:00:00Z', receivedAt: '2026-10-02T00:00:00Z', autoDeliveredByLogistics: true })
  oldOrder.logisticsCache = { provider: 'juhe', companyCode: 'sf', trackingNo: oldOrder.trackingNo,
    isSimulated: false, isDelivered: true, shipment: shipmentIdentity(oldOrder), traces: [{ time: '2026-10-02', context: '旧快件已签收' }] }
  const db = createCollectionStore({ users: [{ _id: 'a', openid: 'admin', roles: ['admin'], status: 'active' }], mall_orders: [oldOrder] })
  const api = makeApi(db, 'admin')
  const call = (action, data) => api.main({ module: 'adminMall', action, data })
  const reset = await call('updateOrderStatus', { orderId: 'o', status: 'pending_ship', remark: '补发商品' })
  assert.equal(reset.ok, true, reset.message)
  const ship = await call('shipOrder', { orderId: 'o', expressCompany: '中通快递', trackingNo: 'NEW-TRACK' })
  assert.equal(ship.ok, true, ship.message)
  assert.equal(db.state.mall_orders[0].logisticsCache, null)
  assert.equal(db.state.mall_orders[0].receivedAt, null)
  assert.equal(db.state.mall_orders[0].autoDeliveredByLogistics, false)
  assert.equal(db.state.mall_orders[0].autoDeliveredByTimeout, false)
  const service = createMallCatalog({ db, now: () => new Date() })
  assert.deepEqual(await service.autoCompleteDeliveredMallOrders(), [])
  assert.equal(db.state.mall_orders[0].status, 'shipped')
})

for (const mismatch of ['trackingNo', 'expressCompany', 'shippedAt', 'missingIdentity']) {
  test(`scheduler rejects cached delivery evidence from a different shipping event: ${mismatch}`, async () => {
    const latest = order()
    const snapshot = shipmentIdentity(latest)
    if (mismatch === 'trackingNo') snapshot.trackingNo = 'OLD-TRACK'
    if (mismatch === 'expressCompany') snapshot.expressCompany = '中通快递'
    if (mismatch === 'shippedAt') snapshot.shippedAt -= 86400000
    latest.logisticsCache = { isSimulated: false, isDelivered: true, ...(mismatch === 'missingIdentity' ? {} : { shipment: snapshot }) }
    const db = createCollectionStore({ mall_orders: [latest] })
    const service = createMallCatalog({ db, now: () => new Date('2026-10-23T12:00:00Z') })
    assert.deepEqual(await service.autoCompleteDeliveredMallOrders(), [])
    assert.equal(db.state.mall_orders[0].status, 'shipped')
    // Existing timeout receipt remains effective independently of cached delivery evidence.
    db.state.mall_orders[0].shippedAt = '2026-10-01T00:00:00Z'
    assert.deepEqual(await service.autoCompleteDeliveredMallOrders(), ['o'])
    assert.equal(db.state.mall_orders[0].autoDeliveredByTimeout, true)
    assert.equal(db.state.mall_orders[0].autoDeliveredByLogistics, false)
  })
}

test('matching verified delivery evidence still completes the current shipment', async () => {
  const latest = order()
  latest.logisticsCache = { isSimulated: false, isDelivered: true, shipment: shipmentIdentity(latest) }
  const db = createCollectionStore({ mall_orders: [latest] })
  const service = createMallCatalog({ db, now: () => new Date('2026-10-23T12:00:00Z') })
  assert.deepEqual(await service.autoCompleteDeliveredMallOrders(), ['o'])
  assert.equal(db.state.mall_orders[0].autoDeliveredByLogistics, true)
  assert.equal(db.state.mall_orders[0].autoDeliveredByTimeout, false)
})

test('a late response to an old query cannot overwrite new shipment cache, even when tracking number is reused', async () => {
  const newCache = { marker: 'new-shipment-query' }
  const { logistics, db } = setup({ detail: 'SIGNED', beforeResponse(db) {
    db.state.mall_orders[0].shippedAt = '2026-10-23T11:00:00Z'
    db.state.mall_orders[0].logisticsCache = newCache
  } })
  const snapshot = structuredClone(db.state.mall_orders[0])
  const result = await logistics.queryOrderLogistics(snapshot)
  assert.equal(result.isDelivered, false)
  assert.match(result.message, /发货信息已更新/)
  assert.deepEqual(db.state.mall_orders[0].logisticsCache, newCache)
})

for (const module of ['mall', 'adminMall']) {
  test(`${module} signed response cannot complete a reshipment with the same carrier and tracking number`, async () => {
    const db = createCollectionStore({ mall_orders: [order({ refundStatus: 'none' })] })
    const handler = require(`../../cloudfunctions/api/handlers/${module}`)({ db, checkLogisticsQueryRateLimit: async () => {}, getUser: async () => ({}), requireAdmin: async () => ({}),
      getDocOrNull: async () => structuredClone(db.state.mall_orders[0]), now: () => new Date(),
      queryOrderLogistics: async () => {
        db.state.mall_orders[0].shippedAt = '2026-10-23T11:00:00Z'
        return { hasLogistics: true, isDelivered: true, isSimulated: false }
      } })
    const result = await handler('user', 'queryOrderLogistics', { orderId: 'o' })
    assert.equal(result.orderStatusUpdated, undefined)
    assert.equal(db.state.mall_orders[0].status, 'shipped')
  })
}
