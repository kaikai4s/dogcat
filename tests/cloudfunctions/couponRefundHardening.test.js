const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('1. paid order full refund on cancellation restores used coupon to available', async () => {
  const openid = 'openid_client_coupon_cancel'
  const time = '2026-09-24 10:00:00'
  const couponId = 'coupon_used_1'
  const orderId = 'order_paid_coupon_1'

  const db = createCollectionStore({
    users: [{ _id: 'u_1', openid, roles: ['client'], activeRole: 'client', status: 'active' }],
    user_coupons: [
      {
        _id: couponId,
        openid,
        templateId: 'tpl_1',
        name: '满100减20券',
        discountAmount: 20,
        minOrderAmount: 100,
        status: 'used',
        usedOrderId: orderId,
        usedAt: time,
        validTo: '2026-12-31 23:59:59'
      }
    ],
    orders: [
      {
        _id: orderId,
        orderNo: 'ORD_COUPON_1',
        clientOpenid: openid,
        status: 'assigned',
        paymentStatus: 'paid',
        paymentNo: 'PAY_1',
        amount: 100,
        discountAmount: 20,
        payAmount: 80,
        couponId,
        startTime: '2026-10-01 10:00', // 远期订单，取消可全额退款
        createdAt: time
      }
    ],
    refunds: [],
    payment_events: [],
    order_timeline: []
  })

  const fn = loadCloudFunction('api', db, openid)
  const res = await fn.main({
    module: 'order',
    action: 'cancelOrder',
    data: { orderId, reason: '计划有变取消' }
  })

  assert.equal(res.ok, true)
  assert.equal(res.data.status, 'cancelled')
  assert.equal(res.data.refundAmount, 80)

  // 验证优惠券状态已恢复为 available，且清空了使用记录
  const coupon = db.state.user_coupons.find((c) => c._id === couponId)
  assert.equal(coupon.status, 'available', '全额取消退款后，优惠券应恢复为 available')
  assert.equal(coupon.usedOrderId, '', '应清空 usedOrderId')
  assert.equal(coupon.usedAt, null, '应清空 usedAt')
  assert.equal(coupon.refundedFromOrderId, orderId, '应记录退还来源订单 ID')
})

test('2. unaccepted order expiration full refund restores used coupon to available', async () => {
  const openid = 'openid_client_expire_coupon'
  const time = '2026-09-24 10:00:00'
  const couponId = 'coupon_used_expire'
  const orderId = 'order_expire_1'

  const db = createCollectionStore({
    users: [{ _id: 'u_2', openid, roles: ['client'], activeRole: 'client', status: 'active' }],
    user_coupons: [
      {
        _id: couponId,
        openid,
        templateId: 'tpl_2',
        name: '满50减10券',
        discountAmount: 10,
        minOrderAmount: 50,
        status: 'used',
        usedOrderId: orderId,
        usedAt: time,
        validTo: '2026-12-31 23:59:59'
      }
    ],
    orders: [
      {
        _id: orderId,
        orderNo: 'ORD_EXPIRE_1',
        clientOpenid: openid,
        staffOpenid: '', // 无人接单
        status: 'paid',
        paymentStatus: 'paid',
        paymentNo: 'PAY_EXPIRE_1',
        amount: 50,
        discountAmount: 10,
        payAmount: 40,
        couponId,
        startTime: '2026-09-20 09:00', // 已过服务开始时间
        createdAt: '2026-09-20 08:00:00'
      }
    ],
    refunds: [],
    payment_events: [],
    order_timeline: []
  })

  const createContext = require('../../cloudfunctions/api/services/context')
  const ctx = createContext({ db, cloud: {}, now: () => new Date('2026-09-24T10:00:00Z') })

  // 触发无人接单超时处理
  await ctx.expireDueUnacceptedOrders()

  // 验证订单已过期并全额退款
  const order = db.state.orders.find((o) => o._id === orderId)
  assert.equal(order.status, 'expired')
  assert.equal(order.refundAmount, 40)

  // 验证优惠券已恢复
  const coupon = db.state.user_coupons.find((c) => c._id === couponId)
  assert.equal(coupon.status, 'available', '超时未接单自动全额退款后，优惠券应恢复为 available')
  assert.equal(coupon.usedOrderId, '', '应清空 usedOrderId')
  assert.equal(coupon.usedAt, null, '应清空 usedAt')
})

test('3. zero-yuan order (100% coupon discount) cancellation restores coupon', async () => {
  const openid = 'openid_zero_yuan'
  const time = '2026-09-24 10:00:00'
  const couponId = 'coupon_zero_yuan'
  const orderId = 'order_zero_yuan_1'

  const db = createCollectionStore({
    users: [{ _id: 'u_3', openid, roles: ['client'], activeRole: 'client', status: 'active' }],
    user_coupons: [
      {
        _id: couponId,
        openid,
        name: '新人免单券',
        discountAmount: 50,
        status: 'used',
        usedOrderId: orderId,
        usedAt: time,
        validTo: '2026-12-31 23:59:59'
      }
    ],
    orders: [
      {
        _id: orderId,
        orderNo: 'ORD_ZERO_1',
        clientOpenid: openid,
        status: 'assigned',
        paymentStatus: 'paid',
        paymentNo: 'FREE_ORDER',
        amount: 50,
        discountAmount: 50,
        payAmount: 0, // 0 元单
        couponId,
        startTime: '2026-10-01 10:00',
        createdAt: time
      }
    ],
    refunds: [],
    order_timeline: []
  })

  const fn = loadCloudFunction('api', db, openid)
  const res = await fn.main({
    module: 'order',
    action: 'cancelOrder',
    data: { orderId, reason: '取消0元免单订单' }
  })

  assert.equal(res.ok, true)
  assert.equal(res.data.status, 'cancelled')

  // 验证 0 元单取消也能成功恢复优惠券
  const coupon = db.state.user_coupons.find((c) => c._id === couponId)
  assert.equal(coupon.status, 'available', '0元单全额取消后，优惠券应恢复为 available')
  assert.equal(coupon.usedOrderId, '')
})

test('4. partial refund cancellation does NOT restore coupon', async () => {
  const openid = 'openid_client_partial'
  const time = '2026-09-24 10:00:00'
  const couponId = 'coupon_partial_keep_used'
  const orderId = 'order_partial_1'

  const db = createCollectionStore({
    users: [{ _id: 'u_4', openid, roles: ['client'], activeRole: 'client', status: 'active' }],
    user_coupons: [
      {
        _id: couponId,
        openid,
        name: '满100减20券',
        discountAmount: 20,
        status: 'used',
        usedOrderId: orderId,
        usedAt: time,
        validTo: '2026-12-31 23:59:59'
      }
    ],
    orders: [
      {
        _id: orderId,
        orderNo: 'ORD_PARTIAL_1',
        clientOpenid: openid,
        status: 'assigned',
        paymentStatus: 'paid',
        paymentNo: 'PAY_PARTIAL_1',
        amount: 100,
        discountAmount: 20,
        payAmount: 80,
        couponId,
        // 服务即将在 1 小时内开始，按取消规则扣除违约金（部分退款）
        startTime: '2026-09-24 10:30',
        createdAt: '2026-09-24 08:00:00'
      }
    ],
    refunds: [],
    payment_events: [],
    order_timeline: []
  })

  const fn = loadCloudFunction('api', db, openid)
  const res = await fn.main({
    module: 'order',
    action: 'cancelOrder',
    data: { orderId, reason: '临近服务取消' }
  })

  assert.equal(res.ok, true)
  assert.equal(res.data.status, 'cancelled')
  // 确认属于部分退款
  assert.ok(res.data.refundAmount < 80, '临近服务取消为扣费部分退款')

  // 验证优惠券依然为 used，不得恢复
  const coupon = db.state.user_coupons.find((c) => c._id === couponId)
  assert.equal(coupon.status, 'used', '非全额退款情况下，优惠券不得恢复')
})
