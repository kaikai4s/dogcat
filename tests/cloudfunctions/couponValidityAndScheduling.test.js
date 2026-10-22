const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createCoupons = require('../../cloudfunctions/api/services/coupons')
const createSchedulingTime = require('../../cloudfunctions/api/services/schedulingTime')

test('future coupons cannot discount service or mall pricing before their start time', () => {
  const service = createCoupons({ now: () => new Date('2026-10-22T02:00:00Z'), safeText: value => String(value || '') })
  const coupon = {
    _id: 'coupon', openid: 'client', status: 'available',
    validFrom: '2026-10-22T02:00:01Z', validTo: '2026-10-23T02:00:00Z',
    templateSnapshot: { usageScope: 'all', discountAmount: 20 }
  }
  for (const businessType of ['service', 'mall']) {
    assert.deepEqual(service.evaluateCoupon(coupon, { amount: 100, businessType, serviceTypes: ['walk'] }, 'client'), {
      applicable: false, reason: '优惠券尚未生效'
    })
    assert.equal(service.evaluateCoupon({ ...coupon, validFrom: '2026-10-22T02:00:00Z' }, { amount: 100, businessType, serviceTypes: ['walk'] }, 'client').applicable, true)
  }
})

test('future coupon cannot create a mall order or lock the coupon', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'user', openid: 'client', roles: ['client'], status: 'active', phone: '13800000001' }],
    user_coupons: [{ _id: 'coupon', openid: 'client', status: 'available', validFrom: '2099-01-01T00:00:00Z', validTo: '2099-12-31T00:00:00Z', templateSnapshot: { usageScope: 'all', discountAmount: 20 } }],
    mall_products: [{ _id: 'product', name: '狗粮', status: 'on_sale', specMode: 'single', price: 100, stock: 5, skus: [{ skuId: 'default', price: 100, stock: 5, status: 'on_sale' }] }]
  })
  const api = loadCloudFunction('api', db, 'client')
  const result = await api.main({ module: 'mall', action: 'createOrder', data: {
    productId: 'product', skuId: 'default', quantity: 1, couponId: 'coupon',
    shippingAddress: { contactName: '测试', contactPhone: '13800000001', serviceAddress: '测试小区', addressDetail: '101室' }
  } })
  assert.equal(result.ok, false)
  assert.equal(result.message, '优惠券尚未生效')
  assert.equal((db.state.mall_orders || []).length, 0)
  assert.equal(db.state.user_coupons[0].status, 'available')
})

test('scheduling rejects impossible calendar dates and clock values instead of rolling them forward', () => {
  const service = createSchedulingTime({})
  for (const value of ['2099-02-29 10:00', '2099-04-31 10:00', '2099-00-01 10:00', '2099-13-01 10:00', '2099-01-00 10:00', '2099-01-01 24:00', '2099-01-01 10:60', '2099-01-01 10:00:60', '2099-02-29T10:00:00Z']) {
    assert.equal(service.parseDateTimeParts(value), null, value)
    assert.equal(service.getDateKeyFromTime(value), '', value)
  }
  assert.equal(service.parseDateTimeParts('2096-02-29 10:00').dateObj.toISOString(), '2096-02-29T02:00:00.000Z')
})

test('scheduling respects explicit offsets and treats unzoned date times as Beijing in all server timezones', () => {
  const script = `
    const assert = require('node:assert/strict');
    const service = require('./cloudfunctions/api/services/schedulingTime')({});
    for (const value of ['2099-01-01 10:00', '2099-01-01T10:00:00', '2099/1/1 10:00', '2099-01-01 02:00:00Z', '2099-01-01T02:00:00Z', '2099-01-01 03:00:00+01:00']) {
      const parts = service.parseDateTimeParts(value);
      assert.equal(parts.dateObj.toISOString(), '2099-01-01T02:00:00.000Z', value);
      assert.equal(parts.hour, 10, value);
    }
  `
  for (const TZ of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles']) {
    execFileSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '../..'), env: { ...process.env, TZ } })
  }
})
