const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const optimistic = require('./optimisticTransactions')
const createContext = require('../../cloudfunctions/api/services/context')
const createExpiry = require('../../cloudfunctions/api/scheduled/expireOrders')

const time = new Date('2026-11-12T16:00:00Z')

function fixture(group = false) {
  const order = { _id: 'order', clientOpenid: 'client', status: 'paid', paymentStatus: 'paid',
    staffOpenid: '', payAmount: 100, paymentNo: 'PAY', paymentChannel: 'wechat',
    startTime: group ? '2026-11-13 01:30' : '2026-11-12 23:30', endTime: group ? '2026-11-13 02:00' : '2026-11-13 00:00',
    ...(group ? { groupBuyId: 'group', groupBuyStatus: 'formed' } : {}) }
  const db = createCollectionStore({ orders: [order],
    pet_playground_groups: group ? [{ _id: 'group', status: 'formed', formedAt: 1 }] : [] })
  optimistic(db)
  const context = { ...createContext({ db, cloud: {} }), now: () => time }
  let calls = 0
  const refunds = require('../../cloudfunctions/api/services/refunds')({ ...context,
    getSystemSettings: async () => ({ payment: { mode: 'wechat', refundEnabled: true } }),
    assertPaymentModeAllowed: () => {}, getWechatPayConfig: () => ({}), sanitizeWechatPayload: value => value,
    enqueueOrderNotification: async () => {}, notifyOrder: async () => {},
    wechatPayRequest: async (method, path, body) => { calls++; return { status: 'SUCCESS', out_refund_no: body.out_refund_no, amount: body.amount } }
  })
  const notices = []
  const expiry = overrides => createExpiry({ ...context, createRefundForOrder: refunds.requestOrderRefund,
    appendOrderTimeline: async () => { notices.push('timeline') }, appendOrderClientMessage: async () => { notices.push('message') },
    notifyOrder: async () => { notices.push('subscription') }, ...overrides })
  return { db, context, refunds, expiry, notices, calls: () => calls }
}

for (const group of [false, true]) {
  test(`expiry revalidates a concurrent reschedule before refund reservation (group: ${group})`, async () => {
    const f = fixture(group)
    const expires = f.expiry({ createRefundForOrder: async (...args) => {
      f.db.state.orders[0] = { ...f.db.state.orders[0], startTime: '2026-11-14 10:00', endTime: '2026-11-14 11:00' }
      return f.refunds.requestOrderRefund(...args)
    } })
    await expires.expireUnacceptedOrder('order', structuredClone(f.db.state.orders[0]), time).catch(error => {
      assert.match(error.message, /已变化|不可过期/)
    })
    assert.equal(f.db.state.orders[0].status, 'paid')
    assert.equal(f.db.state.orders[0].paymentStatus, 'paid')
    assert.equal(f.db.state.orders[0].startTime, '2026-11-14 10:00')
    assert.equal((f.db.state.refunds || []).length, 0)
    assert.equal(f.calls(), 0)
    assert.equal(f.notices.length, 0)
    if (group) assert.equal(f.db.state.pet_playground_groups[0].status, 'formed')
  })
}

for (const status of ['assigned', 'on_the_way', 'in_service', 'completed']) {
  test(`forced sibling expiry never refunds a household whose latest status is ${status}`, async () => {
    const f = fixture(true)
    const snapshot = structuredClone(f.db.state.orders[0])
    f.db.state.orders[0] = { ...snapshot, status, staffOpenid: 'staff' }
    await f.expiry().expireUnacceptedOrder('order', snapshot, time, true)
    assert.equal(f.db.state.orders[0].status, status)
    assert.equal(f.db.state.orders[0].staffOpenid, 'staff')
    assert.equal(f.db.state.orders[0].paymentStatus, 'paid')
    assert.equal((f.db.state.refunds || []).length, 0)
    assert.equal(f.calls(), 0)
    assert.equal(f.notices.length, 0)
  })
}

test('forced sibling expiry rechecks an assignment committed before its refund transaction', async () => {
  const f = fixture(true)
  const expires = f.expiry({ createRefundForOrder: async (...args) => {
    f.db.state.orders[0] = { ...f.db.state.orders[0], status: 'assigned', staffOpenid: 'staff' }
    return f.refunds.requestOrderRefund(...args)
  } })
  await expires.expireUnacceptedOrder('order', structuredClone(f.db.state.orders[0]), time, true).catch(error => {
    assert.match(error.message, /已变化|不可过期/)
  })
  assert.equal(f.db.state.orders[0].status, 'assigned')
  assert.equal(f.db.state.orders[0].paymentStatus, 'paid')
  assert.equal((f.db.state.refunds || []).length, 0)
  assert.equal(f.calls(), 0)
})

test('forced expiry leaves a household that has moved to another group untouched', async () => {
  const f = fixture(true)
  const snapshot = structuredClone(f.db.state.orders[0])
  f.db.state.orders[0] = { ...snapshot, groupBuyId: 'other-group' }
  await f.expiry().expireUnacceptedOrder('order', snapshot, time, true)
  assert.equal(f.db.state.orders[0].status, 'paid')
  assert.equal(f.db.state.orders[0].groupBuyId, 'other-group')
  assert.equal((f.db.state.refunds || []).length, 0)
  assert.equal(f.calls(), 0)
  assert.equal(f.notices.length, 0)
})

for (const paymentStatus of ['refunding', 'paying']) {
  test(`unpaid expiry cannot restore a coupon after payment changes to ${paymentStatus}`, async () => {
    const f = fixture()
    Object.assign(f.db.state.orders[0], { paymentStatus: 'unpaid', couponId: 'coupon' })
    f.db.state.user_coupons = [{ _id: 'coupon', status: 'used', usedOrderId: 'order' }]
    const run = f.db.runTransaction
    f.db.runTransaction = callback => {
      f.db.state.orders[0] = { ...f.db.state.orders[0], paymentStatus,
        ...(paymentStatus === 'refunding' ? { refundStatus: 'processing', refundAmount: 100 } : {}) }
      return run(callback)
    }
    await f.expiry().expireUnacceptedOrder('order', structuredClone(f.db.state.orders[0]), time)
    assert.equal(f.db.state.orders[0].status, 'paid')
    assert.equal(f.db.state.orders[0].paymentStatus, paymentStatus)
    assert.equal(f.db.state.user_coupons[0].status, 'used')
    assert.equal(f.notices.length, 0)
  })
}

test('an unassigned group household still expires exactly two hours before its Beijing service time', async () => {
  const f = fixture(true)
  Object.assign(f.db.state.orders[0], { startTime: '2026-11-13 02:00', endTime: '2026-11-13 03:00' })
  const expires = f.expiry()
  const snapshot = structuredClone(f.db.state.orders[0])
  const early = new Date(time.getTime() - 1)
  assert.equal(expires.shouldExpireUnacceptedOrder(snapshot, early), false)
  assert.equal(expires.shouldExpireUnacceptedOrder(snapshot, time), true)
  await expires.expireUnacceptedOrder('order', snapshot, time)
  assert.equal(f.db.state.orders[0].paymentStatus, 'refunded')
  assert.equal(f.db.state.orders[0].refundedAmount, 100)
  assert.equal(f.db.state.orders[0].groupBuyStatus, 'cancelled')
  assert.equal(f.db.state.orders[0].expireReason, '服务开始前2小时无人接单，拼单自动作废')
  assert.equal(f.db.state.pet_playground_groups[0].status, 'cancelled')
  assert.equal(f.db.state.refunds.length, 1)
  await expires.expireUnacceptedOrder('order', structuredClone(f.db.state.orders[0]), time)
  assert.equal(f.db.state.refunds.length, 1)
  assert.equal(f.calls(), 1)
})

for (const failedNotice of ['appendOrderTimeline', 'appendOrderClientMessage']) {
  test(`group expiry refunds every household even when ${failedNotice} fails`, async () => {
    const f = fixture(true)
    f.db.state.orders.push({ ...f.db.state.orders[0], _id: 'sibling', clientOpenid: 'neighbor' })
    const expires = f.expiry({ [failedNotice]: async () => { throw new Error('notification store unavailable') } })
    await expires.expireUnacceptedOrder('order', structuredClone(f.db.state.orders[0]), time).catch(() => {})
    assert.equal(f.db.state.pet_playground_groups[0].status, 'cancelled')
    assert.ok(f.db.state.orders.every(order => order.paymentStatus === 'refunded' && order.refundedAmount === 100 && order.groupBuyStatus === 'cancelled'))
    assert.equal(f.db.state.refunds.length, 2)
    assert.equal(f.calls(), 2)
    assert.equal(f.notices.filter(value => value === 'subscription').length, 2)
    await expires.expireDueUnacceptedOrders()
    assert.equal(f.db.state.refunds.length, 2)
    assert.equal(f.calls(), 2)
  })
}
