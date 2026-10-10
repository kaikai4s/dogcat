const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')

function fixture(phone = ' 400-800-1234 ') {
  const sent = []
  const db = createCollectionStore({ platform_configs: [{ _id: 'settings', key: 'system_settings', value: {
    customerService: { phone }, subscription: { enabled: true, templates: { orderAccepted: 'configured-template-44245' } }
  } }] })
  const ctx = createContext({ db, cloud: { openapi: { subscribeMessage: { send: async data => { sent.push(data) } } } } })
  const order = { _id: 'order', orderNo: 'O202610110001', clientOpenid: 'client', staffOpenid: 'staff',
    staffName: '张师傅', staffPhone: '13911112222', contactPhone: '13833334444', serviceSummary: '上门喂猫',
    assignedAt: new Date('2026-10-11T02:00:00Z') }
  return { db, ctx, sent, order, settings: db.state.platform_configs[0].value }
}

test('accepted notification uses template 44245 fields and platform phone only', async () => {
  const { ctx, sent, order } = fixture()
  const result = await ctx.notifyOrderAccepted(order, '李师傅')
  assert.equal(result.status, 'sent')
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0], { touser: 'client', templateId: 'configured-template-44245',
    page: 'pages/client/orders/detail/index?id=order', data: {
      character_string1: { value: 'O202610110001' }, thing2: { value: '李师傅' },
      phone_number4: { value: '400-800-1234' }, thing5: { value: '上门喂猫' }
    } })
  assert.ok(!JSON.stringify(sent).includes(order.staffPhone))
  assert.ok(!JSON.stringify(sent).includes(order.contactPhone))
})

test('queued and immediate accepted notifications share delivery identity', async () => {
  const { db, ctx, order, sent, settings } = fixture()
  await db.runTransaction(tx => ctx.enqueueOrderAccepted(tx, order, '张师傅'))
  db.state.platform_configs[0].value.customerService.phone = '010-12345678'
  await ctx.notifyOrderAccepted(order, '张师傅')
  await ctx.notifyOrderAccepted(order, '另一个展示名称')
  await ctx.retryFailedSubscriptions()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].data.phone_number4.value, '010-12345678')
  assert.equal(db.state.subscription_logs.filter(row => row.delivery).length, 1)
})

test('missing platform phone skips sending and can retry with configured phone', async () => {
  const { db, ctx, order, sent, settings } = fixture('')
  const result = await ctx.notifyOrderAccepted(order)
  assert.equal(result.status, 'skipped')
  assert.equal(result.error, 'platform_phone_not_configured')
  assert.equal(sent.length, 0)
  const list = await ctx.listSubscriptionDeliveries({ status: 'skipped' })
  assert.match(list.list[0].reasonText, /平台客服电话/)
  db.state.platform_configs[0].value.customerService.phone = '400-900-1234'
  await ctx.requeueSubscriptionDelivery(list.list[0].id, 'admin')
  await ctx.retryFailedSubscriptions()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].data.phone_number4.value, '400-900-1234')
  assert.equal(db.state.subscription_logs.find(row => row.delivery).status, 'sent')
})

test('legacy pending accepted notifications are translated without losing delivery identity', async () => {
  const { db, ctx, sent } = fixture()
  const legacy = { openid: 'client', templateKey: 'orderAccepted',
    page: 'pages/client/orders/detail/index?id=order', messageData: {
      character_string1: { value: 'OLD123' }, thing2: { value: '上门遛狗' },
      name3: { value: '王师傅' }, thing4: { value: '旧服务地址' }, time17: { value: '10:00' }
    }, orderId: 'order' }
  const id = await db.runTransaction(tx => ctx.enqueueSubscription(tx, legacy))
  await ctx.retryFailedSubscriptions()
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].data, { character_string1: { value: 'OLD123' }, thing2: { value: '王师傅' },
    phone_number4: { value: '400-800-1234' }, thing5: { value: '上门遛狗' } })
  assert.equal(db.state.subscription_logs.find(row => row._id === id).status, 'sent')
  assert.equal(db.state.subscription_logs.filter(row => row.delivery).length, 1)
})

test('accepted notification bounds text fields and notifies again after a new assignment', async () => {
  const { ctx, order, sent } = fixture()
  order.serviceSummary = '猫'.repeat(30)
  await ctx.notifyOrderAccepted(order, '张'.repeat(25))
  assert.equal(sent[0].data.thing2.value.length, 20)
  assert.equal(sent[0].data.thing5.value.length, 20)
  order.assignedAt = new Date('2026-10-11T03:00:00Z')
  await ctx.notifyOrderAccepted(order, '张师傅')
  assert.equal(sent.length, 2)
})
