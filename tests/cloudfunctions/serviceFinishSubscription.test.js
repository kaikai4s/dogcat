const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const optimistic = require('./optimisticTransactions')

function fixture() {
  const db = createCollectionStore({
    users: [{ _id: 'client', openid: 'client', roles: ['client'], status: 'active', points: 0, totalPoints: 0, completedOrderCount: 0 },
      { _id: 'staff', openid: 'staff', roles: ['staff'], status: 'active' }, { _id: 'admin', openid: 'admin', roles: ['admin'], status: 'active' }],
    platform_configs: [{ _id: 'config', key: 'system_settings', value: { subscription: { enabled: true, templates: { serviceFinish: 'finish-18325', serviceProgress: 'progress' } } } }],
    orders: [{ _id: 'order', orderNo: 'O202610110001', clientOpenid: 'client', clientUserId: 'client', staffOpenid: 'staff', status: 'in_service', payAmount: 60,
      serviceSummary: '上门喂猫', serviceType: 'feed', startTime: '2026-10-11 10:00', endTime: '2026-10-11 11:00', activeSessionIndex: 1,
      serviceSessions: [{ index: 1, startTime: '2026-10-11 10:00', endTime: '2026-10-11 11:00', status: 'in_service' }] }]
  })
  optimistic(db)
  const sent = []
  const cloud = { openapi: { subscribeMessage: { send: async message => { sent.push(message) } } } }
  const ctx = createContext({ db, cloud })
  return { db, ctx, cloud, sent }
}
const finishTime = new Date('2026-10-11T03:25:00Z')

test('normal completion sends exact 18325 fields and actual Beijing finish time', async () => {
  const { db, ctx, sent } = fixture()
  const order = db.state.orders[0]
  await ctx.completeOrderService(order, order.serviceSessions[0], finishTime)
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0], { touser: 'client', templateId: 'finish-18325', page: 'pages/client/orders/detail/index?id=order', data: {
    character_string14: { value: 'O202610110001' }, thing6: { value: '上门喂猫' },
    thing5: { value: '服务已完成，可查看服务报告' }, time3: { value: '2026-10-11 11:25' }
  } })
  await ctx.completeOrderService(order, order.serviceSessions[0], new Date('2026-10-11T04:00:00Z'))
  assert.equal(sent.length, 1)
})

test('each daily completion uses its own time; final completion has separate delivery', async () => {
  const { db, ctx, sent } = fixture()
  db.state.orders[0].serviceSessions.push({ index: 2, startTime: '2026-10-12 10:00', endTime: '2026-10-12 11:00', status: 'pending' })
  const first = db.state.orders[0]
  await ctx.completeOrderService(first, first.serviceSessions[0], finishTime)
  assert.equal(db.state.orders[0].status, 'day_completed')
  assert.equal(sent[0].data.time3.value, '2026-10-11 11:25')
  assert.equal(sent[0].data.thing5.value, '今日服务已完成')
  db.state.orders[0].status = 'in_service'
  db.state.orders[0].activeSessionIndex = 2
  const second = db.state.orders[0]
  await ctx.completeOrderService(second, second.serviceSessions[1], new Date('2026-10-12T03:30:00Z'))
  assert.equal(sent.length, 2)
  assert.equal(sent[1].data.time3.value, '2026-10-12 11:30')
})

test('automatic completion informs client and staff with correct pages and time', async () => {
  const { db, ctx, sent } = fixture()
  const order = db.state.orders[0]
  await ctx.completeOrderService(order, order.serviceSessions[0], finishTime, { isAuto: true })
  assert.equal(sent.length, 2)
  assert.equal(sent.find(row => row.touser === 'staff').page, 'pages/staff/orders/service/index?id=order')
  assert.equal(sent.find(row => row.touser === 'client').page, 'pages/client/orders/detail/index?id=order')
  assert.ok(sent.every(row => row.data.time3.value === '2026-10-11 11:25'))
})

test('failed sending preserves original completion timestamp through retry', async () => {
  const { db, ctx, cloud, sent } = fixture()
  const send = cloud.openapi.subscribeMessage.send
  cloud.openapi.subscribeMessage.send = async () => { throw new Error('temporary network failure') }
  const order = db.state.orders[0]
  await ctx.completeOrderService(order, order.serviceSessions[0], finishTime)
  assert.equal(db.state.orders[0].status, 'completed')
  const row = db.state.subscription_logs.find(item => item.delivery)
  assert.equal(row.status, 'queued')
  row.nextAttemptAt = new Date(0)
  cloud.openapi.subscribeMessage.send = send
  await ctx.retryFailedSubscriptions()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].data.time3.value, '2026-10-11 11:25')
})

for (const status of ['assigned', 'on_the_way', 'in_service', 'day_completed']) {
  test('admin verified completion sends one notification from ' + status, async () => {
    const { db, cloud, sent, ctx } = fixture()
    db.state.orders[0].status = status
    const api = loadCloudFunction('api', db, 'admin', cloud)
    const results = await Promise.all([1, 2].map(() => api.main({ module: 'admin', action: 'manualCompleteOrder', data: { orderId: 'order', remark: '已核实线下服务完成' } })))
    assert.ok(results.some(row => row.ok), JSON.stringify(results))
    assert.equal(sent.length, 1)
    assert.equal(sent[0].data.thing5.value, '平台已核实完成，可查看订单详情')
    assert.equal(sent[0].data.time3.value, ctx.formatDateTime(db.state.orders[0].completedAt))
    assert.equal(db.state.users.find(row => row._id === 'client').completedOrderCount, 1)
  })
}

for (const status of ['已完成', '请及时完成服务']) {
  test('legacy completion queue handles ' + status, async () => {
    const { db, ctx, sent } = fixture()
    db.state.orders[0].completedAt = finishTime
    const data = { thing4: { value: status }, character_string5: { value: 'OLD123' }, thing10: { value: '喂猫' }, date3: { value: '2026-10-11 10:00' } }
    await ctx.sendSubscribeMessage('client', 'serviceFinish', 'pages/client/orders/detail/index?id=order', data, 'order')
    assert.equal(sent.length, status === '已完成' ? 1 : 0)
    if (sent.length) assert.equal(sent[0].data.time3.value, '2026-10-11 11:25')
    else assert.equal(db.state.subscription_logs.find(row => row.delivery).error, 'legacy_service_finish_not_completed')
  })
}
