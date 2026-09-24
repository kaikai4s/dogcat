const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createCollectionStore } = require('./helpers')
const createService = require('../../cloudfunctions/api/services/paymentSettlement')
const optimistic = require('./optimisticTransactions')

function setup(db) {
  return createService({ db, crypto, now: () => '2026-09-25T00:00:00.000Z' })
}

test('order database mock rejects missing document IDs like wx-server-sdk', () => {
  const db = createCollectionStore()
  assert.throws(() => db.collection('orders').doc(), /docId必须为字符串或数字/)
  assert.throws(() => db.collection('orders').doc({}), /docId必须为字符串或数字/)
})

for (const collectionName of ['orders', 'mall_orders']) {
  test(`${collectionName}: concurrent creations preserve both orders and their security records`, async () => {
    const db = createCollectionStore()
    optimistic(db)
    const service = setup(db)
    const creations = await Promise.all(['client1', 'client2'].map(openid => service.createOrderWithCouponLock({
      collectionName,
      openid,
      order: { clientOpenid: openid, status: 'pending_pay' },
      extraDocuments: collectionName === 'orders'
        ? [{ collection: 'order_home_security', data: { clientOpenid: openid } }]
        : []
    })))

    const results = creations.map(result => result.order)
    assert.equal(db.state[collectionName].length, 2)
    assert.notEqual(results[0]._id, results[1]._id)
    for (const result of results) {
      assert.equal(typeof result._id, 'string')
      assert.ok(result._id.length > 0)
      assert.equal(db.state[collectionName].find(row => row._id === result._id).clientOpenid, result.clientOpenid)
      if (collectionName === 'orders') {
        const records = db.state.order_home_security.filter(row => row.orderId === result._id)
        assert.equal(records.length, 1)
        assert.equal(records[0].clientOpenid, result.clientOpenid)
      }
    }
  })
}

test('order transaction retries keep IDs and coupon/security links stable', async () => {
  const db = createCollectionStore({ user_coupons: [{ _id: 'coupon1', openid: 'client1', status: 'available' }] })
  let firstAttempt
  db.runTransaction = async callback => {
    const discarded = createCollectionStore(structuredClone(db.state))
    const first = await callback(discarded)
    firstAttempt = { order: first.order, security: discarded.state.order_home_security }
    return callback(db)
  }
  const { order: result } = await setup(db).createOrderWithCouponLock({
    collectionName: 'orders',
    openid: 'client1',
    couponId: 'coupon1',
    order: { clientOpenid: 'client1', status: 'pending_pay' },
    extraDocuments: [
      { collection: 'order_home_security', data: { lockMethod: 'someone_home' } },
      { collection: 'order_home_security', _id: 'explicit_security_id', data: { lockMethod: 'key' } }
    ]
  })
  assert.equal(result._id, firstAttempt.order._id)
  assert.deepEqual(db.state.order_home_security, firstAttempt.security)
  assert.equal(db.state.orders.length, 1)
  assert.equal(db.state.user_coupons[0].lockedOrderId, result._id)
  assert.equal(db.state.user_coupons[0].status, 'locked')
  assert.ok(db.state.order_home_security.every(row => row.orderId === result._id))
  assert.ok(db.state.order_home_security.some(row => row._id === 'explicit_security_id'))
})
