const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const optimistic = require('./optimisticTransactions')
const createContext = require('../../cloudfunctions/api/services/context')

function setup(extra = {}) {
  const db = createCollectionStore({
    users: [{ _id: 'client', openid: 'client', roles: ['client'], status: 'active' },
      { _id: 'admin', openid: 'admin', roles: ['admin'], status: 'active' }],
    orders: [{ _id: 'o', clientOpenid: 'client', status: 'pending_pay', paymentStatus: 'unpaid', payAmount: 100, createdAt: new Date() }],
    payments: [], refunds: [], finance_logs: [], payment_events: [], ...extra
  })
  const retries = optimistic(db)
  return { db, retries, context: createContext({ db, cloud: {} }) }
}

test('concurrent payment requests reserve one merchant number and one pending record', async () => {
  const { db, context, retries } = setup()
  const results = await Promise.all(Array.from({ length: 4 }, () => context.ensurePaymentRecord(db.state.orders[0], 'client', 'mock', 'same')))
  assert.equal(new Set(results.map(row => row.paymentNo)).size, 1)
  assert.equal(db.state.payments.length, 1)
  assert.equal(db.state.orders[0].paymentStatus, 'paying')
  assert.ok(retries() > 0)
})

test('payment callback, coupon and ledger commit once during concurrent callbacks', async () => {
  const { db, context } = setup({ user_coupons: [{ _id: 'c', openid: 'client', status: 'locked', lockedOrderId: 'o' }] })
  db.state.orders[0].couponId = 'c'
  const payment = await context.ensurePaymentRecord(db.state.orders[0], 'client', 'mock')
  await Promise.all([context.markOrderPaid('o', payment), context.markOrderPaid('o', payment)])
  assert.equal(db.state.orders[0].status, 'paid')
  assert.equal(db.state.payments[0].status, 'success')
  assert.equal(db.state.user_coupons[0].status, 'used')
  assert.equal(db.state.finance_logs.filter(row => row.action === 'order_paid').length, 1)
})

test('payment ledger failure rolls back order, coupon and payment state', async () => {
  const { db, context } = setup()
  const payment = await context.ensurePaymentRecord(db.state.orders[0], 'client', 'mock')
  const run = db.runTransaction
  db.runTransaction = callback => run(tx => callback({ collection(name) { return { doc(id) {
    const doc = tx.collection(name).doc(id)
    if (name === 'finance_logs') doc.set = async () => { throw new Error('ledger unavailable') }
    return doc
  } } } }))
  await assert.rejects(context.markOrderPaid('o', payment), /ledger unavailable/)
  assert.equal(db.state.orders[0].status, 'pending_pay')
  assert.equal(db.state.payments[0].status, 'pending')
  assert.equal(db.state.finance_logs.length, 0)
})

test('two mall orders cannot oversell the last unit or partially mark a failed payment', async () => {
  const item = { productId: 'p', name: 'food', quantity: 1 }
  const { db, context } = setup({
    orders: [], mall_products: [{ _id: 'p', name: 'food', price: 100, stock: 1, status: 'on_sale' }],
    mall_orders: ['a', 'b'].map(_id => ({ _id, clientOpenid: 'client', status: 'pending_pay', paymentStatus: 'unpaid', payAmount: 100, items: [item] }))
  })
  const payments = await Promise.all(db.state.mall_orders.map(order => context.ensurePaymentRecord(order, 'client', 'mock')))
  const result = await Promise.allSettled(payments.map(payment => context.markOrderPaid(payment.orderId, payment)))
  assert.equal(result.filter(row => row.status === 'fulfilled').length, 1)
  assert.equal(db.state.mall_products[0].stock, 0)
  assert.equal(db.state.mall_orders.filter(row => row.paymentStatus === 'paid').length, 1)
  assert.equal(db.state.payments.filter(row => row.status === 'success').length, 1)
})

test('manual cancellation closes mock payment and cannot release another order coupon', async () => {
  const { db, context } = setup({ user_coupons: [{ _id: 'c', openid: 'client', status: 'locked', lockedOrderId: 'another' }] })
  db.state.orders[0].couponId = 'c'
  await context.ensurePaymentRecord(db.state.orders[0], 'client', 'mock')
  assert.equal(await context.cancelUnpaidOrder(db.state.orders[0], { reason: 'cancel' }), true)
  assert.equal(db.state.payments[0].status, 'closed')
  assert.equal(db.state.user_coupons[0].lockedOrderId, 'another')
  await assert.rejects(context.ensurePaymentRecord(db.state.orders[0], 'client', 'mock'), /不可支付/)
})

function refunds(extra = {}) {
  const base = setup({ orders: [{ _id: 'o', clientOpenid: 'client', paymentStatus: 'paid', status: 'paid', paymentNo: 'P1', payAmount: 100 }] })
  const service = require('../../cloudfunctions/api/services/refunds')({ ...base.context, ...extra })
  return { ...base, ...service }
}
test('concurrent refunds reserve the remaining amount without exceeding the original payment', async () => {
  const { db, requestOrderRefund } = refunds()
  const order = structuredClone(db.state.orders[0])
  const results = await Promise.allSettled(['a', 'b'].map(id => requestOrderRefund(order, 70, id, 'admin', 'admin', id)))
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
  assert.equal(db.state.refunds.length, 1)
  assert.equal(db.state.orders[0].refundAmount, 70)
  assert.equal(db.state.orders[0].paymentStatus, 'refunding')
})

test('refund idempotency rejects changed parameters and does not label submitted money as refunded', async () => {
  const { db, requestOrderRefund } = refunds()
  const order = structuredClone(db.state.orders[0])
  await Promise.all([requestOrderRefund(order, 100, 'reason', 'admin', 'admin', 'once'), requestOrderRefund(order, 100, 'reason', 'admin', 'admin', 'once')])
  assert.equal(db.state.refunds.length, 1)
  assert.equal(db.state.orders[0].refundStatus, 'processing')
  assert.equal(db.state.orders[0].status, 'paid')
  await assert.rejects(requestOrderRefund(order, 90, 'reason', 'admin', 'admin', 'once'), /不可更改/)
})

test('ambiguous gateway failure retries the same refund number and records success atomically', async () => {
  const sent = []
  let unavailable = true
  const { db, requestOrderRefund, reconcilePendingRefunds } = refunds({
    getSystemSettings: async () => ({ payment: { mode: 'wechat', refundEnabled: true } }),
    getWechatPayConfig: () => ({}),
    wechatPayRequest: async (method, path, body) => {
      sent.push(body.out_refund_no)
      if (unavailable) throw new Error('timeout after remote commit')
      return { status: 'SUCCESS', out_refund_no: body.out_refund_no, refund_id: 'WX-R', amount: body.amount }
    }
  })
  const order = structuredClone(db.state.orders[0])
  await assert.rejects(requestOrderRefund(order, 100, 'reason', 'admin', 'admin', 'once'), /待核实/)
  assert.equal(db.state.refunds[0].status, 'processing')
  assert.equal(db.state.orders[0].refundAmount, 100)
  unavailable = false
  await reconcilePendingRefunds()
  await requestOrderRefund(order, 100, 'reason', 'admin', 'admin', 'once')
  assert.equal(new Set(sent).size, 1)
  assert.equal(db.state.refunds.length, 1)
  assert.equal(db.state.orders[0].paymentStatus, 'refunded')
  assert.equal(db.state.finance_logs.filter(row => row.action === 'refund_success').length, 1)
})

test('refund cannot reserve money after assignment changed during cancellation', async () => {
  const { db, requestOrderRefund } = refunds()
  const stale = structuredClone(db.state.orders[0])
  db.state.orders[0].staffOpenid = 'staff'
  db.state.orders[0].status = 'assigned'
  await assert.rejects(requestOrderRefund(stale, 100, 'cancel', 'client_cancel', 'client', 'c', { cancelStatus: 'cancelled' }), /状态已变化/)
  assert.equal(db.state.refunds.length, 0)
})

test('freezing future earnings races safely with earning creation', async () => {
  for (const concurrent of [false, true]) {
    const { db, context } = setup({
      orders: [{ _id: 'o', staffOpenid: 'staff', payAmount: 100, status: 'completed' }],
      order_incidents: [{ _id: 'i', orderId: 'o', staffOpenid: 'staff', status: 'open', frozenEarningIds: [] }], staff_earnings: []
    })
    const order = structuredClone(db.state.orders[0])
    if (concurrent) await Promise.all([context.freezeIncidentEarnings('i', 'admin'), context.ensureStaffEarning(order)])
    else { await context.freezeIncidentEarnings('i', 'admin'); await context.ensureStaffEarning(order) }
    assert.equal(db.state.staff_earnings.length, 1)
    assert.equal(db.state.staff_earnings[0].status, 'frozen')
    assert.equal(db.state.staff_earnings[0].frozenIncidentId, 'i')
    assert.deepEqual(db.state.order_incidents[0].frozenEarningIds, ['earning_order_o'])
    await context.closeIncidentFinancially('i', { status: 'closed', earningDecision: 'release' }, 'admin')
    assert.equal(db.state.orders[0].frozenEarningIncidentId, '')
    assert.notEqual(db.state.staff_earnings[0].status, 'frozen')
  }
})

test('subscription retry queue prevents concurrent sends and retries after transient failure', async () => {
  const { db } = setup()
  let current = new Date('2026-09-23T00:00:00Z')
  const service = require('../../cloudfunctions/api/services/subscriptionDelivery')({ db, crypto: require('node:crypto'), now: () => current })
  const message = { openid: 'client', templateKey: 'orderPaid', page: 'page', messageData: {}, orderId: 'o' }
  let count = 0
  const send = async () => { count++; return { status: count === 1 ? 'failed' : 'sent', error: '' } }
  await Promise.all([service.deliverSubscription(message, send), service.deliverSubscription(message, send)])
  assert.equal(count, 1)
  current = new Date('2026-09-23T01:00:00Z')
  await service.retrySubscriptionDeliveries(send)
  await service.deliverSubscription(message, send)
  assert.equal(count, 2)
  assert.equal(db.state.subscription_logs[0].status, 'sent')
})

test('financial inputs reject fractional cents, infinity and unsafe integers', () => {
  const { context } = setup()
  for (const amount of [0, -1, 0.001, Infinity, NaN, Number.MAX_SAFE_INTEGER]) assert.throws(() => context.amountYuanToFen(amount), /金额不正确/)
})

test('historical refunds without matching detail block further reservations', async () => {
  const { db, requestOrderRefund } = refunds()
  db.state.orders[0].refundAmount = 60
  await assert.rejects(requestOrderRefund(db.state.orders[0], 50, 'again', 'admin', 'admin'), /先对账/)
  assert.equal(db.state.refunds.length, 0)
})

test('concurrent deposit reservations reuse one deposit and payment and settle once', async () => {
  const { db, context } = setup({ staff_profiles: [{ _id: 'profile', openid: 'client', auditStatus: 'approved' }] })
  const user = db.state.users[0], profile = db.state.staff_profiles[0]
  const rows = await Promise.all(Array.from({ length: 4 }, () => context.reserveStaffDepositPayment(user, profile, 500, 'mock', 'once')))
  assert.equal(db.state.staff_deposits.length, 1)
  assert.equal(db.state.payments.length, 1)
  assert.equal(new Set(rows.map(row => row.payment.paymentNo)).size, 1)
  await Promise.all(rows.map(row => context.recordStaffDepositPayment(row.deposit._id, { paymentNo: row.payment.paymentNo, channel: 'mock' })))
  assert.equal(db.state.staff_deposits[0].paidAmount, 500)
  assert.equal(db.state.finance_logs.filter(row => row.action === 'deposit_paid').length, 1)
})

test('deposit payment write failure rolls back its reservation and profile marker', async () => {
  const { db, context } = setup({ staff_profiles: [{ _id: 'profile', openid: 'client', auditStatus: 'approved' }] })
  const run = db.runTransaction
  db.runTransaction = callback => run(tx => callback({ collection(name) { return { doc(id) {
    const doc = tx.collection(name).doc(id)
    if (name === 'payments') doc.set = async () => { throw new Error('payment unavailable') }
    return doc
  } } } }))
  await assert.rejects(context.reserveStaffDepositPayment(db.state.users[0], db.state.staff_profiles[0], 500, 'mock'), /payment unavailable/)
  assert.equal((db.state.staff_deposits || []).length, 0)
  assert.equal(db.state.staff_profiles[0].currentDepositId, undefined)
})

test('late failure callback cannot overwrite payment that succeeded after the initial query', async () => {
  const { db, context } = setup({ payments: [{ _id: 'p', orderId: 'o', paymentNo: 'P', status: 'pending' }] })
  const callback = require('../../cloudfunctions/api/services/paymentCallback')({ ...context,
    getSystemSettings: async () => ({}), getWechatPayConfig: () => ({}), verifyWechatPayCallback() {},
    validatePaymentCallbackPayload() { db.state.payments[0].status = 'success' }
  })
  const result = await callback({ body: JSON.stringify({ out_trade_no: 'P', trade_state: 'CLOSED' }) })
  assert.equal(result.code, 'SUCCESS')
  assert.equal(db.state.payments[0].status, 'success')
})

test('retry queue query failure does not stop order cancellation and expiry tasks', async () => {
  const calls = []
  const run = require('../../cloudfunctions/api/scheduled')({
    reconcilePendingRefunds: async () => { throw new Error('refund index unavailable') },
    retryFailedSubscriptions: async () => { throw new Error('subscription index unavailable') },
    cancelUnpaidOrders: async () => calls.push('cancel'),
    expireDueUnacceptedOrders: async () => calls.push('expire'),
    sendUpcomingServiceRemindersToStaff: async () => [],
    processOverdueUnstartedOrders: async () => [], processOverdueUnfinishedOrders: async () => [],
    toCstParts: () => ({ dayNumber: 15, monthKey: '2026-09' }), getMonthDays: () => 30
  })
  assert.equal((await run()).expired, true)
  assert.deepEqual(calls, ['cancel', 'expire'])
})

test('delegated administrators cannot grant access, rewrite payment settings or read secrets', async () => {
  const { db } = setup({
    users: [{ _id: 'owner', openid: 'owner', roles: ['admin'], status: 'active' }, { _id: 'admin', openid: 'admin', roles: ['admin'], status: 'active' }],
    admin_access_config: [{ _id: 'policy', enabled: true, ownerOpenid: 'owner' }],
    admin_groups: [{ _id: 'g', enabled: true, permissions: ['admin.getSystemSettings', 'admin.saveSystemSettings', 'admin.listOrders'] }],
    admin_memberships: [{ _id: 'admin', groupIds: ['g'], revision: 1 }]
  })
  const api = loadCloudFunction('api', db, 'admin')
  for (const [action, data] of [['saveSystemSettings', {}], ['getSystemSettings', { includeSecrets: true }], ['setAdminMembership', { openid: 'admin', groupIds: [] }], ['grantAdmin', { openid: 'admin' }]]) {
    const response = await api.main({ module: 'admin', action, data })
    assert.equal(response.ok, false, action)
    assert.equal(response.code, 'ADMIN_FORBIDDEN', action)
  }
  assert.ok(db.state.admin_access_logs.every(row => row.status === 'denied'))
  db.state.admin_groups[0].enabled = false
  assert.equal((await api.main({ module: 'admin', action: 'listOrders', data: {} })).code, 'ADMIN_FORBIDDEN')
})

test('owner group changes use revisions and cannot delegate owner-only functions', async () => {
  const { db } = setup({
    users: [{ _id: 'owner', openid: 'owner', roles: ['admin'], status: 'active' }],
    admin_access_config: [{ _id: 'policy', enabled: true, ownerOpenid: 'owner' }]
  })
  const api = loadCloudFunction('api', db, 'owner')
  assert.equal((await api.main({ module: 'admin', action: 'saveAdminGroup', data: { name: 'bad', permissions: ['admin.saveSystemSettings'] } })).ok, false)
  const request = { module: 'admin', action: 'saveAdminGroup', data: { name: '客服', enabled: true, permissions: ['admin.listOrders'], clientRequestId: 'create-once' } }
  const group = await api.main(request)
  assert.equal(group.ok, true)
  assert.equal((await api.main(request)).data._id, group.data._id)
  assert.equal(db.state.admin_groups.length, 1)
  assert.equal((await api.main({ module: 'admin', action: 'saveAdminGroup', data: { id: group.data._id, name: 'stale', enabled: true, revision: 0, permissions: [] } })).ok, false)
  assert.equal(db.state.admin_groups[0].name, '客服')
})
