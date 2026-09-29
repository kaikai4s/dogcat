const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('restoreOrderCoupon sets status to expired if coupon validTo is in the past', async () => {
  const openid = 'openid_client_expired_coupon'
  const orderId = 'order_expired_coupon_refund'
  const couponId = 'coupon_past_expiry'

  const db = createCollectionStore({
    users: [{ _id: 'u_1', openid, roles: ['client'], activeRole: 'client', status: 'active' }],
    user_coupons: [
      {
        _id: couponId,
        openid,
        templateId: 'tpl_1',
        name: '已过期满减券',
        discountAmount: 20,
        minOrderAmount: 100,
        status: 'used',
        usedOrderId: orderId,
        usedAt: '2026-08-01 10:00:00',
        validTo: '2026-08-15 23:59:59' // 过去时间已过期
      },
      {
        _id: 'coupon_valid',
        openid,
        templateId: 'tpl_2',
        name: '有效满减券',
        discountAmount: 20,
        minOrderAmount: 100,
        status: 'used',
        usedOrderId: 'order_valid_coupon',
        usedAt: '2026-09-01 10:00:00',
        validTo: '2099-12-31 23:59:59' // 未过期
      }
    ],
    orders: [
      {
        _id: orderId,
        orderNo: 'ORD_EXP_COUPON',
        clientOpenid: openid,
        status: 'assigned',
        paymentStatus: 'paid',
        paymentNo: 'PAY_EXP_1',
        amount: 100,
        discountAmount: 20,
        payAmount: 80,
        couponId,
        startTime: '2099-10-01 10:00',
        createdAt: '2026-08-01 09:00:00'
      },
      {
        _id: 'order_valid_coupon',
        orderNo: 'ORD_VALID_COUPON',
        clientOpenid: openid,
        status: 'assigned',
        paymentStatus: 'paid',
        paymentNo: 'PAY_VALID_1',
        amount: 100,
        discountAmount: 20,
        payAmount: 80,
        couponId: 'coupon_valid',
        startTime: '2099-10-01 10:00',
        createdAt: '2026-09-01 09:00:00'
      }
    ],
    refunds: [],
    payment_events: [],
    order_timeline: []
  })

  const fn = loadCloudFunction('api', db, openid)

  // 1. 取消已过期优惠券的订单 -> 优惠券状态应变为 expired，不可重新使用
  const res1 = await fn.main({
    module: 'order',
    action: 'cancelOrder',
    data: { orderId, reason: '取消退款' }
  })
  assert.equal(res1.ok, true)
  const expiredCoupon = db.state.user_coupons.find(c => c._id === couponId)
  assert.equal(expiredCoupon.status, 'expired', '过期优惠券退还后状态必须为 expired，杜绝违规复活')
  assert.equal(expiredCoupon.usedOrderId, '')
  assert.equal(expiredCoupon.refundedFromOrderId, orderId)

  // 2. 取消未过期优惠券的订单 -> 优惠券状态正常恢复为 available
  const res2 = await fn.main({
    module: 'order',
    action: 'cancelOrder',
    data: { orderId: 'order_valid_coupon', reason: '取消退款' }
  })
  assert.equal(res2.ok, true)
  const validCoupon = db.state.user_coupons.find(c => c._id === 'coupon_valid')
  assert.equal(validCoupon.status, 'available', '未过期优惠券退还后恢复为 available')
})

test('sendSubscribeMessage records isQuotaExhausted when error code is 43101', async () => {
  const db = createCollectionStore({
    platform_configs: [{
      _id: 'cfg1',
      key: 'system_settings',
      value: {
        subscription: {
          enabled: true,
          templates: { orderAccepted: 'tmpl_order_accepted' }
        }
      }
    }],
    subscription_logs: []
  })

  // 模拟微信 openapi 返回 43101（用户未授权或配额耗尽）
  const cloudOverrides = {
    openapi: {
      subscribeMessage: {
        send: async () => {
          const err = new Error('user refuse to accept the msg rid: 66a1b2c3')
          err.errCode = 43101
          throw err
        }
      }
    }
  }

  const createContext = require('../../cloudfunctions/api/services/context')
  const ctx = createContext({
    db,
    cloud: cloudOverrides,
    now: () => new Date('2026-09-29T10:00:00Z')
  })

  const result = await ctx.sendSubscribeMessage('openid_test_sub', 'orderAccepted', 'pages/index', { thing1: { value: '测试' } }, 'order_sub_1')

  assert.ok(['queued', 'failed'].includes(result.status))

  const log = db.state.subscription_logs.find(l => l.orderId === 'order_sub_1' && l.status === 'failed')
  assert.ok(log)
  assert.equal(log.status, 'failed')
  assert.equal(log.isQuotaExhausted, true)
  assert.equal(log.code, 43101)
})
