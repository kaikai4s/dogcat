const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')

test('1. mall oversold: auto refund failure tags order oversoldRefundFailed and notifies admins', async () => {
  const item = { productId: 'prod_out_of_stock', skuId: 'default', name: '断货商品', quantity: 1, price: 99 }
  const db = createCollectionStore({
    mall_products: [
      {
        _id: 'prod_out_of_stock',
        name: '断货商品',
        status: 'on_sale',
        stock: 0,
        totalStock: 0,
        specMode: 'single',
        skus: [{ skuId: 'default', name: '标准装', price: 99, stock: 0, status: 'on_sale' }]
      }
    ],
    mall_orders: [
      {
        _id: 'mall_ord_fail_test',
        clientOpenid: 'openid_user_fail',
        clientUserId: 'u_user_fail',
        orderType: 'mall',
        orderNo: 'MO_FAIL_001',
        status: 'pending_pay',
        paymentStatus: 'unpaid',
        payAmount: 99,
        paymentNo: 'PAY_FAIL_123',
        stockReserved: false,
        items: [item]
      }
    ],
    payments: [
      {
        _id: 'pay_fail_1',
        orderId: 'mall_ord_fail_test',
        paymentNo: 'PAY_FAIL_123',
        amount: 99,
        status: 'pending',
        channel: 'wechat'
      }
    ],
    user_coupons: [],
    finance_logs: [],
    payment_events: [],
    refunds: [],
    admin_notifications: []
  })

  // 创建 context
  const context = require('../../cloudfunctions/api/services/context')({ db })

  // 模拟 requestOrderRefund 在第三方退款通道故障时抛出异常
  const originalRefund = context.requestOrderRefund
  context.requestOrderRefund = async () => {
    throw new Error('微信商户基本账户余额不足无法完成退款')
  }

  const result = await context.settleOrderPayment('mall_ord_fail_test', {
    paymentNo: 'PAY_FAIL_123',
    channel: 'wechat',
    wxTransactionId: 'wx_trans_real_fail_1'
  })

  // 结算回调不卡死，正常返回
  assert.equal(result.changed, true)
  assert.equal(result.oversoldRefundRequired, true)

  // 订单被打上 oversoldRefundFailed: true 与错误详情
  const orderAfter = db.state.mall_orders.find(o => o._id === 'mall_ord_fail_test')
  assert.equal(orderAfter.oversoldRefundFailed, true)
  assert.match(orderAfter.oversoldRefundError, /微信商户基本账户余额不足/)
  assert.ok(orderAfter.oversoldRefundFailedAt)

  // 管理后台通知中收到紧急预警
  const notice = db.state.admin_notifications.find(n => n.type === 'oversold_refund_failed' && n.orderId === 'mall_ord_fail_test')
  assert.ok(notice, 'Admin notification must be generated for failed oversold refund')
  assert.equal(notice.level, 'urgent')
  assert.match(notice.content, /微信商户基本账户余额不足/)

  // 恢复原始方法
  context.requestOrderRefund = originalRefund
})

test('2. scheduled reconcile: automatically retries oversoldRefundFailed orders and clears flag on success', async () => {
  const item = { productId: 'prod_retry', skuId: 'default', name: '断货商品2', quantity: 1, price: 88 }
  const db = createCollectionStore({
    mall_products: [
      {
        _id: 'prod_retry',
        name: '断货商品2',
        status: 'on_sale',
        stock: 0,
        totalStock: 0,
        specMode: 'single',
        skus: [{ skuId: 'default', name: '标准装', price: 88, stock: 0, status: 'on_sale' }]
      }
    ],
    mall_orders: [
      {
        _id: 'mall_ord_retry_test',
        clientOpenid: 'openid_user_retry',
        clientUserId: 'u_user_retry',
        orderType: 'mall',
        orderNo: 'MO_RETRY_001',
        status: 'refund_applied',
        paymentStatus: 'paid',
        refundStatus: 'applied',
        refundReason: '商品库存不足，系统自动全额退款',
        payAmount: 88,
        refundAmount: 88,
        paymentNo: 'PAY_RETRY_123',
        wxTransactionId: 'wx_trans_retry_1',
        oversoldRefundFailed: true,
        oversoldRefundError: '网络超时',
        oversoldRefundFailedAt: new Date(Date.now() - 3600000),
        items: [item]
      }
    ],
    payments: [
      {
        _id: 'pay_retry_1',
        orderId: 'mall_ord_retry_test',
        paymentNo: 'PAY_RETRY_123',
        amount: 88,
        status: 'success',
        channel: 'wechat'
      }
    ],
    user_coupons: [],
    finance_logs: [],
    payment_events: [],
    refunds: [],
    admin_notifications: []
  })

  const context = require('../../cloudfunctions/api/services/context')({ db })

  // 执行定时对账补偿任务
  await context.reconcilePendingRefunds()

  // 验证订单已成功发起退款，且 oversoldRefundFailed 标记被清理为 false
  const orderAfter = db.state.mall_orders.find(o => o._id === 'mall_ord_retry_test')
  assert.equal(orderAfter.oversoldRefundFailed, false, 'oversoldRefundFailed must be cleared to false')
  assert.ok(orderAfter.oversoldRefundRecoveredAt, 'Must record oversoldRefundRecoveredAt timestamp')
  assert.equal(orderAfter.paymentStatus, 'refunding')
  assert.equal(orderAfter.refundStatus, 'processing')

  // 验证 refunds 记录已创建
  const refund = db.state.refunds.find(r => r.orderId === 'mall_ord_retry_test')
  assert.ok(refund, 'Refund record must be created by scheduled reconcile')
  assert.equal(refund.refundAmount, 88)
  assert.equal(refund.source, 'system_auto_refund')
})
