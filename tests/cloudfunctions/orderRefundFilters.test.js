const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const optimistic = require('./optimisticTransactions')
const { getOrderRefundState } = require('../../cloudfunctions/api/utils/orderRefundState')

function fixture(orderRows) {
  const rows = orderRows || [
    { _id: 'pending-cancelled', status: 'cancelled', paymentStatus: 'refunding', refundStatus: 'processing' },
    { _id: 'pending-expired', status: 'expired', refundStatus: 'processing' },
    { _id: 'pending-partial', status: 'completed', paymentStatus: 'refunding', refundedAmount: 25 },
    { _id: 'full-completed', status: 'completed', paymentStatus: 'refunded', refundStatus: 'full_refunded' },
    { _id: 'partial', status: 'cancelled', paymentStatus: 'paid', refundStatus: 'partially_refunded', refundedAmount: 25 },
    { _id: 'legacy-refunded', status: 'refunded' },
    { _id: 'approved-only', status: 'cancelled', paymentStatus: 'paid', refundStatus: 'approved' },
    { _id: 'failed', status: 'cancelled', paymentStatus: 'paid', refundStatus: 'failed' },
    { _id: 'other', clientOpenid: 'other', status: 'cancelled', paymentStatus: 'refunding' },
    { _id: 'deleted', status: 'refunded', adminDeletedAt: new Date() }
  ]
  const db = createCollectionStore({
    users: [{ _id: 'client', openid: 'client', roles: ['client'], status: 'active', phone: '13800001111' },
      { _id: 'other', openid: 'other', roles: ['client'], status: 'active' },
      { _id: 'admin', openid: 'admin', roles: ['admin'], status: 'active' }],
    orders: rows.map((row, i) => ({ clientOpenid: 'client', payAmount: 100, orderNo: `TEST-${row._id}`,
      createdAt: new Date(Date.UTC(2026, 9, 11, 1, i)), serviceStartDate: '2026-10-15', serviceEndDate: '2026-10-15', ...row })),
    refunds: []
  })
  optimistic(db)
  const context = createContext({ db, cloud: {} })
  const gatewayCalls = []
  const gateway = { request: async () => { throw new Error('unexpected gateway call') } }
  const refunds = require('../../cloudfunctions/api/services/refunds')({ ...context,
    getSystemSettings: async () => ({ payment: { mode: 'wechat', refundEnabled: true } }), getWechatPayConfig: () => ({}),
    wechatPayRequest: async (method, path, body) => { gatewayCalls.push({ method, path, body }); return gateway.request(method, path, body) }
  })
  const dependencies = { ...context, ...refunds, expireDueUnacceptedOrders: async () => {} }
  return { db, gateway, gatewayCalls, client: require('../../cloudfunctions/api/handlers/order')(dependencies), admin: require('../../cloudfunctions/api/handlers/admin')(dependencies) }
}

test('client refund tabs include cancelled, expired and completed orders, with correct totals and owner scope', async () => {
  const f = fixture()
  for (const [status, expected] of [['refunding', ['pending-cancelled', 'pending-expired', 'pending-partial']],
    ['refunded', ['full-completed', 'partial', 'legacy-refunded']]]) {
    const first = await f.client('client', 'listOrders', { role: 'client', status, page: 1, pageSize: 2 })
    const second = await f.client('client', 'listOrders', { role: 'client', status, page: 2, pageSize: 2 })
    assert.equal(first.total, expected.length)
    assert.equal(first.hasMore, true)
    assert.equal(second.hasMore, false)
    assert.deepEqual([...first.list, ...second.list].map(row => row._id).sort(), expected.sort())
  }
  const narrowed = await f.client('client', 'listOrders', { status: 'refunded', orderKeyword: 'TEST-partial', startDate: '2026-10-15', endDate: '2026-10-15', page: 1 })
  assert.deepEqual(narrowed.list.map(row => row._id), ['partial'])
})

test('administrator refund tabs retain phone and keyword filters and do not count approvals as refunds', async () => {
  const f = fixture()
  const pending = await f.admin('admin', 'listOrders', { status: 'refunding', clientPhone: '13800001111', page: 1, pageSize: 20 })
  assert.equal(pending.total, 3)
  assert.ok(pending.list.every(row => getOrderRefundState(row) === 'refunding'))
  const refunded = await f.admin('admin', 'listOrders', { status: 'refunded', page: 1, pageSize: 20 })
  assert.deepEqual(refunded.list.map(row => row._id).sort(), ['full-completed', 'legacy-refunded', 'partial'])
  const narrowed = await f.admin('admin', 'listOrders', { status: 'refunded', orderKeyword: 'full-completed', page: 1 })
  assert.equal(narrowed.total, 1)
  await assert.rejects(f.admin('client', 'listOrders', { status: 'refunding' }), /管理员/)
})

function awaitingGateway() {
  const f = fixture([{ _id: 'order', status: 'cancelled', paymentStatus: 'refunding', refundStatus: 'processing', refundAmount: 100 }])
  f.db.state.refunds.push({ _id: 'refund', orderId: 'order', collectionName: 'orders', channel: 'wechat', status: 'processing',
    refundNo: 'R1', paymentNo: 'P1', amount: 100, refundAmount: 100, updatedAt: new Date() })
  f.gateway.request = async () => ({ status: 'SUCCESS', out_refund_no: 'R1', refund_id: 'WX1', amount: { total: 10000, refund: 10000 } })
  return f
}

for (const role of ['client', 'admin']) {
  test(`${role} list synchronizes before filtering and paginating, so a paid-out refund moves to the correct tab`, async () => {
    for (const status of ['refunding', 'refunded']) {
      const f = awaitingGateway()
      const result = await f[role](role, 'listOrders', { status, page: 1, pageSize: 1 })
      assert.equal(result.total, status === 'refunded' ? 1 : 0)
      assert.equal(result.list.length, result.total)
      assert.equal(result.hasMore, false)
      assert.equal(f.db.state.orders[0].paymentStatus, 'refunded')
      assert.deepEqual(f.gatewayCalls.map(call => call.method), ['GET'])
    }
  })
  test(`${role} detail shows the latest verified refund result when opened`, async () => {
    const f = awaitingGateway()
    const detail = await f[role](role, 'getOrderDetail', { id: 'order' })
    const order = role === 'admin' ? detail.order : detail
    assert.equal(order.paymentStatus, 'refunded')
    assert.equal(order.refundStatus, 'full_refunded')
    assert.equal(order.refundedAmount, 100)
  })
}

test('other users cannot cause a gateway query by accessing someone else’s pending refund', async () => {
  const f = awaitingGateway()
  const list = await f.client('other', 'listOrders', { status: 'refunded', page: 1 })
  assert.equal(list.total, 0)
  await assert.rejects(f.client('other', 'getOrderDetail', { id: 'order' }), /无权访问/)
  assert.equal(f.gatewayCalls.length, 0)
})
