const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const optimistic = require('./optimisticTransactions')

const successTime = '2026-10-11T11:25:00+08:00'
function fixture({ mall = false, template = 'refund-7272', mode = 'wechat', status = 'SUCCESS' } = {}) {
  const collection = mall ? 'mall_orders' : 'orders'
  const db = createCollectionStore({
    platform_configs: [{ _id: 'config', key: 'system_settings', value: { subscription: { enabled: true, templates: { refundResult: template } } } }],
    [collection]: [{ _id: 'order', orderNo: 'O202610110001', clientOpenid: 'client', paymentStatus: 'paid', status: 'paid',
      paymentNo: 'P10001', payAmount: 100, serviceSummary: '上门喂猫',
      ...(mall ? { orderType: 'mall', items: [{ name: '宠物玩具', quantity: 1 }] } : {}) }]
  })
  optimistic(db)
  const sent = []
  const cloud = { openapi: { subscribeMessage: { send: async message => { sent.push(message) } } } }
  const ctx = createContext({ db, cloud })
  const gateway = { status }
  const refunds = require('../../cloudfunctions/api/services/refunds')({ ...ctx,
    getSystemSettings: async () => ({ payment: { mode, refundEnabled: true } }),
    assertPaymentModeAllowed: () => {}, getWechatPayConfig: () => ({}),
    wechatPayRequest: async (method, path, body) => {
      if (gateway.error) throw gateway.error
      const row = method === 'GET' && db.state.refunds.find(row => path.endsWith(`/${row.refundNo}`))
      return { status: gateway.status, out_refund_no: row ? row.refundNo : body.out_refund_no,
        amount: row ? { total: Math.round(row.amount * 100), refund: Math.round(row.refundAmount * 100) } : body.amount, success_time: successTime }
    }
  })
  const refund = (amount = 25.5, id = 'first') => refunds.requestOrderRefund(structuredClone(db.state[collection][0]), amount, '用户申请退款', 'admin', 'admin', id)
  const deliveries = () => (db.state.subscription_logs || []).filter(row => row.delivery && row.templateKey === 'refundResult')
  return { db, ctx, cloud, sent, gateway, refunds, refund, deliveries }
}

test('service refund result sends template 7272 with per-refund amount and service detail page', async () => {
    const mall = false
    const { refund, sent } = fixture({ mall })
    await refund()
    assert.deepEqual(sent[0], { touser: 'client', templateId: 'refund-7272',
      page: mall ? 'pages/client/mall/orders/detail/index?id=order' : 'pages/client/orders/detail/index?id=order', data: {
        amount2: { value: '25.50' }, thing3: { value: '退款成功，请留意原支付账户' }, date4: { value: '2026-10-11 11:25' },
        thing5: { value: mall ? '宠物玩具' : '上门喂猫' }, character_string6: { value: 'O202610110001' }
      } })
    await refund(74.5, 'second')
    assert.equal(sent.length, 2)
    assert.equal(sent[1].data.amount2.value, '74.50', 'never use the cumulative 100 yuan refund')
})

test('mall refunds do not send subscription notifications', async () => {
  const { refund, sent, deliveries } = fixture({ mall: true })
  await refund()
  await refund(74.5, 'second')
  assert.equal(sent.length, 0)
  assert.equal(deliveries().length, 0)
})

test('repeated and concurrent refund result processing sends only once', async () => {
  const { refund, sent, refunds, deliveries, db, gateway } = fixture({ status: 'PROCESSING' })
  await refund()
  const pending = structuredClone(db.state.refunds[0])
  gateway.status = 'SUCCESS'
  await Promise.all([refund(), refunds.dispatchOrderRefund(pending), refunds.dispatchOrderRefund(pending)])
  await refund()
  assert.equal(sent.length, 1)
  assert.equal(deliveries().length, 1)
})

for (const status of ['CLOSED', 'ABNORMAL']) {
  test(`terminal refund ${status} sends failure reason; a new refund can later succeed`, async () => {
    const { refund, sent, gateway } = fixture({ status })
    const result = await refund()
    assert.equal(result.status, 'failed')
    assert.equal(sent[0].data.thing3.value, result.failReason)
    assert.equal(sent[0].data.amount2.value, '25.50')
    gateway.status = 'SUCCESS'
    await refund(100, 'retry')
    assert.equal(sent.length, 2)
    assert.equal(sent[1].data.amount2.value, '100.00')
  })
}

test('processing WeChat refund never reports success or consumes result consent', async () => {
  const { refund, sent, deliveries } = fixture({ status: 'PROCESSING' })
  assert.equal((await refund()).status, 'processing')
  assert.equal(sent.length, 0)
  assert.equal(deliveries().length, 0)
})

test('mock refund settles locally without sending a real-money refund notification', async () => {
  const { refund, sent, deliveries, db } = fixture({ mode: 'mock', status: 'PROCESSING' })
  assert.equal((await refund()).status, 'success')
  assert.equal(db.state.orders[0].refundedAmount, 25.5)
  assert.equal(sent.length, 0)
  assert.equal(deliveries().length, 0)
})

test('uncertain gateway response waits for reconciliation before sending the result', async () => {
  const { refund, refunds, sent, gateway } = fixture()
  gateway.error = new Error('network timeout')
  await assert.rejects(refund(), /待核实/)
  assert.equal(sent.length, 0)
  gateway.error = null
  await refunds.reconcilePendingRefunds()
  await refunds.reconcilePendingRefunds()
  assert.equal(sent.length, 1)
})

test('sending failure retries original result time and amount without reversing refund', async () => {
  const { refund, cloud, ctx, sent, deliveries, db } = fixture()
  const send = cloud.openapi.subscribeMessage.send
  cloud.openapi.subscribeMessage.send = async () => { throw new Error('network error') }
  assert.equal((await refund()).status, 'success')
  assert.equal(db.state.orders[0].refundedAmount, 25.5)
  assert.equal(deliveries()[0].status, 'queued')
  deliveries()[0].nextAttemptAt = new Date(0)
  cloud.openapi.subscribeMessage.send = send
  await ctx.retryFailedSubscriptions()
  assert.equal(sent[0].data.date4.value, '2026-10-11 11:25')
  assert.equal(sent[0].data.amount2.value, '25.50')
})

test('missing refund template is logged, and manual retry works after configuration', async () => {
  const { refund, db, ctx, sent, deliveries } = fixture({ template: '' })
  assert.equal((await refund()).status, 'success')
  assert.equal(deliveries()[0].error, 'template_not_configured')
  db.state.platform_configs[0].value.subscription.templates.refundResult = 'configured-later'
  await ctx.requeueSubscriptionDelivery(deliveries()[0]._id, 'admin')
  await ctx.retryFailedSubscriptions()
  assert.equal(sent[0].templateId, 'configured-later')
})

test('WeChat 43101 is explained without changing the successful refund', async () => {
  const { refund, cloud, ctx, deliveries } = fixture()
  cloud.openapi.subscribeMessage.send = async () => { throw { errCode: 43101, errMsg: 'user rejected' } }
  assert.equal((await refund()).status, 'success')
  assert.equal(deliveries()[0].isQuotaExhausted, true)
  const list = await ctx.listSubscriptionDeliveries({ status: 'queued' })
  assert.match(list.list[0].reasonText, /用户未同意/)
})

test('legacy queued refunds keep history and skip unknown amounts and timestamps', async () => {
  const { ctx, sent } = fixture()
  const result = await ctx.sendSubscribeMessage('client', 'refundResult', 'pages/client/orders/detail/index?id=order', {
    thing4: { value: '退款成功' }, thing9: { value: '退款 25.5 元已完成' }
  }, 'order', 'legacy')
  assert.equal(result.status, 'skipped')
  assert.equal(result.error, 'legacy_refund_payload')
  assert.equal(sent.length, 0)
})
