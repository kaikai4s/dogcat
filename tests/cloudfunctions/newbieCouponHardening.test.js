const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

function setupTestDb(extra = {}) {
  return createCollectionStore({
    users: [
      {
        _id: 'u_newbie',
        openid: 'openid_newbie',
        nickname: '纯新用户',
        roles: ['client'],
        status: 'active'
      },
      {
        _id: 'u_old_service',
        openid: 'openid_old_service',
        nickname: '服务老客',
        roles: ['client'],
        status: 'active'
      },
      {
        _id: 'u_old_mall',
        openid: 'openid_old_mall',
        nickname: '商城老客',
        roles: ['client'],
        status: 'active'
      },
      {
        _id: 'u_cancelled_unpaid',
        openid: 'openid_cancelled_unpaid',
        nickname: '取消未付款用户',
        roles: ['client'],
        status: 'active'
      },
      {
        _id: 'u_refunded_order',
        openid: 'openid_refunded_order',
        nickname: '已退款老客',
        roles: ['client'],
        status: 'active'
      }
    ],
    coupon_templates: [
      {
        _id: 'tmpl_newbie_100',
        name: '新人立减100元专享券',
        type: 'fixed',
        usageScope: 'all',
        discountAmount: 100,
        minOrderAmount: 200,
        applicableServiceTypes: [],
        enabled: true,
        newbieOnly: true,
        perUserLimit: 1,
        totalIssueLimit: 1000,
        issuedCount: 0
      }
    ],
    user_coupons: [],
    orders: [
      {
        _id: 'order_service_completed',
        clientOpenid: 'openid_old_service',
        status: 'completed',
        paymentStatus: 'paid',
        payAmount: 150
      },
      {
        _id: 'order_cancelled_unpaid',
        clientOpenid: 'openid_cancelled_unpaid',
        status: 'cancelled',
        paymentStatus: 'closed',
        payAmount: 120
      },
      {
        _id: 'order_refunded_paid',
        clientOpenid: 'openid_refunded_order',
        status: 'cancelled',
        paymentStatus: 'paid',
        refundStatus: 'success',
        payAmount: 160
      }
    ],
    mall_orders: [
      {
        _id: 'mall_order_paid',
        clientOpenid: 'openid_old_mall',
        status: 'shipped',
        paymentStatus: 'paid',
        payAmount: 99
      }
    ],
    ...extra
  })
}

test('newbie coupon hardening: 纯新用户无任何有效订单可成功领取新人券', async () => {
  const db = setupTestDb()
  const fn = loadCloudFunction('api', db, 'openid_newbie')

  const res = await fn.main({
    module: 'coupon',
    action: 'claimNewbieCoupon',
    data: { templateId: 'tmpl_newbie_100' }
  })

  assert.equal(res.ok, true, '纯新用户领取新人券应成功')
  assert.equal(res.data.templateId, 'tmpl_newbie_100')
  assert.equal(res.data.status, 'available')

  const userCoupons = db.state.user_coupons.filter((c) => c.openid === 'openid_newbie')
  assert.equal(userCoupons.length, 1, '纯新用户领券后 user_coupons 中应有 1 条记录')
})

test('newbie coupon hardening: 有服务订单历史的老用户直接调用 claimNewbieCoupon 被拦截', async () => {
  const db = setupTestDb()
  const fn = loadCloudFunction('api', db, 'openid_old_service')

  const res = await fn.main({
    module: 'coupon',
    action: 'claimNewbieCoupon',
    data: { templateId: 'tmpl_newbie_100' }
  })

  assert.equal(res.ok, false, '存在服务订单老客领新人券应被拦截')
  assert.match(res.message, /新人专享券仅限未下单的新用户领取/)

  const userCoupons = db.state.user_coupons.filter((c) => c.openid === 'openid_old_service')
  assert.equal(userCoupons.length, 0, '被拦截的老客不应被发放任何优惠券')
})

test('newbie coupon hardening: 有商城订单历史的老用户直接调用 claimNewbieCoupon 被拦截', async () => {
  const db = setupTestDb()
  const fn = loadCloudFunction('api', db, 'openid_old_mall')

  const res = await fn.main({
    module: 'coupon',
    action: 'claimNewbieCoupon',
    data: { templateId: 'tmpl_newbie_100' }
  })

  assert.equal(res.ok, false, '存在商城订单老客领新人券应被拦截')
  assert.match(res.message, /新人专享券仅限未下单的新用户领取/)

  const userCoupons = db.state.user_coupons.filter((c) => c.openid === 'openid_old_mall')
  assert.equal(userCoupons.length, 0, '被拦截的老客不应被发放任何优惠券')
})

test('newbie coupon hardening: 仅有未支付已取消废单的用户不应被误伤，仍可领取新人券', async () => {
  const db = setupTestDb()
  const fn = loadCloudFunction('api', db, 'openid_cancelled_unpaid')

  const res = await fn.main({
    module: 'coupon',
    action: 'claimNewbieCoupon',
    data: { templateId: 'tmpl_newbie_100' }
  })

  assert.equal(res.ok, true, '仅有未付款取消废单的用户应能成功领取新人券')
  assert.equal(res.data.templateId, 'tmpl_newbie_100')
  assert.equal(res.data.status, 'available')
})

test('newbie coupon hardening: 曾付款后全额退款取消的用户被判定为老客，禁止领新人券套利', async () => {
  const db = setupTestDb()
  const fn = loadCloudFunction('api', db, 'openid_refunded_order')

  const res = await fn.main({
    module: 'coupon',
    action: 'claimNewbieCoupon',
    data: { templateId: 'tmpl_newbie_100' }
  })

  assert.equal(res.ok, false, '曾付款后退款的老客不可再次领新人券')
  assert.match(res.message, /新人专享券仅限未下单的新用户领取/)
})
