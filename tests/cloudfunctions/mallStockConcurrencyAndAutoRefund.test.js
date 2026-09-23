const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const optimistic = require('./optimisticTransactions')

function createMallStockDb(extra = {}) {
  return createCollectionStore({
    users: [
      { _id: 'u_user_1', openid: 'openid_user_1', roles: ['client'], status: 'active', phone: '13800000001', nickname: '用户1' },
      { _id: 'u_user_2', openid: 'openid_user_2', roles: ['client'], status: 'active', phone: '13800000002', nickname: '用户2' }
    ],
    platform_configs: [
      { _id: 'cfg1', key: 'system_settings', value: { payment: { enabled: true, mode: 'mock', refundEnabled: true } } }
    ],
    mall_products: [
      {
        _id: 'prod_limited_1',
        name: '限量猫粮礼盒',
        status: 'on_sale',
        price: 100,
        originalPrice: 120,
        stock: 1,
        totalStock: 1,
        specMode: 'single',
        skus: [
          { skuId: 'default', name: '标准装', price: 100, stock: 1, status: 'on_sale' }
        ]
      }
    ],
    mall_orders: [],
    payments: [],
    refunds: [],
    finance_logs: [],
    payment_events: [],
    user_coupons: [],
    order_timeline: [],
    mall_carts: [],
    ...extra
  })
}

test('mall stock concurrency: concurrent order creation for last unit reserves stock atomically and rejects overselling', async () => {
  const db = createMallStockDb()
  optimistic(db)

  const fn1 = loadCloudFunction('api', db, 'openid_user_1')
  const fn2 = loadCloudFunction('api', db, 'openid_user_2')

  const shippingAddress = { contactName: '买家', contactPhone: '13800000000', serviceAddress: '测试小区', addressDetail: '1栋101' }

  // 两名用户高并发争抢仅剩 1 件的商品
  const [res1, res2] = await Promise.all([
    fn1.main({
      module: 'mall',
      action: 'createOrder',
      data: { productId: 'prod_limited_1', skuId: 'default', quantity: 1, shippingAddress }
    }),
    fn2.main({
      module: 'mall',
      action: 'createOrder',
      data: { productId: 'prod_limited_1', skuId: 'default', quantity: 1, shippingAddress }
    })
  ])

  const successCount = (res1.ok ? 1 : 0) + (res2.ok ? 1 : 0)
  const failCount = (!res1.ok ? 1 : 0) + (!res2.ok ? 1 : 0)

  assert.equal(successCount, 1, 'Exactly one concurrent order creation must succeed')
  assert.equal(failCount, 1, 'Competing order creation must be rejected immediately')

  const failed = !res1.ok ? res1 : res2
  assert.match(failed.message, /商品库存不足/, 'Rejected user must receive clear stock shortage prompt')

  // 验证商品库存严格扣为 0
  const product = db.state.mall_products.find((p) => p._id === 'prod_limited_1')
  assert.equal(product.stock, 0, 'Product stock must be decremented to 0')
  assert.equal(product.skus[0].stock, 0, 'SKU stock must be decremented to 0')

  // 验证仅创建了 1 个订单，且该订单包含 stockReserved 标志
  assert.equal(db.state.mall_orders.length, 1, 'Only 1 mall order record must be created')
  assert.equal(db.state.mall_orders[0].stockReserved, true, 'Created order must be marked as stockReserved')
})

test('mall stock reservation: unpaid order cancellation releases reserved stock back to product', async () => {
  const db = createMallStockDb()

  const fn1 = loadCloudFunction('api', db, 'openid_user_1')
  const fn2 = loadCloudFunction('api', db, 'openid_user_2')

  const shippingAddress = { contactName: '买家', contactPhone: '13800000000', serviceAddress: '测试小区', addressDetail: '1栋101' }

  // 用户 1 成功下单预占库存
  const orderRes = await fn1.main({
    module: 'mall',
    action: 'createOrder',
    data: { productId: 'prod_limited_1', skuId: 'default', quantity: 1, shippingAddress }
  })
  assert.equal(orderRes.ok, true)
  assert.equal(db.state.mall_products[0].stock, 0, 'Stock is reserved and decremented to 0')

  // 此时用户 2 下单应失败
  const blockedRes = await fn2.main({
    module: 'mall',
    action: 'createOrder',
    data: { productId: 'prod_limited_1', skuId: 'default', quantity: 1, shippingAddress }
  })
  assert.equal(blockedRes.ok, false)
  assert.match(blockedRes.message, /商品库存不足/)

  // 用户 1 主动取消订单
  const cancelRes = await fn1.main({
    module: 'mall',
    action: 'cancelOrder',
    data: { orderId: orderRes.data._id }
  })
  assert.equal(cancelRes.ok, true)
  assert.equal(db.state.mall_orders[0].status, 'cancelled')
  assert.equal(db.state.mall_orders[0].stockReserved, false)

  // 验证预占库存已被自动释放回补
  assert.equal(db.state.mall_products[0].stock, 1, 'Stock must be restored to 1 upon cancellation')
  assert.equal(db.state.mall_products[0].skus[0].stock, 1)

  // 释放后，用户 2 再次下单成功
  const retryOrderRes = await fn2.main({
    module: 'mall',
    action: 'createOrder',
    data: { productId: 'prod_limited_1', skuId: 'default', quantity: 1, shippingAddress }
  })
  assert.equal(retryOrderRes.ok, true)
  assert.equal(db.state.mall_products[0].stock, 0, 'Stock is reserved again by user 2')
})

test('mall payment callback: oversold payment with real transaction triggers auto refund instead of rolling back', async () => {
  // 模拟历史未预占库存订单、商品已被清空库存、微信已实扣款的极端超卖场景
  const item = { productId: 'prod_out_of_stock', skuId: 'default', name: '断货商品', quantity: 1, price: 99 }
  const db = createMallStockDb({
    mall_products: [
      {
        _id: 'prod_out_of_stock',
        name: '断货商品',
        status: 'on_sale',
        stock: 0, // 库存已为 0
        totalStock: 0,
        specMode: 'single',
        skus: [{ skuId: 'default', name: '标准装', price: 99, stock: 0, status: 'on_sale' }]
      }
    ],
    mall_orders: [
      {
        _id: 'mall_ord_oversold',
        clientOpenid: 'openid_user_1',
        clientUserId: 'u_user_1',
        orderType: 'mall',
        orderNo: 'MO202609230001',
        status: 'pending_pay',
        paymentStatus: 'unpaid',
        payAmount: 99,
        paymentNo: 'PAY_MOCK_123',
        stockReserved: false, // 未预占库存
        couponId: 'c_locked_1',
        items: [item]
      }
    ],
    user_coupons: [
      {
        _id: 'c_locked_1',
        openid: 'openid_user_1',
        status: 'locked',
        lockedOrderId: 'mall_ord_oversold'
      }
    ],
    payments: [
      {
        _id: 'pay_rec_1',
        orderId: 'mall_ord_oversold',
        paymentNo: 'PAY_MOCK_123',
        amount: 99,
        status: 'pending',
        channel: 'wechat'
      }
    ]
  })

  // 加载 context 并调用 settleOrderPayment
  const context = require('../../cloudfunctions/api/services/context')({ db })
  const result = await context.settleOrderPayment('mall_ord_oversold', {
    paymentNo: 'PAY_MOCK_123',
    channel: 'wechat',
    wxTransactionId: 'wx_trans_real_999888'
  })

  // 验证回调顺利返回，未阻断抛错
  assert.equal(result.changed, true)
  assert.equal(result.oversoldRefundRequired, true)

  // 验证订单状态已顺利发起退款，而非卡死在 pending_pay
  const orderAfter = db.state.mall_orders.find((o) => o._id === 'mall_ord_oversold')
  assert.equal(orderAfter.paymentStatus, 'refunding', 'Payment status must transition to refunding')
  assert.equal(orderAfter.refundStatus, 'processing', 'Refund status must be processing')
  assert.match(orderAfter.refundReason, /商品库存不足/)

  // 验证支付单被标记为成功，财务账目完全平齐
  const paymentAfter = db.state.payments.find((p) => p._id === 'pay_rec_1')
  assert.equal(paymentAfter.status, 'success')
  assert.equal(paymentAfter.wxTransactionId, 'wx_trans_real_999888')

  // 验证 finance_logs 记录了实收款
  const financeLog = db.state.finance_logs.find((f) => f.orderId === 'mall_ord_oversold')
  assert.ok(financeLog, 'Finance log must record paid amount')
  assert.equal(financeLog.amountDelta, 99)

  // 验证使用的优惠券被安全归还为 available
  const couponAfter = db.state.user_coupons.find((c) => c._id === 'c_locked_1')
  assert.equal(couponAfter.status, 'available', 'Coupon must be unlocked back to available')
  assert.equal(couponAfter.lockedOrderId, '')

  // 验证系统已自动创建全额原路退款单
  const refundRecord = db.state.refunds.find((r) => r.orderId === 'mall_ord_oversold')
  assert.ok(refundRecord, 'Refund record must be automatically generated')
  assert.equal(refundRecord.refundAmount, 99, 'Refund amount must be full order amount')
  assert.equal(refundRecord.source, 'system_auto_refund')
})
