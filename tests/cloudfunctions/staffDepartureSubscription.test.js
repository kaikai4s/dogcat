const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

function fixture({ enabled = true, template = 'departure-template', sendError } = {}) {
  const sent = []
  const db = createCollectionStore({
    users: [{ _id: 'staff', openid: 'staff', realName: '张三', roles: ['staff'], status: 'active' },
      { _id: 'client', openid: 'client', roles: ['client'], status: 'active' },
      { _id: 'admin', openid: 'admin', roles: ['admin'], status: 'active' }],
    platform_configs: [{ _id: 'system_settings', key: 'system_settings', value: { subscription: { enabled, templates: { staffDeparture: template, serviceStart: 'start-template' } } } }],
    orders: [{ _id: 'order', clientOpenid: 'client', staffOpenid: 'staff', status: 'assigned', serviceSummary: '上门遛狗',
      startTime: '2026-10-11 10:00', endTime: '2026-10-11 11:00',
      serviceSessions: [{ index: 1, status: 'pending', startTime: '2026-10-11 10:00', endTime: '2026-10-11 11:00' }] }]
  })
  require('./optimisticTransactions')(db)
  const api = loadCloudFunction('api', db, 'staff', { openapi: { subscribeMessage: { send: async message => { sent.push(message); if (sendError) throw sendError } } } })
  return { db, api, sent, depart: () => api.main({ module: 'order', action: 'departForService', data: { orderId: 'order' } }) }
}

test('departure sends the configured dedicated template to client with correct fields, once per session', async () => {
  const { db, sent, depart } = fixture()
  const res = await depart()
  assert.equal(res.ok, true, res.message)
  assert.equal(sent.length, 1)
  const message = sent[0]
  assert.equal(message.templateId, 'departure-template')
  assert.equal(message.touser, 'client')
  assert.equal(message.page, 'pages/client/orders/detail/index?id=order')
  assert.deepEqual(Object.keys(message.data).sort(), ['thing1', 'thing4', 'time2', 'time3'])
  assert.equal(message.data.thing1.value, '上门遛狗')
  assert.equal(message.data.thing4.value, '张三')
  assert.equal(message.data.time2.value, '2026-10-11 10:00')
  assert.match(message.data.time3.value, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  const departedAt = db.state.orders[0].departedAt
  const retry = await depart()
  assert.equal(retry.ok, true)
  assert.equal(sent.length, 1)
  assert.equal(new Date(db.state.orders[0].departedAt).getTime(), new Date(departedAt).getTime())
  assert.equal(db.state.order_timeline.filter(t => t.type === 'on_the_way').length, 1)
  db.state.orders[0].status = 'day_completed'
  db.state.orders[0].serviceSessions[0].status = 'completed'
  db.state.orders[0].serviceSessions.push({ index: 2, status: 'pending', startTime: '2026-10-12 10:00', endTime: '2026-10-12 11:00' })
  const second = await depart()
  assert.equal(second.ok, true, second.message)
  assert.equal(sent.length, 2)
  assert.equal(sent[1].data.time2.value, '2026-10-12 10:00')
  assert.equal(db.state.orders[0].departureSessionIndex, 2)
})

for (const options of [{ enabled: false }, { template: '' }, { sendError: { errCode: 43101, errMsg: 'user rejected' } }]) {
  test('departure remains successful and logs delivery reason: ' + JSON.stringify(options), async () => {
    const { db, depart } = fixture(options)
    const res = await depart()
    assert.equal(res.ok, true, res.message)
    assert.equal(db.state.orders[0].status, 'on_the_way')
    const delivery = db.state.subscription_logs.find(l => l.delivery && l.templateKey === 'staffDeparture')
    assert.ok(delivery)
    assert.notEqual(delivery.status, 'sent')
    const admin = loadCloudFunction('api', db, 'admin')
    const list = await admin.main({ module: 'admin', action: 'listSubscriptionDeliveries', data: { status: delivery.status } })
    assert.equal(list.ok, true, list.message)
    assert.equal(list.data.list[0].templateName, '宠托师出发通知')
    assert.ok(list.data.list[0].reasonText)
    if (options.sendError) assert.match(list.data.list[0].reasonText, /用户未同意/)
  })
}

test('concurrent departure calls send one notification and preserve one timeline entry', async () => {
  const { db, sent, depart } = fixture()
  const results = await Promise.all([depart(), depart()])
  assert.ok(results.every(result => result.ok))
  assert.equal(sent.length, 1)
  assert.equal(db.state.order_timeline.filter(t => t.type === 'on_the_way').length, 1)
})

test('unauthorized or completed orders never send departure notifications', async () => {
  const { db, sent, depart } = fixture()
  db.state.orders[0].staffOpenid = 'someone_else'
  assert.equal((await depart()).ok, false)
  db.state.orders[0].staffOpenid = 'staff'
  db.state.orders[0].status = 'completed'
  assert.equal((await depart()).ok, false)
  assert.equal(sent.length, 0)
})

test('admin settings save and public settings preserve a configurable departure template', async () => {
  const { db } = fixture()
  const admin = loadCloudFunction('api', db, 'admin')
  const saved = await admin.main({ module: 'admin', action: 'saveSystemSettings', data: { subscription: { enabled: true, templates: { staffDeparture: '  custom-departure  ' } } } })
  assert.equal(saved.ok, true, saved.message)
  const settings = await admin.main({ module: 'system', action: 'getSettings', data: {} })
  assert.equal(settings.data.subscription.templates.staffDeparture, 'custom-departure')
})

test('order completed while departure transaction starts cannot be resurrected', async () => {
  const { db, depart, sent } = fixture()
  const transaction = db.runTransaction
  db.runTransaction = callback => {
    db.state.orders[0].status = 'completed'
    return transaction(callback)
  }
  assert.equal((await depart()).ok, false)
  assert.equal(db.state.orders[0].status, 'completed')
  assert.equal(sent.length, 0)
  assert.equal((db.state.subscription_logs || []).length, 0)
})

test('missing-template delivery can be manually queued after configuration', async () => {
  const { db, depart } = fixture({ template: '' })
  await depart()
  const row = db.state.subscription_logs.find(item => item.delivery)
  const admin = loadCloudFunction('api', db, 'admin')
  const result = await admin.main({ module: 'admin', action: 'retrySubscriptionDelivery', data: { id: row._id } })
  assert.equal(result.ok, true, result.message)
  assert.equal(db.state.subscription_logs.find(item => item._id === row._id).status, 'queued')
})
