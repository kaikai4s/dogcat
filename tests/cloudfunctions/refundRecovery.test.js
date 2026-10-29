const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const { createCollectionStore } = require('./helpers')
const optimistic = require('./optimisticTransactions')
const createContext = require('../../cloudfunctions/api/services/context')

test('WeChat refund POST and GET include required headers and correctly signed request bodies', async t => {
  const previous = process.env.PAYMENT_ENV
  process.env.PAYMENT_ENV = 'production'
  t.after(() => { if (previous === undefined) delete process.env.PAYMENT_ENV; else process.env.PAYMENT_ENV = previous })
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const captured = []
  let statusCode = 200
  const service = require('../../cloudfunctions/api/services/wechatPay')({ crypto, safeText: String,
    https: { request(options, callback) {
      const req = new EventEmitter()
      let body = ''
      req.setTimeout = () => req
      req.write = value => { body += value }
      req.end = () => {
        captured.push({ ...options, body })
        const res = new EventEmitter()
        res.statusCode = statusCode
        callback(res)
        res.emit('data', JSON.stringify(statusCode === 200 ? { status: 'PROCESSING' } : { code: 'RESOURCE_NOT_EXISTS', message: '退款单不存在' }))
        res.emit('end')
      }
      return req
    } }
  })
  const config = { mchId: 'merchant', certSerialNo: 'serial', privateKey: keys.privateKey }
  for (const method of ['POST', 'GET']) {
    const body = method === 'POST' ? { out_refund_no: 'R1', reason: '用户取消', amount: { refund: 100, total: 100 } } : null
    const path = '/v3/refund/domestic/refunds' + (method === 'GET' ? '/R1' : '')
    await service.wechatPayRequest(method, path, body, config)
    const request = captured.at(-1)
    assert.equal(request.headers.Accept, 'application/json')
    assert.ok(request.headers['User-Agent'])
    assert.equal(request.headers['Content-Length'], Buffer.byteLength(request.body))
    assert.equal(request.body, body ? JSON.stringify(body) : '')
    const auth = Object.fromEntries([...request.headers.Authorization.matchAll(/(\w+)="([^"]*)"/g)].map(match => [match[1], match[2]]))
    const signed = `${method}\n${path}\n${auth.timestamp}\n${auth.nonce_str}\n${request.body}\n`
    assert.ok(crypto.verify('RSA-SHA256', Buffer.from(signed), keys.publicKey, Buffer.from(auth.signature, 'base64')))
  }
  statusCode = 404
  await assert.rejects(service.wechatPayRequest('GET', '/v3/refund/domestic/refunds/R1', null, config), { code: 'RESOURCE_NOT_EXISTS' })
})

async function pendingRefund() {
  const db = createCollectionStore({ orders: [{ _id: 'order', clientOpenid: 'client', paymentNo: 'P1',
    payAmount: 1, paymentStatus: 'paid', status: 'paid' }] })
  optimistic(db)
  const context = createContext({ db, cloud: {} })
  const calls = []
  const settings = { payment: { mode: 'wechat', refundEnabled: true } }
  const gateway = { request: async () => { throw new Error('Http头缺少Accept或User-Agent') } }
  const service = require('../../cloudfunctions/api/services/refunds')({ ...context,
    getSystemSettings: async () => settings, getWechatPayConfig: () => ({}),
    wechatPayRequest: async (method, path, body) => { calls.push({ method, path, body }); return gateway.request(method, path, body) }
  })
  await assert.rejects(service.requestOrderRefund(structuredClone(db.state.orders[0]), 1, '宠物主取消', 'client_cancel', 'client', 'cancel-1', { cancelStatus: 'cancelled' }), /Http头缺少/)
  const refund = structuredClone(db.state.refunds[0])
  const response = status => ({ status, out_refund_no: refund.refundNo, refund_id: 'WX-R1', amount: { refund: 100, total: 100 } })
  return { db, context, service, gateway, settings, calls, refund, response }
}

test('rejected cancellation refund recovers using its original number and reserved amount', async () => {
  const f = await pendingRefund()
  assert.equal(f.db.state.orders[0].refundAmount, 1)
  f.gateway.request = async method => {
    if (method === 'GET') throw Object.assign(new Error('退款单不存在'), { code: 'RESOURCE_NOT_EXISTS' })
    return f.response('SUCCESS')
  }
  await f.service.reconcilePendingRefunds()
  assert.deepEqual(f.calls.map(call => call.method), ['POST', 'GET', 'POST'])
  assert.equal(f.calls[1].path, `/v3/refund/domestic/refunds/${f.refund.refundNo}`)
  assert.equal(f.calls[1].body, null)
  assert.deepEqual(f.calls[2].body, f.calls[0].body)
  assert.equal(f.db.state.refunds.length, 1)
  assert.equal(f.db.state.refunds[0].status, 'success')
  assert.equal(f.db.state.refunds[0].lastError, '')
  assert.equal(f.db.state.orders[0].refundedAmount, 1)
  assert.equal(f.db.state.orders[0].refundStatus, 'full_refunded')
  assert.equal(f.db.state.orders[0].paymentStatus, 'refunded')
  await f.service.syncOrderRefund(f.refund)
  assert.equal(f.calls.length, 3, 'stale input must not resubmit a completed refund')
  assert.equal(f.db.state.finance_logs.length, 1)
})

test('accepted refund is queried until success without another POST, including concurrent synchronization', async () => {
  const f = await pendingRefund()
  f.gateway.request = async () => f.response('PROCESSING')
  assert.equal((await f.service.syncOrderRefund(f.refund)).status, 'processing')
  assert.equal(f.db.state.orders[0].refundAmount, 1)
  f.gateway.request = async () => f.response('SUCCESS')
  await Promise.all([f.service.syncOrderRefund(f.refund), f.service.reconcilePendingRefunds()])
  assert.ok(f.calls.slice(1).every(call => call.method === 'GET'))
  assert.equal(f.db.state.finance_logs.length, 1)
  assert.equal(f.db.state.orders[0].refundedAmount, 1)
})

for (const code of ['SYSTEM_ERROR', 'SIGN_ERROR', 'NOT_FOUND', 'ETIMEDOUT']) {
  test(`query ${code} preserves pending quota and does not submit another refund`, async () => {
    const f = await pendingRefund()
    f.gateway.request = async () => { throw Object.assign(new Error(code), { code }) }
    await assert.rejects(f.service.syncOrderRefund(f.refund), new RegExp(code))
    assert.deepEqual(f.calls.map(call => call.method), ['POST', 'GET'])
    assert.equal(f.db.state.refunds[0].status, 'processing')
    assert.equal(f.db.state.orders[0].refundAmount, 1)
    assert.equal(f.db.state.orders[0].paymentStatus, 'refunding')
    assert.equal((f.db.state.finance_logs || []).length, 0)
  })
}

test('incomplete, mismatched and unknown query results neither release quota nor report success', async () => {
  const f = await pendingRefund()
  for (const response of [null, {}, { status: 'SUCCESS' }, { ...f.response('SUCCESS'), out_refund_no: 'OTHER' },
    { ...f.response('SUCCESS'), amount: { total: 100, refund: 99 } }, f.response('UNKNOWN')]) {
    f.gateway.request = async () => response
    await assert.rejects(f.service.syncOrderRefund(f.refund), /不完整|不一致/)
    assert.equal(f.db.state.orders[0].refundAmount, 1)
    assert.equal(f.db.state.refunds[0].status, 'processing')
  }
  assert.ok(f.calls.slice(1).every(call => call.method === 'GET'))
})

test('disabling new refunds still allows querying accepted refunds but forbids resubmission', async () => {
  const f = await pendingRefund()
  f.settings.payment.refundEnabled = false
  f.gateway.request = async () => { throw Object.assign(new Error('missing'), { code: 'RESOURCE_NOT_EXISTS' }) }
  await assert.rejects(f.service.syncOrderRefund(f.refund), /尚未启用/)
  f.gateway.request = async () => f.response('SUCCESS')
  assert.equal((await f.service.syncOrderRefund(f.refund)).status, 'success')
  assert.ok(f.calls.slice(1).every(call => call.method === 'GET'))
})

test('refund query authorizes owner or administrator before synchronizing gateway state', async () => {
  const f = await pendingRefund()
  let authorized = false
  const handler = require('../../cloudfunctions/api/handlers/payment')({ ...f.context, ...f.service,
    getUser: async openid => ({ roles: openid === 'admin' ? ['admin'] : ['client'] }),
    authorizeAdmin: async () => { if (!authorized) throw new Error('管理员无权限') }
  })
  f.gateway.request = async () => f.response('PROCESSING')
  await assert.rejects(handler('other', 'queryRefund', { refundNo: f.refund.refundNo }), /无权查看/)
  await assert.rejects(handler('admin', 'queryRefund', { refundNo: f.refund.refundNo }), /无权限/)
  assert.equal(f.calls.length, 1)
  await handler('client', 'queryRefund', { refundNo: f.refund.refundNo })
  authorized = true
  await handler('admin', 'queryRefund', { refundNo: f.refund.refundNo })
  assert.deepEqual(f.calls.map(call => call.method), ['POST', 'GET', 'GET'])
})

test('opening an order refreshes a paid-out refund from WeChat and returns the committed order', async () => {
  const f = await pendingRefund()
  f.gateway.request = async () => f.response('SUCCESS')
  const [order] = await f.service.refreshOrderRefunds([structuredClone(f.db.state.orders[0])])
  assert.equal(order.refundStatus, 'full_refunded')
  assert.equal(order.paymentStatus, 'refunded')
  assert.equal(order.refundedAmount, 1)
  assert.equal(order.status, 'refunded')
  assert.deepEqual(f.calls.map(call => call.method), ['POST', 'GET'])
  await f.service.refreshOrderRefunds([order])
  assert.equal(f.calls.length, 2)
})

test('page refresh never resubmits or frees quota on a missing or unavailable refund', async () => {
  for (const code of ['RESOURCE_NOT_EXISTS', 'SYSTEM_ERROR']) {
    const f = await pendingRefund()
    f.gateway.request = async () => { throw Object.assign(new Error(code), { code }) }
    const [order] = await f.service.refreshOrderRefunds([structuredClone(f.db.state.orders[0])])
    assert.equal(order.paymentStatus, 'refunding')
    assert.equal(order.refundAmount, 1)
    assert.ok(order.refundSyncCheckedAt)
    assert.deepEqual(f.calls.map(call => call.method), ['POST', 'GET'])
    await f.service.refreshOrderRefunds([order])
    assert.equal(f.calls.length, 2, 'rapid page re-entry must not hammer the gateway')
  }
})

test('automatic page queries are bounded and later refreshes advance to unchecked orders', async () => {
  const f = await pendingRefund()
  const order = f.db.state.orders[0]
  f.db.state.orders = Array.from({ length: 14 }, (_, i) => ({ ...order, _id: `o${i}` }))
  f.db.state.refunds = f.db.state.orders.map((row, i) => ({ ...f.refund, _id: `r${i}`, orderId: row._id, refundNo: `R${i}` }))
  f.gateway.request = async (method, path) => ({ ...f.response('PROCESSING'), out_refund_no: path.split('/').at(-1) })
  const updated = await f.service.refreshOrderRefunds(structuredClone(f.db.state.orders))
  assert.equal(f.calls.length, 11)
  assert.equal(updated.filter(row => row.refundSyncCheckedAt).length, 10)
  await f.service.refreshOrderRefunds(updated)
  assert.equal(f.calls.length, 15)
})

test('legacy mock refunds do not prevent later real refunds from being synchronized', async () => {
  const f = await pendingRefund()
  const pending = structuredClone(f.db.state.orders[0])
  f.db.state.orders.unshift(...Array.from({ length: 10 }, (_, i) => ({ ...pending, _id: `mock-${i}` })))
  f.gateway.request = async () => f.response('SUCCESS')
  const first = await f.service.refreshOrderRefunds(structuredClone(f.db.state.orders))
  assert.equal(f.calls.length, 1)
  const second = await f.service.refreshOrderRefunds(first)
  assert.equal(second.find(row => row._id === 'order').paymentStatus, 'refunded')
  assert.equal(f.calls.length, 2)
})

test('mock partial and full refunds settle balances, coupons and finance logs once', async () => {
  const db = createCollectionStore({
    orders: [{ _id: 'mock-order', clientOpenid: 'client', paymentNo: 'mock-payment',
      payAmount: 100, paymentStatus: 'paid', status: 'completed', couponId: 'coupon' }],
    user_coupons: [{ _id: 'coupon', openid: 'client', status: 'used', usedOrderId: 'mock-order', validTo: '2099-01-01' }],
    staff_earnings: [], finance_logs: [], refunds: []
  })
  optimistic(db)
  const context = createContext({ db, cloud: {} })
  const service = require('../../cloudfunctions/api/services/refunds')({ ...context,
    getSystemSettings: async () => ({ payment: { mode: 'mock' } }), assertPaymentModeAllowed: () => {}
  })
  const partial = await service.requestOrderRefund(db.state.orders[0], 30, 'partial', 'admin', 'admin', 'part-1')
  assert.equal(partial.status, 'success')
  assert.equal(db.state.orders[0].paymentStatus, 'paid')
  assert.equal(db.state.orders[0].refundStatus, 'partially_refunded')
  assert.equal(db.state.orders[0].refundedAmount, 30)
  assert.equal(db.state.user_coupons[0].status, 'used')

  const full = await service.requestOrderRefund(db.state.orders[0], 70, 'remainder', 'admin', 'admin', 'part-2')
  assert.equal(full.status, 'success')
  assert.equal(db.state.orders[0].paymentStatus, 'refunded')
  assert.equal(db.state.orders[0].refundStatus, 'full_refunded')
  assert.equal(db.state.orders[0].refundedAmount, 100)
  assert.equal(db.state.user_coupons[0].status, 'available')
  assert.equal(db.state.finance_logs.filter(row => row.action === 'refund_success').length, 2)
  assert.ok(db.state.finance_logs.every(row => row.amountDelta === 0))
  await service.syncOrderRefund(partial)
  await service.reconcilePendingRefunds()
  assert.equal(db.state.finance_logs.filter(row => row.action === 'refund_success').length, 2)
})

test('previously stuck mock refunds are finalized by reconciliation without applying earnings twice', async () => {
  const db = createCollectionStore({
    orders: [{ _id: 'legacy-order', clientOpenid: 'client', paymentNo: 'mock-payment',
      payAmount: 100, paymentStatus: 'refunding', refundStatus: 'processing', refundAmount: 100,
      refundedAmount: 0, status: 'cancelled' }],
    refunds: [{ _id: 'legacy-refund', orderId: 'legacy-order', collectionName: 'orders',
      refundNo: 'mock-refund', amount: 100, refundAmount: 100, channel: 'mock',
      status: 'processing', earningsAccountingVersion: 2, earningsApplied: true }],
    staff_earnings: [{ _id: 'earning', orderId: 'legacy-order', staffOpenid: 'staff',
      amount: 0, originalAmount: 70, deductedAmount: 70, status: 'refunded_void' }], finance_logs: []
  })
  const context = createContext({ db, cloud: {} })
  const service = require('../../cloudfunctions/api/services/refunds')({ ...context,
    getSystemSettings: async () => ({ payment: { mode: 'wechat' } })
  })
  await service.reconcilePendingRefunds()
  assert.equal(db.state.refunds[0].status, 'success')
  assert.equal(db.state.orders[0].status, 'refunded')
  assert.equal(db.state.orders[0].paymentStatus, 'refunded')
  assert.equal(db.state.orders[0].refundedAmount, 100)
  assert.equal(db.state.staff_earnings[0].amount, 0)
  assert.equal(db.state.staff_earnings[0].deductedAmount, 70)
  assert.equal(db.state.finance_logs.filter(row => row.action === 'staff_earning_voided').length, 0)
})

test('invalid mock refunds do not indefinitely block later valid refunds', async t => {
  const errors = t.mock.method(console, 'error', () => {})
  const orders = Array.from({ length: 31 }, (_, i) => ({ _id: `order-${i}`, clientOpenid: 'client',
    payAmount: 1, paymentNo: `pay-${i}`, paymentStatus: 'refunding', refundStatus: 'processing',
    refundAmount: 1, status: 'cancelled', paymentChannel: i < 30 ? 'wechat' : 'mock' }))
  const refunds = orders.map((order, i) => ({ _id: `refund-${i}`, orderId: order._id,
    collectionName: 'orders', refundNo: `R${i}`, amount: 1, refundAmount: 1, channel: 'mock',
    status: 'processing', updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) }))
  const db = createCollectionStore({ orders, refunds })
  const context = createContext({ db, cloud: {} })
  const service = require('../../cloudfunctions/api/services/refunds')({ ...context,
    getSystemSettings: async () => ({ payment: { mode: 'wechat' } })
  })
  await service.reconcilePendingRefunds()
  assert.equal(db.state.refunds[30].status, 'processing')
  assert.equal(db.state.refunds[0].lastError.includes('原订单为微信支付'), true)
  await service.reconcilePendingRefunds()
  assert.equal(db.state.refunds[30].status, 'success')
  assert.equal(db.state.orders[30].paymentStatus, 'refunded')
  assert.equal(errors.mock.callCount(), 59)
})

test('the original payment channel takes precedence over a later payment-mode change', async () => {
  const db = createCollectionStore({
    orders: [
      { _id: 'real-order', clientOpenid: 'client', payAmount: 100, paymentStatus: 'paid',
        status: 'paid', paymentNo: 'real-payment', wxTransactionId: 'wechat-transaction', paymentChannel: 'wechat' },
      { _id: 'test-order', clientOpenid: 'client', payAmount: 20, paymentStatus: 'paid',
        status: 'paid', paymentNo: 'test-payment', paymentChannel: 'mock', isMockPayment: true }
    ],
    payments: [{ _id: 'real-payment', orderId: 'real-order', status: 'success', channel: 'wechat' }],
    refunds: [], finance_logs: []
  })
  const context = createContext({ db, cloud: {} })
  const mockConfigured = require('../../cloudfunctions/api/services/refunds')({ ...context,
    getSystemSettings: async () => ({ payment: { mode: 'mock' } }), assertPaymentModeAllowed: () => {}
  })
  await assert.rejects(mockConfigured.requestOrderRefund(db.state.orders[0], 100, 'real', 'admin', 'admin', 'real'), /微信退款功能尚未启用/)
  assert.equal(db.state.refunds[0].channel, 'wechat')
  assert.equal(db.state.refunds[0].status, 'processing')
  assert.equal(db.state.orders[0].refundedAmount || 0, 0)

  db.state.refunds[0].channel = 'mock'
  await assert.rejects(mockConfigured.syncOrderRefund(db.state.refunds[0]), /原订单为微信支付/)
  assert.equal(db.state.refunds[0].status, 'processing')
  assert.equal(db.state.orders[0].refundedAmount || 0, 0)

  const wechatConfigured = require('../../cloudfunctions/api/services/refunds')({ ...context,
    getSystemSettings: async () => ({ payment: { mode: 'wechat', refundEnabled: true } }),
    assertPaymentModeAllowed: () => {}
  })
  const testRefund = await wechatConfigured.requestOrderRefund(db.state.orders[1], 20, 'test', 'admin', 'admin', 'test')
  assert.equal(testRefund.channel, 'mock')
  assert.equal(testRefund.status, 'success')
  assert.equal(db.state.orders[1].paymentStatus, 'refunded')
})
