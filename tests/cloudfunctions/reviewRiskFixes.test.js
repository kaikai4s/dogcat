const test = require('node:test')
const assert = require('node:assert/strict')
const root = require('node:path').resolve(__dirname, '../..')
const { createCollectionStore, loadCloudFunction } = require(root + '/tests/cloudfunctions/helpers')
const createContext = require(root + '/cloudfunctions/api/services/context')
const createRefunds = require(root + '/cloudfunctions/api/services/refunds')
const optimistic = require('./optimisticTransactions')
const safeText = v => String(v || '')
const now = () => new Date('2026-10-22T02:00:00Z')

function refundSetup(status, earningStatus = 'available') {
  const gatewayCalls = []
  const db = createCollectionStore({
    users: [{ _id: 'client', openid: 'client', roles: ['client'], status: 'active' }, { _id: 'staff', openid: 'staff', roles: ['staff'], status: 'active' }],
    orders: [{ _id: 'order', clientOpenid: 'client', staffOpenid: 'staff', status: 'completed', paymentStatus: 'paid', paymentNo: 'payment', payAmount: 100, refundAmount: 0, refundedAmount: 0, couponId: 'coupon' }],
    user_coupons: [{ _id: 'coupon', openid: 'client', status: 'used', usedOrderId: 'order', validTo: '2099-01-01T00:00:00Z' }],
    staff_earnings: [{ _id: 'earning', orderId: 'order', staffOpenid: 'staff', amount: 70, originalAmount: 70, status: earningStatus, ...(earningStatus === 'withdrawing' ? { withdrawRequestId: 'withdraw' } : {}) }],
    withdraw_requests: earningStatus === 'withdrawing' ? [{ _id: 'withdraw', staffOpenid: 'staff', status: 'pending', amount: 70, earningIds: ['earning'] }] : []
  })
  const context = createContext({ db, cloud: {} })
  const refunds = createRefunds({ ...context,
    getSystemSettings: async () => ({ payment: { mode: 'wechat', refundEnabled: true } }),
    getWechatPayConfig: () => ({}),
    wechatPayRequest: async (method, path, body) => {
      gatewayCalls.push({ method, path, body })
      const request = body || gatewayCalls.find(call => call.body).body
      return { status, out_refund_no: request.out_refund_no, refund_id: 'gateway-refund', amount: request.amount }
    }
  })
  return { db, context, refunds, gatewayCalls, setGatewayStatus: value => { status = value } }
}

test('failed refunds preserve staff earnings and keep used coupons unavailable', async () => {
  const { db, refunds } = refundSetup('CLOSED')
  await refunds.requestOrderRefund(db.state.orders[0], 100, 'test refund', 'admin', 'admin', 'request')
  assert.equal(db.state.refunds[0].status, 'failed')
  assert.equal(db.state.orders[0].refundedAmount, 0)
  assert.equal(db.state.staff_earnings[0].amount, 70)
  assert.equal(db.state.staff_earnings[0].status, 'available')
  assert.deepEqual(db.state.staff_earnings[0].pendingRefundIds, [])
  assert.equal(db.state.user_coupons[0].status, 'used')
})

test('partial refunds release pending withdrawals and deduct only the refunded share', async () => {
  const { db, context, refunds } = refundSetup('SUCCESS', 'withdrawing')
  await refunds.requestOrderRefund(db.state.orders[0], 10, 'partial refund', 'admin', 'admin', 'request')
  assert.equal(db.state.orders[0].refundedAmount, 10)
  assert.equal(db.state.staff_earnings[0].amount, 63)
  assert.equal(db.state.staff_earnings[0].status, 'available')
  assert.equal(db.state.withdraw_requests[0].status, 'rejected')
  assert.equal(db.state.staff_earnings[0].withdrawRequestId, '')
  const request = await context.createWithdrawRequest('staff', { amount: 63, accountName: '测试员工', accountNo: '12345678', clientRequestId: 'remaining' })
  assert.equal(request.amount, 63)
})

test('earnings query failures abort refunds before any gateway request', async () => {
  const { db, refunds } = refundSetup('SUCCESS')
  const original = db.runTransaction
  db.runTransaction = callback => original(tx => callback({ collection: name => {
    const chain = tx.collection(name)
    if (name === 'staff_earnings') chain.get = async () => { throw new Error('temporary database failure') }
    return chain
  } }))
  await assert.rejects(refunds.requestOrderRefund(db.state.orders[0], 100, 'full refund', 'admin', 'admin', 'request'), /temporary database failure/)
  assert.equal(db.state.orders[0].paymentStatus, 'paid')
  assert.equal(db.state.staff_earnings[0].amount, 70)
  assert.equal((db.state.refunds || []).length, 0)
})

test('newbie coupon checks orders beyond the first 50 records', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'client', openid: 'client', roles: ['client'], status: 'active' }],
    orders: [...Array.from({ length: 50 }, (_, i) => ({ _id: `cancelled-${i}`, clientOpenid: 'client', status: 'cancelled', paymentStatus: 'unpaid' })), { _id: 'paid', clientOpenid: 'client', status: 'completed', paymentStatus: 'paid' }],
    coupon_templates: [{ _id: 'template', name: 'newbie', enabled: true, newbieOnly: true, perUserLimit: 1, discountAmount: 20 }]
  })
  const api = loadCloudFunction('api', db, 'client')
  const result = await api.main({ module: 'coupon', action: 'claimNewbieCoupon', data: { templateId: 'template' } })
  assert.equal(result.ok, false)
  assert.match(result.message, /仅限未下单/)
  assert.equal((db.state.user_coupons || []).length, 0)
})

test('historical early-start approvals do not authorize different staff or later sessions', async () => {
  const db = createCollectionStore({ order_early_start_requests: [{ _id: 'old', orderId: 'order', staffOpenid: 'previous-staff', status: 'approved', approvedAt: new Date('2026-10-21T02:00:00Z') }] })
  const context = createContext({ db, cloud: {} })
  const result = await context.canStartOrderSession({ _id: 'order', staffOpenid: 'new-staff' }, { index: 2, startTime: '2026-10-23 10:00' }, now())
  assert.equal(result, false)
})

test('multi-day orders reject impossible end dates', () => {
  const context = createContext({ db: createCollectionStore(), cloud: {} })
  assert.throws(() => context.buildOrderSessions({ orderType: 'multi_day', startTime: '2099-02-28 10:00', endTime: '2099-02-28 11:00', endDate: '2099-02-29', durationMinutes: 60 }), /结束日期无效/)
})

test('resolution proposals cannot bypass incident financial closure', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'admin', openid: 'admin', roles: ['admin'], status: 'active' }],
    order_incidents: [{ _id: 'incident', orderId: 'order', clientOpenid: 'client', staffOpenid: 'staff', status: 'processing', frozenEarningIds: ['earning'] }],
    staff_earnings: [{ _id: 'earning', orderId: 'order', staffOpenid: 'staff', status: 'frozen', amount: 70, frozenIncidentId: 'incident' }]
  })
  const api = loadCloudFunction('api', db, 'admin')
  const result = await api.main({ module: 'incident', action: 'proposeResolution', data: { id: 'incident', resolutionType: 'explain', content: '说明', status: 'closed' } })
  assert.equal(result.ok, false)
  assert.match(result.message, /结案流程/)
  assert.equal(db.state.order_incidents[0].status, 'processing')
  assert.equal(db.state.staff_earnings[0].status, 'frozen')
})

test('former staff retain incident access without access to household security or contacts', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'staff', openid: 'staff', roles: ['staff'], status: 'active' }],
    order_incidents: [{ _id: 'incident', orderId: 'order', staffOpenid: 'staff', clientOpenid: 'client', status: 'open' }],
    orders: [{ _id: 'order', staffOpenid: 'new-staff', clientOpenid: 'client', status: 'assigned', contactPhone: '13800000001', orderHomeSecurity: { type: 'key', keyLocation: 'private-location', key: { location: 'private-location', imageFileIds: ['cloud://private-test-image'] }, oneTimeCode: { cipher: 'ciphertext', iv: 'iv', tag: 'tag' } } }]
  })
  const api = loadCloudFunction('api', db, 'staff')
  const result = await api.main({ module: 'incident', action: 'getIncidentDetail', data: { id: 'incident' } })
  assert.equal(result.ok, true, result.message)
  assert.equal(result.data.order.contactPhone, undefined)
  assert.equal(result.data.order.orderHomeSecurity, undefined)
  assert.equal(result.data.order.homeSecuritySnapshot, undefined)
  assert.equal(result.data.order._id, 'order')
})

test('processing refunds hold earnings and coupons, and repeated reconciliation deducts only once', async () => {
  const { db, context, refunds, setGatewayStatus } = refundSetup('PROCESSING')
  const result = await refunds.requestOrderRefund(db.state.orders[0], 100, 'full refund', 'admin', 'admin', 'request')
  assert.equal(result.status, 'processing')
  assert.equal(db.state.staff_earnings[0].amount, 70)
  assert.equal(db.state.user_coupons[0].status, 'used')
  assert.deepEqual(db.state.staff_earnings[0].pendingRefundIds, [result._id])
  await assert.rejects(context.createWithdrawRequest('staff', { amount: 70, accountName: '测试员工', accountNo: '12345678' }), /暂无可提现收益/)
  setGatewayStatus('SUCCESS')
  await refunds.syncOrderRefund(result)
  await refunds.syncOrderRefund(result)
  assert.equal(db.state.staff_earnings[0].amount, 0)
  assert.equal(db.state.staff_earnings[0].deductedAmount, 70)
  assert.equal(db.state.user_coupons[0].status, 'available')
  assert.deepEqual(db.state.staff_earnings[0].pendingRefundIds, [])
  assert.deepEqual(db.state.orders[0].pendingEarningRefundIds, [])
  assert.equal(db.state.finance_logs.filter(row => row.action === 'staff_earning_voided').length, 1)
})

test('pending withdrawal cannot be approved while a refund is processing, and failure restores eligibility', async () => {
  const { db, context, refunds, setGatewayStatus } = refundSetup('PROCESSING', 'withdrawing')
  const result = await refunds.requestOrderRefund(db.state.orders[0], 10, 'partial refund', 'admin', 'admin', 'request')
  await assert.rejects(context.settleWithdrawal({ _id: 'admin', openid: 'admin' }, { id: 'withdraw', approved: true }), /收益状态或提现归属异常/)
  assert.equal(db.state.withdraw_requests[0].status, 'pending')
  setGatewayStatus('CLOSED')
  await refunds.syncOrderRefund(result)
  assert.equal(db.state.staff_earnings[0].amount, 70)
  assert.equal(db.state.staff_earnings[0].status, 'withdrawing')
  const approved = await context.settleWithdrawal({ _id: 'admin', openid: 'admin' }, { id: 'withdraw', approved: true })
  assert.equal(approved.request.status, 'approved')
})

test('refund reservation rejects earnings already committed to an approved or in-flight payout', async () => {
  for (const status of ['approved', 'transferring']) {
    const { db, refunds, gatewayCalls } = refundSetup('SUCCESS', 'withdrawing')
    db.state.withdraw_requests[0].status = status
    await assert.rejects(refunds.requestOrderRefund(db.state.orders[0], 10, 'partial refund', 'admin', 'admin', 'request'), /提现打款流程/)
    assert.equal(gatewayCalls.length, 0)
    assert.equal(db.state.staff_earnings[0].amount, 70)
    assert.equal(db.state.orders[0].paymentStatus, 'paid')
  }
})

test('successful partial refunds release other earnings in the same pending withdrawal without deducting them', async () => {
  const { db, refunds } = refundSetup('SUCCESS', 'withdrawing')
  db.state.staff_earnings.push({ _id: 'other', orderId: 'other-order', staffOpenid: 'staff', amount: 30, originalAmount: 30, status: 'withdrawing', withdrawRequestId: 'withdraw' })
  db.state.withdraw_requests[0].earningIds.push('other')
  db.state.withdraw_requests[0].amount = 100
  await refunds.requestOrderRefund(db.state.orders[0], 10, 'partial refund', 'admin', 'admin', 'request')
  assert.equal(db.state.staff_earnings[0].amount, 63)
  assert.equal(db.state.staff_earnings[1].amount, 30)
  assert.equal(db.state.staff_earnings[1].status, 'available')
  assert.equal(db.state.staff_earnings[1].withdrawRequestId, '')
  assert.equal(db.state.withdraw_requests[0].status, 'rejected')
})

test('an earnings write failure after gateway success leaves a recoverable processing refund', async () => {
  const { db, refunds } = refundSetup('SUCCESS')
  const original = db.runTransaction
  let transactionCount = 0
  db.runTransaction = callback => {
    const fail = ++transactionCount === 2
    return original(tx => callback({ collection: name => {
      const chain = tx.collection(name)
      if (fail && name === 'staff_earnings') {
        const doc = chain.doc
        chain.doc = id => ({ ...doc(id), update: async () => { throw new Error('write unavailable') } })
      }
      return chain
    } }))
  }
  await assert.rejects(refunds.requestOrderRefund(db.state.orders[0], 100, 'full refund', 'admin', 'admin', 'request'), /write unavailable/)
  assert.equal(db.state.refunds[0].status, 'processing')
  assert.equal(db.state.staff_earnings[0].amount, 70)
  await refunds.syncOrderRefund(db.state.refunds[0])
  assert.equal(db.state.refunds[0].status, 'success')
  assert.equal(db.state.staff_earnings[0].amount, 0)
})

test('new earnings inherit in-progress refund holds and late completion accounts for succeeded refunds', async () => {
  const { db, context, refunds, setGatewayStatus } = refundSetup('PROCESSING')
  db.state.staff_earnings = []
  const result = await refunds.requestOrderRefund(db.state.orders[0], 10, 'partial refund', 'admin', 'admin', 'request')
  const earning = await context.ensureStaffEarning(db.state.orders[0])
  assert.deepEqual(earning.pendingRefundIds, [result._id])
  setGatewayStatus('SUCCESS')
  await refunds.syncOrderRefund(result)
  assert.equal(db.state.staff_earnings[0].amount, 63)

  const second = refundSetup('SUCCESS')
  second.db.state.staff_earnings = []
  await second.refunds.requestOrderRefund(second.db.state.orders[0], 10, 'partial refund', 'admin', 'admin', 'request')
  const late = await second.context.ensureStaffEarning(second.db.state.orders[0])
  assert.equal(late.amount, 63)
})

test('newbie eligibility query errors fail closed without issuing coupons', async () => {
  const db = createCollectionStore({ users: [{ _id: 'client', openid: 'client', roles: ['client'], status: 'active' }], coupon_templates: [{ _id: 'template', enabled: true, newbieOnly: true }] })
  const original = db.collection
  db.collection = name => {
    const chain = original(name)
    if (name === 'orders') chain.get = async () => { throw new Error('orders unavailable') }
    return chain
  }
  const api = loadCloudFunction('api', db, 'client')
  const result = await api.main({ module: 'coupon', action: 'claimNewbieCoupon', data: { templateId: 'template' } })
  assert.equal(result.ok, false)
  assert.equal((db.state.user_coupons || []).length, 0)
})

test('early-start approvals apply only to their exact session and assignment', async () => {
  const db = createCollectionStore({ orders: [{ _id: 'order', clientOpenid: 'client', staffOpenid: 'staff', assignedAt: new Date('2026-10-21T00:00:00Z'), startTime: '2026-10-23 10:00', endTime: '2026-10-23 11:00', status: 'assigned' }] })
  const context = createContext({ db, cloud: {} })
  const order = db.state.orders[0]
  db.state.order_early_start_requests = [{ _id: 'approval', orderId: 'order', ...context.getEarlyStartScope(order), status: 'approved', approvedAt: now(), createdAt: now() }]
  assert.equal(await context.canStartOrderSession(order, { index: 1, startTime: order.startTime }, now()), true)
  assert.equal(await context.canStartOrderSession(order, { index: 2, startTime: '2026-10-24 10:00' }, now()), false)
  assert.equal(await context.canStartOrderSession({ ...order, staffOpenid: 'other' }, { index: 1, startTime: order.startTime }, now()), false)
  assert.equal(await context.canStartOrderSession({ ...order, assignedAt: now() }, { index: 1, startTime: order.startTime }, now()), false)
})

test('multi-day end dates accept leap days and reject all invalid calendar boundaries', () => {
  const context = createContext({ db: createCollectionStore(), cloud: {} })
  const data = { orderType: 'multi_day', startTime: '2096-02-28 10:00', endTime: '2096-02-28 11:00', durationMinutes: 60 }
  assert.equal(context.buildOrderSessions({ ...data, endDate: '2096-02-29' }).length, 2)
  for (const endDate of ['2096-02-30', '2096-04-31', '2096-13-01', '2096-00-01', '2096-03-00']) {
    assert.throws(() => context.buildOrderSessions({ ...data, endDate }), /结束日期无效/)
  }
})

test('concurrent partial refunds commit each deduction once without losing holds or refund totals', async () => {
  const { db, refunds } = refundSetup('SUCCESS')
  optimistic(db)
  const order = structuredClone(db.state.orders[0])
  await Promise.all([
    refunds.requestOrderRefund(order, 50, 'first half', 'admin', 'admin', 'first'),
    refunds.requestOrderRefund(order, 50, 'second half', 'admin', 'admin', 'second')
  ])
  assert.equal(db.state.orders[0].refundedAmount, 100)
  assert.equal(db.state.staff_earnings[0].amount, 0)
  assert.equal(db.state.staff_earnings[0].deductedAmount, 70)
  assert.deepEqual(db.state.staff_earnings[0].pendingRefundIds, [])
  assert.equal(db.state.user_coupons[0].status, 'available')
})

test('a withdrawal racing refund reservation cannot retain funds from a successfully refunded order', async () => {
  const { db, context, refunds } = refundSetup('SUCCESS')
  optimistic(db)
  const results = await Promise.allSettled([
    refunds.requestOrderRefund(structuredClone(db.state.orders[0]), 100, 'full refund', 'admin', 'admin', 'refund'),
    context.createWithdrawRequest('staff', { amount: 70, accountName: '测试员工', accountNo: '12345678', clientRequestId: 'withdraw' })
  ])
  assert.equal(results[0].status, 'fulfilled', results[0].reason?.message)
  assert.equal(db.state.staff_earnings[0].amount, 0)
  assert.ok((db.state.withdraw_requests || []).every(row => row.status === 'rejected'))
})
