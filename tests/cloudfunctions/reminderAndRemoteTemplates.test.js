const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const optimistic = require('./optimisticTransactions')
function fixture() {
  const db = createCollectionStore({
    users: [{ _id: 'staff', openid: 'staff', roles: ['staff'], status: 'active' }],
    platform_configs: [{ _id: 'config', key: 'system_settings', value: { subscription: { enabled: true,
      templates: { upcomingServiceReminder: 'reminder19425', remoteUnlock: 'unlock24826', serviceProgress: 'progress' } } } }],
    orders: [{ _id: 'order', orderNo: 'O20261011001', staffOpenid: 'staff', clientOpenid: 'client', status: 'assigned',
      startTime: '2026-10-11 10:00', endTime: '2026-10-12 12:00', serviceAddress: '阳光小区',
      petSnapshots: [{ name: '布丁', species: 'cat' }, { name: '可乐', species: 'dog' }],
      serviceSessions: [{ index: 1, startTime: '2026-10-11 10:00', endTime: '2026-10-11 12:00', status: 'pending' },
        { index: 2, startTime: '2026-10-12 09:00', endTime: '2026-10-12 10:00', status: 'pending' }],
      orderHomeSecurity: { type: 'remote_unlock', remoteUnlock: { requestCount: 0 } } }]
  })
  optimistic(db)
  const sent = []
  const cloud = { openapi: { subscribeMessage: { send: async message => { sent.push(message) } } } }
  return { db, sent, cloud, ctx: createContext({ db, cloud }) }
}
test('19425 reminder uses current session time range and pet information, once even concurrently', async () => {
  const { db, sent, ctx } = fixture()
  const time = new Date('2026-10-11T01:30:00Z')
  await Promise.all([ctx.sendUpcomingServiceRemindersToStaff(time), ctx.sendUpcomingServiceRemindersToStaff(time)])
  assert.equal(sent.length, 1)
  assert.equal(sent[0].touser, 'staff')
  assert.equal(sent[0].page, 'pages/staff/orders/service/index?id=order')
  assert.deepEqual(sent[0].data, { time3: { value: '10:00~12:00' }, thing4: { value: '阳光小区' }, short_thing6: { value: '猫、狗' },
    thing7: { value: '布丁、可乐' }, thing5: { value: '请按时前往，完整地址及照护要求见订单' } })
  db.state.orders[0].status = 'day_completed'
  db.state.orders[0].serviceSessions[0].status = 'completed'
  await ctx.sendUpcomingServiceRemindersToStaff(new Date('2026-10-12T00:30:00Z'))
  assert.equal(sent.length, 2)
  assert.equal(sent[1].data.time3.value, '09:00~10:00')
})
test('completed orders are not reminded and missing template never falls back to progress', async () => {
  const { db, ctx, sent } = fixture()
  db.state.orders[0].status = 'completed'
  await ctx.sendUpcomingServiceRemindersToStaff(new Date('2026-10-11T01:30:00Z'))
  assert.equal(sent.length, 0)
  db.state.platform_configs[0].value.subscription.templates.upcomingServiceReminder = ''
  const result = await ctx.notifyOrder('staff', 'upcomingServiceReminder', db.state.orders[0])
  assert.equal(result.error, 'template_not_configured')
})
test('24826 remote request uses clear instructions and original Beijing request time, concurrent clicks send once', async () => {
  const { db, sent, cloud, ctx } = fixture()
  const api = loadCloudFunction('api', db, 'staff', cloud)
  const request = () => api.main({ module: 'homeSecurity', action: 'requestRemoteUnlock', data: { orderId: 'order' } })
  const results = await Promise.all([request(), request()])
  assert.equal(results.filter(row => row.ok).length, 1)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].touser, 'client')
  assert.equal(sent[0].templateId, 'unlock24826')
  assert.deepEqual(sent[0].data, { character_string1: { value: 'O20261011001' }, thing4: { value: '宠托师请求远程开门' },
    thing10: { value: '请核实到访人员后，在门锁应用远程开门' },
    time5: { value: ctx.formatDateTime(db.state.orders[0].orderHomeSecurity.remoteUnlock.lastRequestedAt) } })
  assert.equal(sent[0].page, 'pages/client/orders/detail/index?id=order')
  assert.equal((await request()).ok, false)
})
test('remote notification failure is queued and retry keeps request time', async () => {
  const { db, sent, cloud, ctx } = fixture()
  const send = cloud.openapi.subscribeMessage.send
  cloud.openapi.subscribeMessage.send = async () => { throw new Error('temporary send failure') }
  const api = loadCloudFunction('api', db, 'staff', cloud)
  const result = await api.main({ module: 'homeSecurity', action: 'requestRemoteUnlock', data: { orderId: 'order' } })
  assert.equal(result.ok, true, result.message)
  const row = db.state.subscription_logs.find(row => row.delivery)
  assert.equal(row.status, 'queued')
  const requestTime = row.messageData.time5.value
  row.nextAttemptAt = new Date(0)
  cloud.openapi.subscribeMessage.send = send
  await ctx.retryFailedSubscriptions()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].data.time5.value, requestTime)
})
test('completed and unassigned staff cannot send remote unlock requests', async () => {
  const { db, sent, cloud } = fixture()
  const api = loadCloudFunction('api', db, 'staff', cloud)
  db.state.orders[0].status = 'completed'
  assert.equal((await api.main({ module: 'homeSecurity', action: 'requestRemoteUnlock', data: { orderId: 'order' } })).ok, false)
  db.state.orders[0].status = 'assigned'
  db.state.orders[0].staffOpenid = 'another'
  assert.equal((await api.main({ module: 'homeSecurity', action: 'requestRemoteUnlock', data: { orderId: 'order' } })).ok, false)
  assert.equal(sent.length, 0)
})
