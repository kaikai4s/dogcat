const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createCollectionStore } = require('./helpers')
const optimistic = require('./optimisticTransactions')
const createSettlement = require('../../cloudfunctions/api/services/paymentSettlement')
const createCoupons = require('../../cloudfunctions/api/services/coupons')
const createIssuance = require('../../cloudfunctions/api/services/couponIssuance')

const clock = new Date('2026-11-11T16:30:00Z') // Beijing Nov 12, 00:30.
function fixture(collectionName, couponPatch = {}) {
  let moment = clock
  const coupon = { _id: 'coupon', openid: 'client', status: 'available',
    validFrom: '2026-11-11 23:00:00', validTo: '2026-11-12 01:00:00', ...couponPatch }
  const db = createCollectionStore({ user_coupons: [coupon], mall_products: [
    { _id: 'product', name: 'test', status: 'on_sale', stock: 2, specMode: 'single',
      skus: [{ skuId: 'default', stock: 2, status: 'on_sale', price: 100 }] }
  ] })
  optimistic(db)
  const now = () => moment
  const service = createSettlement({ db, crypto, now, normalizeMallProduct: value => structuredClone(value) })
  const order = { clientRequestId: 'request', clientOpenid: 'client', status: 'pending_pay', paymentStatus: 'unpaid',
    payAmount: 80, amount: 100, discountAmount: 20, couponId: 'coupon',
    ...(collectionName === 'mall_orders' ? { items: [{ productId: 'product', skuId: 'default', quantity: 1 }] } : {}) }
  const create = () => service.createOrderWithCouponLock({ collectionName, order, couponId: 'coupon', openid: 'client' })
  return { db, create, now, setTime: value => { moment = value } }
}

for (const collectionName of ['orders', 'mall_orders']) {
  for (const [label, patch, error] of [
    ['expired Beijing text', { validTo: '2026-11-12 00:00:00' }, /过期/],
    ['future activation', { validFrom: '2026-11-12 00:31:00' }, /未生效/],
    ['invalid start', { validFrom: 'invalid' }, /有效期/],
    ['invalid end', { validTo: '2026-02-30 12:00:00' }, /有效期/]
  ]) {
    test(`${collectionName}: coupon lock rejects ${label} without creating an order or reserving stock`, async () => {
      const f = fixture(collectionName, patch)
      await assert.rejects(f.create(), error)
      assert.equal((f.db.state[collectionName] || []).length, 0)
      assert.equal(f.db.state.user_coupons[0].status, 'available')
      assert.equal(f.db.state.mall_products[0].stock, 2)
      assert.equal(f.db.state.mall_products[0].skus[0].stock, 2)
    })
  }

  test(`${collectionName}: exact Beijing activation and expiry instants remain usable`, async () => {
    const f = fixture(collectionName, { validFrom: '2026-11-12 00:30:00', validTo: clock.toISOString() })
    const result = await f.create()
    assert.equal(result.created, true)
    assert.equal(result.order.payAmount, 80)
    assert.equal(f.db.state.user_coupons[0].lockedOrderId, result.order._id)
    assert.equal(f.db.state.mall_products[0].stock, collectionName === 'mall_orders' ? 1 : 2)
  })

  test(`${collectionName}: transaction delay beyond coupon expiry cannot freeze a stale quote`, async () => {
    const f = fixture(collectionName, { validTo: clock })
    const run = f.db.runTransaction
    f.db.runTransaction = callback => {
      f.setTime(new Date(clock.getTime() + 1))
      return run(callback)
    }
    await assert.rejects(f.create(), /过期/)
    assert.equal((f.db.state[collectionName] || []).length, 0)
    assert.equal(f.db.state.user_coupons[0].status, 'available')
    assert.equal(f.db.state.mall_products[0].stock, 2)
  })
}

test('fixed-range coupons include the last millisecond of the final Beijing day', () => {
  const coupons = createCoupons({ now: () => clock, safeText: value => String(value || '') })
  const issuance = createIssuance({ normalizeCouponSnapshot: coupons.normalizeCouponSnapshot, now: () => clock })
  const range = issuance.getCouponValidRange({ validType: 'fixed_range', validFromFixed: '2026-11-11', validToFixed: '2026-11-11' })
  assert.equal(range.validFrom.toISOString(), '2026-11-10T16:00:00.000Z')
  assert.equal(range.validTo.toISOString(), '2026-11-11T15:59:59.999Z')
  assert.equal(coupons.couponDisplayStatus({ status: 'available', ...range }, new Date('2026-11-11T15:59:59.999Z')), 'available')
  assert.equal(coupons.couponDisplayStatus({ status: 'available', ...range }, new Date('2026-11-11T16:00:00Z')), 'expired')
})
