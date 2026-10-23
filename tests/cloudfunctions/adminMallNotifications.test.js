const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
function fixture({ failSend = false, enabled = true } = {}) {
  const db = createCollectionStore({
    users: [{ _id: 'a', openid: 'admin', roles: ['admin'], status: 'active' }, { _id: 'b', openid: 'blocked', roles: ['admin'], status: 'disabled' }],
    platform_configs: [{ _id: 'settings', key: 'system_settings', value: { subscription: { enabled, templates: { orderPaid: 'paid-template' } } } }],
    mall_orders: [{ _id: 'mall', orderType: 'mall', businessType: 'mall', orderNo: 'M123', clientOpenid: 'client', status: 'pending_pay', paymentStatus: 'unpaid', payAmount: 20,
      items: [{ productId: 'p', skuId: 'sku', name: '玩具', price: 20, quantity: 1 }], createdAt: new Date(), shippingAddress: { serviceAddress: '测试路' } }],
    mall_products: [{ _id: 'p', name: '玩具', status: 'on_sale', specMode: 'single', price: 20, stock: 10, skus: [{ skuId: 'sku', price: 20, stock: 10, status: 'on_sale' }] }]
  })
  const sent = []
  const ctx = createContext({ db, cloud: { openapi: { subscribeMessage: { send: async payload => { if (failSend) throw new Error('temporary network'); sent.push(payload) } } } } })
  const pay = async () => {
    const order = structuredClone(db.state.mall_orders[0])
    const payment = await ctx.reserveOrderPayment(order, 'client', 'wechat', 'pay1')
    return ctx.settleOrderPayment('mall', { paymentNo: payment.paymentNo, wxTransactionId: 'wx1', channel: 'wechat' })
  }
  return { db, ctx, pay, sent }
}

test('mall paid event persists admin notification and subscription once in the payment transaction', async () => {
  const { db, pay, ctx, sent } = fixture()
  assert.equal((db.state.admin_notifications || []).length, 0)
  const paid = await pay()
  assert.equal(paid.order.status, 'pending_ship')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].touser, 'admin')
  assert.equal(sent[0].page, 'pages/admin/mall/orders/index')
  assert.equal(sent[0].templateId, 'paid-template')
  assert.equal(sent[0].data.character_string1.value, 'M123')
  assert.equal(sent[0].data.thing2.value, '玩具')
  assert.equal(db.state.admin_notifications.length, 1)
  await ctx.settleOrderPayment('mall', { paymentNo: paid.order.paymentNo })
  await ctx.retryFailedSubscriptions()
  assert.equal(sent.length, 1)
  assert.equal(db.state.admin_notifications.length, 1)
  assert.equal((await ctx.getAdminNotificationBadge('admin')).unreadCount, 1)
  db.state.mall_orders[0].status = 'shipped'
  assert.equal((await ctx.getAdminNotificationBadge('admin')).unreadCount, 0)
})

test('subscription failure or disabled switch never rolls back payment or removes station notification', async () => {
  for (const options of [{ failSend: true }, { enabled: false }]) {
    const { db, pay, sent } = fixture(options)
    await pay()
    assert.equal(db.state.mall_orders[0].paymentStatus, 'paid')
    assert.equal(db.state.admin_notifications.length, 1)
    assert.equal(sent.length, 0)
    assert.equal(db.state.subscription_logs.filter(r => r.delivery && r.templateKey === 'adminMallOrderPaid').length, 1)
  }
})

test('only administrators with mall access receive new-order messages', async () => {
  const { db, ctx, pay, sent } = fixture()
  db.state.admin_access_config = [{ _id: 'policy', enabled: true, ownerOpenid: 'owner' }]
  db.state.admin_groups = [{ _id: 'mall', enabled: true, permissions: ['adminMall.listOrders'] }]
  db.state.admin_memberships = [{ _id: 'a', groupIds: ['mall'] }]
  await pay()
  assert.equal(sent.length, 1)
  const delivery = db.state.subscription_logs.find(r => r.delivery)
  db.state.admin_memberships[0].groupIds = []
  const result = await ctx.sendSubscribeMessage('admin', 'adminMallOrderPaid', delivery.page, delivery.messageData, 'mall', 'different-delivery')
  assert.equal(result.status, 'skipped')
  assert.equal(result.error, 'admin_mall_access_revoked')
  assert.equal(sent.length, 1)
})

test('pending mall count includes unshipped orders and actionable after-sales once, not unpaid or finished records', async () => {
  const { db, ctx } = fixture()
  db.state.mall_orders = [
    { _id: 'a', status: 'pending_ship' }, { _id: 'b', status: 'pending_ship', refundStatus: 'none' },
    { _id: 'c', status: 'pending_ship', refundStatus: 'applied' }, { _id: 'd', status: 'shipped', refundStatus: 'return_shipped' },
    { _id: 'e', status: 'refund_applied', refundStatus: 'pending_manual' },
    { _id: 'f', status: 'pending_pay' }, { _id: 'g', status: 'completed', refundStatus: 'refunded' },
    { _id: 'h', status: 'pending_ship', refundStatus: 'processing' }
  ]
  assert.equal(await ctx.countPendingMallOrders(), 5)
  const api = loadCloudFunction('api', db, 'admin')
  const result = await api.main({ module: 'adminMall', action: 'listOrders', data: { pendingCountsOnly: true } })
  assert.equal(result.ok, true, result.message)
  assert.equal(result.data.pendingCount, 5)
  const dashboard = await api.main({ module: 'admin', action: 'dashboard', data: {} })
  assert.equal(dashboard.ok, true, dashboard.message)
  assert.equal(dashboard.data.pendingReviews.mallOrders, 5)
})

test('concurrent payment callbacks cannot duplicate the admin notification or subscription', async () => {
  const { db, ctx, sent } = fixture()
  require('./optimisticTransactions')(db)
  const payment = await ctx.reserveOrderPayment(structuredClone(db.state.mall_orders[0]), 'client', 'wechat', 'pay1')
  await Promise.all([ctx.settleOrderPayment('mall', { paymentNo: payment.paymentNo }), ctx.settleOrderPayment('mall', { paymentNo: payment.paymentNo })])
  assert.equal(db.state.admin_notifications.length, 1)
  assert.equal(db.state.subscription_logs.filter(row => row.delivery && row.templateKey === 'adminMallOrderPaid').length, 1)
  assert.equal(sent.length, 1)
})

test('revoked mall permissions and orders already shipped are skipped on queued subscription retry', async () => {
  const { db, ctx, pay, sent } = fixture({ enabled: false })
  await pay()
  db.state.platform_configs[0].value.subscription.enabled = true
  db.state.mall_orders[0].status = 'shipped'
  const delivery = db.state.subscription_logs.find(row => row.delivery)
  const result = await ctx.sendSubscribeMessage('admin', delivery.templateKey, delivery.page, delivery.messageData, 'mall', 'retry-after-shipping')
  assert.equal(result.status, 'skipped')
  assert.equal(result.error, 'admin_mall_order_handled')
  assert.equal(sent.length, 0)
})
