const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const optimistic = require('./optimisticTransactions')
const createCancellation = require('../../cloudfunctions/api/scheduled/cancelUnpaidOrders')
const createDeadline = require('../../cloudfunctions/api/services/paymentDeadline')
const time = require('../../cloudfunctions/api/utils/time')

const clock = new Date('2026-11-11T16:00:00Z')
function fixture(group = false, overrides = {}) {
  const db = createCollectionStore({ orders: [{ _id: 'order', clientOpenid: 'client', status: 'pending_pay', paymentStatus: 'unpaid',
    createdAt: '2026-11-11 23:30:00', payAmount: 10, couponId: 'coupon', ...(group ? { groupBuyId: 'group', source: 'community_groupbuy' } : {}) }],
    user_coupons: [{ _id: 'coupon', status: 'locked', lockedOrderId: 'order' }],
    pet_playground_groups: group ? [{ _id: 'group', status: 'recruiting', formedAt: 0, deadline: clock.getTime() + 3600000,
      members: [{ orderId: 'order', openid: 'client' }], rules: { minHouseholds: 2 } }] : [] })
  optimistic(db)
  const notices = []
  const context = { db, ORDER_STATUS: { PENDING_PAY: 'pending_pay' }, now: () => clock,
    ...createDeadline({ ...time, now: () => clock }), couponDisplayStatus: coupon => coupon.status,
    notifyOrder: async (openid, key, order, detail, role, deliveryKey) => {
      assert.equal(db.state.orders[0].status, 'cancelled')
      assert.equal(db.state.user_coupons[0].status, 'available')
      notices.push({ openid, key, order, detail, role, deliveryKey })
      return { status: 'sent' }
    }, ...overrides }
  return { db, notices, context, ...createCancellation(context) }
}

for (const group of [false, true]) {
  test(`unpaid timeout at Beijing midnight runs post-commit notification and group cleanup (${group})`, async () => {
    const f = fixture(group)
    assert.deepEqual(await f.cancelUnpaidOrders(), ['order'])
    assert.equal(f.notices.length, 1)
    assert.equal(f.notices[0].detail.refundAmount, 0)
    assert.equal(f.notices[0].detail.cancelledAt.getTime(), clock.getTime())
    assert.equal(f.notices[0].deliveryKey, 'order_cancelled:unpaid:order')
    if (group) assert.equal(f.db.state.pet_playground_groups[0].status, 'cancelled')
    assert.deepEqual(await f.cancelUnpaidOrders(), [])
    assert.equal(f.notices.length, 1)
  })
}

test('notification failure cannot undo a committed unpaid cancellation or its group cleanup', async () => {
  let attempts = 0
  const f = fixture(true, { notifyOrder: async () => { attempts++; throw new Error('notification unavailable') } })
  assert.deepEqual(await f.cancelUnpaidOrders(), ['order'])
  assert.equal(attempts, 1)
  assert.equal(f.db.state.orders[0].status, 'cancelled')
  assert.equal(f.db.state.user_coupons[0].status, 'available')
  assert.equal(f.db.state.pet_playground_groups[0].status, 'cancelled')
})

test('concurrent manual unpaid cancellations notify once with the client reason after committing', async () => {
  const f = fixture(true)
  const snapshot = structuredClone(f.db.state.orders[0])
  const results = await Promise.all([1, 2].map(() => f.cancelUnpaidOrder(snapshot, { reason: '客户改期', actorRole: 'client' })))
  assert.deepEqual(results.sort(), [false, true])
  assert.equal(f.notices.length, 1)
  assert.equal(f.notices[0].detail.cancelReason, '客户改期')
  assert.equal(f.db.state.pet_playground_groups[0].status, 'cancelled')
  assert.equal(f.db.state.order_timeline.length, 1)
})

test('an unexpired order and a concurrent payment do not trigger cancellation notifications or group cleanup', async () => {
  const f = fixture(true, { now: () => new Date(clock.getTime() - 1) })
  assert.deepEqual(await f.cancelUnpaidOrders(), [])
  assert.equal(f.notices.length, 0)
  const run = f.db.runTransaction
  f.db.runTransaction = callback => {
    f.db.state.orders[0] = { ...f.db.state.orders[0], status: 'paid', paymentStatus: 'paid' }
    return run(callback)
  }
  assert.equal(await f.cancelUnpaidOrder(structuredClone(f.db.state.orders[0])), false)
  assert.equal(f.notices.length, 0)
  assert.equal(f.db.state.pet_playground_groups[0].status, 'recruiting')
  assert.equal(f.db.state.user_coupons[0].status, 'locked')
})
