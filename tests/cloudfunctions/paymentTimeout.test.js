const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const time = require('../../cloudfunctions/api/utils/time')
const createDeadline = require('../../cloudfunctions/api/services/paymentDeadline')
const createCancellation = require('../../cloudfunctions/api/scheduled/cancelUnpaidOrders')
const fixedNow = new Date('2026-09-21T04:00:00Z')

function setup({ orders, payments = [], gateway } = {}) {
  const db = createCollectionStore({
    orders: orders || [{ _id: 'order', createdAt: new Date('2026-09-21T03:00:00Z'), status: 'pending_pay', paymentStatus: payments.length ? 'paying' : 'unpaid', ...(payments.length ? { paymentNo: 'P1' } : {}), couponId: 'coupon', payAmount: 10 }],
    payments, user_coupons: [{ _id: 'coupon', status: 'locked', lockedOrderId: 'order' }], order_timeline: []
  })
  const calls = []
  const protocol = require('../../cloudfunctions/api/services/wechatPay')({ safeText: String })
  const services = createCancellation({
    db, ORDER_STATUS: { PENDING_PAY: 'pending_pay' }, now: () => fixedNow,
    ...createDeadline({ ...time, now: () => fixedNow }),
    getSystemSettings: async () => ({}), getWechatPayConfig: () => ({ appId: 'app', mchId: 'merchant' }),
    validatePaymentCallbackPayload: protocol.validatePaymentCallbackPayload,
    sanitizeWechatPayload: value => value,
    couponDisplayStatus: coupon => coupon.status,
    markOrderPaid: async (id, data) => {
      await db.collection('orders').doc(id).update({ data: { status: 'paid', paymentStatus: 'paid', paymentNo: data.paymentNo } })
    },
    wechatPayRequest: async (method, path, body) => {
      calls.push({ method, path, body })
      return gateway ? gateway(method, db) : { trade_state: 'NOTPAY' }
    }
  })
  return { db, calls, ...services }
}
const payment = { _id: 'pay', orderId: 'order', paymentNo: 'P1', status: 'pending', channel: 'wechat' }

test('timeout cancellation pages past 100 orders while changing their status', async () => {
  const orders = Array.from({ length: 205 }, (_, i) => ({ _id: `o${String(i).padStart(3, '0')}`, status: 'pending_pay', paymentStatus: 'unpaid', createdAt: new Date('2026-09-21T03:00:00Z') }))
  const { db, cancelUnpaidOrders } = setup({ orders })
  assert.equal((await cancelUnpaidOrders()).length, 205)
  assert.ok(db.state.orders.every(order => order.status === 'cancelled'))
  assert.equal(db.state.order_timeline.length, 205)
  assert.deepEqual(await cancelUnpaidOrders(), [])
})

test('unpaid WeChat transaction is queried and closed before coupon release', async () => {
  const { db, calls, cancelUnpaidOrders } = setup({ payments: [payment] })
  assert.deepEqual(await cancelUnpaidOrders(), ['order'])
  assert.deepEqual(calls.map(call => call.method), ['GET', 'POST'])
  assert.ok(calls[1].path.endsWith('/P1/close'))
  assert.equal(db.state.user_coupons[0].status, 'available')
  assert.equal(db.state.payments[0].status, 'closed')
})

test('paid WeChat transaction is reconciled without cancelling or releasing coupon', async () => {
  const { db, calls, cancelUnpaidOrders } = setup({ payments: [payment], gateway: () => ({
    trade_state: 'SUCCESS', appid: 'app', mchid: 'merchant', out_trade_no: 'P1', transaction_id: 'wx1', amount: { total: 1000 }
  }) })
  assert.deepEqual(await cancelUnpaidOrders(), [])
  assert.equal(db.state.orders[0].status, 'paid')
  assert.equal(db.state.user_coupons[0].status, 'locked')
  assert.equal(calls.length, 1)
})

test('gateway failure or payment winning the close race leaves the order untouched', async () => {
  for (const failOn of ['GET', 'POST']) {
    const { db, cancelUnpaidOrders } = setup({ payments: [payment], gateway: method => {
      if (method === failOn) throw new Error('gateway unavailable or ORDERPAID')
      return { trade_state: 'NOTPAY' }
    } })
    assert.deepEqual(await cancelUnpaidOrders(), [])
    assert.equal(db.state.orders[0].status, 'pending_pay')
    assert.equal(db.state.user_coupons[0].status, 'locked')
  }
})

test('transaction recheck preserves concurrent payment success and coupon ownership', async () => {
  const { db, cancelUnpaidOrders } = setup()
  const run = db.runTransaction
  db.runTransaction = callback => {
    db.state.orders[0] = { ...db.state.orders[0], status: 'paid', paymentStatus: 'paid' }
    return run(callback)
  }
  assert.deepEqual(await cancelUnpaidOrders(), [])
  assert.equal(db.state.orders[0].status, 'paid')
  assert.equal(db.state.user_coupons[0].status, 'locked')
  const other = setup()
  other.db.state.user_coupons[0].lockedOrderId = 'another-order'
  assert.deepEqual(await other.cancelUnpaidOrders(), ['order'])
  assert.equal(other.db.state.user_coupons[0].status, 'locked')
})

test('coupon write failure rolls back cancellation and allows retry', async () => {
  const { db, cancelUnpaidOrders } = setup()
  const run = db.runTransaction
  db.runTransaction = callback => run(transaction => callback({ collection(name) {
    const collection = transaction.collection(name)
    if (name !== 'user_coupons') return collection
    const doc = collection.doc
    collection.doc = id => ({ ...doc(id), update: async () => { throw new Error('coupon write failed') } })
    return collection
  } }))
  assert.deepEqual(await cancelUnpaidOrders(), [])
  assert.equal(db.state.orders[0].status, 'pending_pay')
  assert.equal(db.state.user_coupons[0].status, 'locked')
  assert.equal(db.state.order_timeline.length, 0)
  db.runTransaction = run
  assert.deepEqual(await cancelUnpaidOrders(), ['order'])
})

test('payment deadline rejects new attempts exactly at 30 minutes', () => {
  const deadline = createDeadline({ ...time, now: () => fixedNow })
  assert.throws(() => deadline.assertOrderPaymentOpen({ createdAt: new Date('2026-09-21T03:30:00Z') }), /支付已超时/)
  assert.doesNotThrow(() => deadline.assertOrderPaymentOpen({ createdAt: new Date('2026-09-21T03:31:00Z') }))
})

test('WeChat closed or nonexistent transactions allow local cancellation', async () => {
  for (const state of ['CLOSED', 'ORDER_NOT_EXIST']) {
    const { db, cancelUnpaidOrders } = setup({ payments: [payment], gateway: () => {
      if (state === 'ORDER_NOT_EXIST') throw Object.assign(new Error('not found'), { code: state })
      return { trade_state: state }
    } })
    assert.deepEqual(await cancelUnpaidOrders(), ['order'])
    assert.equal(db.state.user_coupons[0].status, 'available')
  }
})

test('new prepay request passes original order deadline to WeChat', async () => {
  const order = { _id: 'order', payAmount: 10, status: 'pending_pay', paymentStatus: 'unpaid', createdAt: new Date('2026-09-21T03:45:00Z') }
  const db = createCollectionStore({ payments: [payment] })
  let body
  const handler = require('../../cloudfunctions/api/handlers/payment')({
    db, ORDER_STATUS: { PAID: 'paid', PENDING_PAY: 'pending_pay' },
    ...createDeadline({ ...time, now: () => fixedNow }),
    now: () => fixedNow, safeText: value => value == null ? '' : String(value),
    requireClientPayableOrder: async () => ({ order, collectionName: 'orders', orderType: 'service' }),
    getSystemSettings: async () => ({ payment: { mode: 'wechat' } }),
    getClientRequestId: () => '', ensurePaymentRecord: async () => payment,
    assertPaymentModeAllowed() {}, assertOrderTransition() {}, updateOrderWhenStatus: async () => {},
    getWechatPayConfig: () => ({ mchId: 'merchant', appId: 'app' }),
    amountYuanToFen: value => Math.round(value * 100),
    wechatPayRequest: async (method, path, request) => { body = request; return { prepay_id: 'prepay' } },
    sanitizeWechatPayload: value => value, appendPaymentEvent: async () => {}, buildMiniProgramPayParams: () => ({})
  })
  await handler('client', 'createPayment', { orderId: 'order' })
  assert.equal(body.time_expire, '2026-09-21T04:15:00+00:00')
})
