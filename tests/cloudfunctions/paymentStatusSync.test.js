const test = require('node:test')
const assert = require('node:assert/strict')

const createPaymentHandler = require('../../cloudfunctions/api/handlers/payment')

test('getPaymentStatus queries WeChat and marks order paid when callback has not arrived', async () => {
  const order = {
    _id: 'order_sync_paid',
    clientOpenid: 'client_openid',
    status: 'pending_pay',
    paymentStatus: 'paying',
    paymentNo: 'P202610120001',
    payAmount: 12.34
  }
  const payments = [{
    _id: 'payment_sync_paid',
    orderId: order._id,
    paymentNo: order.paymentNo,
    amount: 12.34,
    channel: 'wechat',
    status: 'pending'
  }]
  const events = []

  const handler = createPaymentHandler({
    ORDER_STATUS: { PAID: 'paid' },
    requireClientPayableOrder: async (openid, orderId) => {
      assert.equal(openid, 'client_openid')
      assert.equal(orderId, order._id)
      return { order }
    },
    readScopedDocuments: async () => payments,
    getSystemSettings: async () => ({ payment: { appId: 'wx_app', mchId: 'mch_1', notifyUrl: 'https://example.com/pay', certSerialNo: 'serial', apiV3Key: '12345678901234567890123456789012', privateKey: 'key' } }),
    getWechatPayConfig: () => ({ appId: 'wx_app', mchId: 'mch_1' }),
    wechatPayRequest: async (method, path) => {
      assert.equal(method, 'GET')
      assert.equal(path, '/v3/pay/transactions/out-trade-no/P202610120001?mchid=mch_1')
      return {
        appid: 'wx_app',
        mchid: 'mch_1',
        out_trade_no: order.paymentNo,
        trade_state: 'SUCCESS',
        transaction_id: 'wx_tx_1',
        amount: { total: 1234 }
      }
    },
    appendPaymentEvent: async (type, payload) => events.push({ type, payload }),
    sanitizeWechatPayload: payload => payload,
    validatePaymentCallbackPayload: (payload, currentOrder, payment, config) => {
      assert.equal(payload.out_trade_no, payment.paymentNo)
      assert.equal(payload.amount.total, 1234)
      assert.equal(currentOrder.payAmount, 12.34)
      assert.equal(config.mchId, 'mch_1')
    },
    markOrderPaid: async (orderId, payload) => {
      assert.equal(orderId, order._id)
      assert.equal(payload.paymentNo, order.paymentNo)
      assert.equal(payload.wxTransactionId, 'wx_tx_1')
      order.status = 'paid'
      order.paymentStatus = 'paid'
      order.paidAt = '2026-10-12 12:00:00'
      payments[0].status = 'success'
      payments[0].paidAt = order.paidAt
    },
    getPayableOrder: async () => ({ order })
  })

  const result = await handler('client_openid', 'getPaymentStatus', { orderId: order._id })

  assert.equal(result.status, 'paid')
  assert.equal(result.paymentStatus, 'paid')
  assert.equal(result.paidAt, '2026-10-12 12:00:00')
  assert.equal(result.payments[0].status, 'success')
  assert.equal(events[0].type, 'query')
})

test('getPaymentStatus synchronizes mall order and updates status to pending_ship and paymentStatus to paid', async () => {
  const order = {
    _id: 'mall_order_sync_1',
    clientOpenid: 'client_openid',
    status: 'pending_pay',
    paymentStatus: 'unpaid',
    paymentNo: 'P202610150001',
    payAmount: 88.00,
    items: [{ productId: 'p1', skuId: 'sku1', name: '猫粮', quantity: 1, price: 88 }]
  }
  const payments = [{
    _id: 'pay_rec_1',
    orderId: order._id,
    paymentNo: order.paymentNo,
    amount: 88.00,
    channel: 'wechat',
    status: 'pending'
  }]
  const events = []

  const handler = createPaymentHandler({
    ORDER_STATUS: { PAID: 'paid' },
    requireClientPayableOrder: async (openid, orderId) => {
      assert.equal(openid, 'client_openid')
      assert.equal(orderId, order._id)
      return { order, orderType: 'mall' }
    },
    readScopedDocuments: async () => payments,
    getSystemSettings: async () => ({ payment: { appId: 'wx_app', mchId: 'mch_1', notifyUrl: 'https://example.com/pay', certSerialNo: 'serial', apiV3Key: '12345678901234567890123456789012', privateKey: 'key' } }),
    getWechatPayConfig: () => ({ appId: 'wx_app', mchId: 'mch_1' }),
    wechatPayRequest: async (method, path) => {
      assert.equal(method, 'GET')
      assert.equal(path, '/v3/pay/transactions/out-trade-no/P202610150001?mchid=mch_1')
      return {
        appid: 'wx_app',
        mchid: 'mch_1',
        out_trade_no: order.paymentNo,
        trade_state: 'SUCCESS',
        transaction_id: 'wx_tx_mall_1',
        amount: { total: 8800 }
      }
    },
    appendPaymentEvent: async (type, payload) => events.push({ type, payload }),
    sanitizeWechatPayload: payload => payload,
    validatePaymentCallbackPayload: (payload, currentOrder, payment, config) => {
      assert.equal(payload.out_trade_no, payment.paymentNo)
      assert.equal(payload.amount.total, 8800)
      assert.equal(currentOrder.payAmount, 88.00)
      assert.equal(config.mchId, 'mch_1')
    },
    markOrderPaid: async (orderId, payload) => {
      assert.equal(orderId, order._id)
      assert.equal(payload.paymentNo, order.paymentNo)
      assert.equal(payload.wxTransactionId, 'wx_tx_mall_1')
      order.status = 'pending_ship'
      order.paymentStatus = 'paid'
      order.paidAt = '2026-10-15 15:30:00'
      payments[0].status = 'success'
      payments[0].paidAt = order.paidAt
    },
    getPayableOrder: async () => ({ order, orderType: 'mall' })
  })

  const result = await handler('client_openid', 'getPaymentStatus', { orderId: order._id })

  assert.equal(result.status, 'pending_ship')
  assert.equal(result.paymentStatus, 'paid')
  assert.equal(result.paidAt, '2026-10-15 15:30:00')
  assert.equal(result.payments[0].status, 'success')
  assert.equal(events[0].type, 'query')
})

