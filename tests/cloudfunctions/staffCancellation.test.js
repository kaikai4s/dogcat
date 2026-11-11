const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createCollectionStore } = require('./helpers')
const optimistic = require('./optimisticTransactions')
const createCancellation = require('../../cloudfunctions/api/services/staffCancellation')
const createRefunds = require('../../cloudfunctions/api/services/refunds')
const createLifecycle = require('../../cloudfunctions/api/services/paymentLifecycle')

function setup(patch = {}) {
  let clock = new Date('2026-09-28T04:00:00Z')
  const db = createCollectionStore({ users: [{ _id: 'u', openid: 'staff', roles: ['staff'], status: 'active' }], orders: [{
    _id: 'o', orderNo: 'ORDER', staffOpenid: 'staff', staffUserId: 'u', staffProfileId: 'p', staffName: 'Private Name',
    clientOpenid: 'client', publishMode: 'open', status: 'assigned', paymentStatus: 'paid', payAmount: 100,
    assignedAt: new Date(clock - 5 * 60000), startTime: new Date(+clock + 120 * 60000), ...patch
  }], payment_events: [], refunds: [], staff_deposit_evidences: [] })
  optimistic(db)
  let messageCalls = 0
  let subscriptionCalls = 0
  const context = {
    db, crypto, now: () => new Date(clock), toTimeValue: value => value ? new Date(value).getTime() : 0,
    amountYuanToFen: value => Math.round(Number(value) * 100), createRefundNo: () => 'REFUND',
    getSystemSettings: async () => ({ payment: { mode: 'mock' } }), assertPaymentModeAllowed: () => {},
    getPayableOrder: async id => ({ collectionName: 'orders', order: db.state.orders.find(o => o._id === id) }),
    appendOrderClientMessage: async (order, message) => { messageCalls++; assert.equal(message.unreadForClient, true); assert.equal(order.staffOpenid, undefined); return { _id: 'm' } },
    notifyOrder: async () => { subscriptionCalls++; return { status: 'sent' } }
  }
  Object.assign(context, createRefunds(context))
  Object.assign(context, createLifecycle(context))
  const build = () => createCancellation(context)
  let service = build()
  async function data() {
    return { orderId: 'o', assignmentToken: (await service.getStaffCancellationQuote('staff', { orderId: 'o' })).assignmentToken, reason: '无法履约', requestId: 'request' }
  }
  return { db, context, get service() { return service }, rebuild() { service = build() }, data,
    setClock: value => { clock = new Date(value) }, counts: () => ({ messageCalls, subscriptionCalls }) }
}

test('group cancellation rejects any household that has departed, started, or completed', async () => {
  for (const status of ['on_the_way', 'in_service', 'day_completed', 'completed']) {
    const s = setup({ groupBuyId: 'g' })
    s.db.state.orders.push({ ...s.db.state.orders[0], _id: 'sibling', status })
    const input = await s.data()
    await assert.rejects(() => s.service.cancelStaffAcceptedOrder('staff', input), /已开始履约或不可取消/)
    assert.equal(s.db.state.orders[0].status, 'assigned')
    assert.equal(s.db.state.orders[1].status, status)
    assert.equal(s.db.state.payment_events.length, 0)
  }
})

test('group cancellation reads past unpaid history and atomically releases every paid household', async () => {
  const s = setup({ groupBuyId: 'g' })
  s.db.state.orders.push(...Array.from({ length: 110 }, (_, i) => ({ _id: `history_${String(i).padStart(3, '0')}`, groupBuyId: 'g', status: 'pending_pay', paymentStatus: 'unpaid' })),
    { ...s.db.state.orders[0], _id: 'z_sibling', clientOpenid: 'neighbor' })
  await s.service.cancelStaffAcceptedOrder('staff', await s.data())
  const paid = s.db.state.orders.filter(order => order.paymentStatus === 'paid')
  assert.equal(paid.length, 2)
  assert.ok(paid.every(order => order.status === 'paid' && !order.staffOpenid))
  assert.equal(s.db.state.payment_events.length, 1)
})

test('group cancellation cannot split off a household while its sibling refund is processing', async () => {
  const s = setup({ groupBuyId: 'g' })
  s.db.state.orders.push({ ...s.db.state.orders[0], _id: 'sibling', paymentStatus: 'refunding' })
  await assert.rejects(s.service.cancelStaffAcceptedOrder('staff', await s.data()), /不可取消|退款/)
  assert.ok(s.db.state.orders.every(order => order.status === 'assigned' && order.staffOpenid === 'staff'))
  assert.equal(s.db.state.payment_events.length, 0)
})

test('group cancellation query failure never cancels only the entry household', async () => {
  const s = setup({ groupBuyId: 'g' })
  const input = await s.data()
  const run = s.db.runTransaction
  s.db.runTransaction = fn => run(tx => fn({ collection(name) {
    const collection = tx.collection(name)
    if (name === 'orders') collection.where = () => { throw new Error('group query unavailable') }
    return collection
  } }))
  await assert.rejects(() => s.service.cancelStaffAcceptedOrder('staff', input), /group query unavailable/)
  assert.equal(s.db.state.orders[0].status, 'assigned')
  assert.equal(s.db.state.payment_events.length, 0)
})

test('open cutoff overrides grace, exact grace boundary free and later pending review', async () => {
  const s = setup({ startTime: new Date('2026-09-28T04:30:00Z') })
  assert.equal((await s.service.getStaffCancellationQuote('staff', { orderId: 'o' })).canCancel, false)
  const a = setup({ assignedAt: new Date('2026-09-28T03:50:00Z') })
  const q = await a.service.getStaffCancellationQuote('staff', { orderId: 'o' })
  assert.equal(q.isFree, true)
  assert.equal(q.amountPendingReview, false)
  assert.equal(JSON.stringify(q).includes('staffOpenid'), false)
  assert.equal(JSON.stringify(q).includes('Private Name'), false)
  a.setClock('2026-09-28T04:00:00.001Z')
  assert.equal((await a.service.getStaffCancellationQuote('staff', { orderId: 'o' })).amountPendingReview, true)
})

test('concurrent open cancellation restores paid urgent pool and creates one pending evidence/event', async () => {
  const s = setup({ assignedAt: new Date('2026-09-28T03:40:00Z'), isUrgent: true, urgentStaffReward: 77,
    requestedStaffOpenid: 'staff', originalStaffOpenid: 'staff', previousStaffRecords: [{ staffOpenid: 'staff' }],
    currentLocation: { latitude: 1 }, currentSessionStartedAt: new Date(),
    serviceSessions: [{ index: 1, date: '2026-09-28', startTime: 'start', endTime: 'end', startedAt: new Date() }] })
  const data = await s.data()
  const results = await Promise.all([s.service.cancelStaffAcceptedOrder('staff', data), s.service.cancelStaffAcceptedOrder('staff', { ...data, requestId: 'retry' })])
  assert.deepEqual(results[0], results[1])
  const order = s.db.state.orders[0]
  assert.equal(order.status, 'paid')
  assert.equal(order.paymentStatus, 'paid')
  assert.equal(order.staffOpenid, '')
  assert.equal(order.requestedStaffOpenid, '')
  assert.equal(order.originalStaffOpenid, '')
  assert.deepEqual(order.previousStaffRecords, [])
  assert.equal(order.assignedAt, null)
  assert.equal(order.currentLocation, null)
  assert.equal(order.currentSessionStartedAt, null)
  assert.equal(order.serviceSessions[0].startedAt, undefined)
  assert.equal(order.isUrgent, true)
  assert.equal(order.urgentStaffReward, 77)
  assert.deepEqual(order.cancelledStaffOpenids, ['staff'])
  assert.equal(s.db.state.staff_deposit_evidences.length, 1)
  assert.equal(s.db.state.staff_deposit_evidences[0].amountPendingReview, true)
  assert.equal(s.db.state.staff_deposit_evidences[0].deductAmount, 0)
  assert.equal(s.db.state.staff_deposit_evidences[0].status, 'pending')
  assert.equal(s.db.state.payment_events.length, 1)
  assert.equal(s.db.state.refunds.length, 0)
  assert.deepEqual(s.counts(), { messageCalls: 1, subscriptionCalls: 1 })
})

test('free open cancellation has no evidence; old token cannot cancel a new assignment', async () => {
  const s = setup()
  const data = await s.data()
  await s.service.cancelStaffAcceptedOrder('staff', data)
  assert.equal(s.db.state.staff_deposit_evidences.length, 0)
  Object.assign(s.db.state.orders[0], { status: 'assigned', staffOpenid: 'staff', assignedAt: new Date('2026-09-28T03:59:00Z') })
  await s.service.cancelStaffAcceptedOrder('staff', data)
  assert.equal(s.db.state.orders[0].status, 'assigned')
  const fresh = await s.data()
  assert.notEqual(data.assignmentToken, fresh.assignmentToken)
  const t = setup()
  const stale = await t.data()
  t.db.state.orders[0].assignedAt = new Date('2026-09-28T03:59:00Z')
  await assert.rejects(t.service.cancelStaffAcceptedOrder('staff', stale), /接单记录已变化/)
})

test('admin role alone, other staff, revoked role and non-assigned statuses cannot cancel', async () => {
  const s = setup()
  s.db.state.users.push({ _id: 'admin', openid: 'admin', roles: ['admin'], status: 'active' }, { _id: 'u2', openid: 'other', roles: ['staff'], status: 'active' })
  await assert.rejects(s.service.getStaffCancellationQuote('admin', { orderId: 'o' }), /仅当前有效/)
  await assert.rejects(s.service.getStaffCancellationQuote('other', { orderId: 'o' }), /当前宠托师/)
  const data = await s.data()
  s.db.state.users[0].roles = ['client']
  await assert.rejects(s.service.cancelStaffAcceptedOrder('staff', data), /仅当前有效/)
  for (const status of ['paid', 'on_the_way', 'in_service', 'completed', 'cancelled']) {
    const t = setup({ status })
    assert.equal((await t.service.getStaffCancellationQuote('staff', { orderId: 'o' })).canCancel, false)
    await assert.rejects(t.service.cancelStaffAcceptedOrder('staff', await t.data()), /未开始履约/)
  }
})

test('direct exact 10 min is free, later blocked; concurrent calls reserve one full refund', async () => {
  const s = setup({ publishMode: 'direct', assignedAt: new Date('2026-09-28T03:50:00Z'), requestedStaffOpenid: 'staff' })
  assert.equal((await s.service.getStaffCancellationQuote('staff', { orderId: 'o' })).isFree, true)
  const data = await s.data()
  await Promise.all([s.service.cancelStaffAcceptedOrder('staff', data), s.service.cancelStaffAcceptedOrder('staff', data)])
  assert.equal(s.db.state.refunds.length, 1)
  assert.equal(s.db.state.refunds[0].refundAmount, 100)
  assert.equal(s.db.state.orders[0].status, 'cancelled')
  assert.equal(s.db.state.orders[0].paymentStatus, 'refunding')
  assert.equal(s.db.state.orders[0].staffOpenid, '')
  assert.equal(s.db.state.orders[0].requestedStaffOpenid, '')
  assert.equal(s.db.state.staff_deposit_evidences.length, 0)
  const event = s.db.state.payment_events.find(e => e.eventType === 'staff_cancellation')
  assert.deepEqual(event.assignedAt, new Date('2026-09-28T03:50:00Z'))
  const t = setup({ publishMode: 'direct', assignedAt: new Date('2026-09-28T03:49:59.999Z') })
  assert.equal((await t.service.getStaffCancellationQuote('staff', { orderId: 'o' })).canCancel, false)
})

test('direct refund guard rechecks assignment, role and elapsed time before reserving money', async () => {
  for (const change of [s => { s.db.state.orders[0].assignedAt = new Date('2026-09-28T03:59:00Z') },
    s => { s.db.state.users[0].roles = [] }, s => { s.setClock('2026-09-28T06:00:00Z') },
    s => { s.db.state.orders[0].status = 'in_service' }]) {
    const s = setup({ publishMode: 'direct' })
    const data = await s.data()
    const original = s.context.createRefundForOrder
    s.context.createRefundForOrder = (...args) => { change(s); return original(...args) }
    s.rebuild()
    await assert.rejects(s.service.cancelStaffAcceptedOrder('staff', data))
    assert.equal(s.db.state.refunds.length, 0)
    assert.equal(s.db.state.payment_events.length, 0)
  }
})

test('financial validation failure rolls back cancellation event and staff access changes', async () => {
  const s = setup({ publishMode: 'direct', refundAmount: 20 })
  await assert.rejects(s.service.cancelStaffAcceptedOrder('staff', await s.data()), /历史退款金额/)
  assert.equal(s.db.state.orders[0].status, 'assigned')
  assert.equal(s.db.state.orders[0].staffOpenid, 'staff')
  assert.equal(s.db.state.payment_events.length, 0)
  assert.equal(s.db.state.refunds.length, 0)
})

test('notification retries preserve successful message stage and survive failed subscription', async () => {
  const s = setup()
  let attempts = 0
  s.context.notifyOrder = async () => (++attempts === 1 ? { status: 'failed' } : { status: 'sent' })
  s.rebuild()
  await s.service.cancelStaffAcceptedOrder('staff', await s.data())
  assert.equal(s.db.state.payment_events[0].messageDone, true)
  assert.equal(s.db.state.payment_events[0].notificationStatus, 'pending')
  await s.service.retryStaffCancellationNotifications()
  assert.equal(attempts, 2)
  assert.equal(s.counts().messageCalls, 1)
  assert.equal(s.db.state.payment_events[0].notificationStatus, 'done')
})

for (const failure of ['message_throw', 'message_empty', 'subscription_throw', 'subscription_failed']) {
  test(`group cancellation retries a sibling ${failure} without repeating successful households`, async () => {
    const s = setup({ groupBuyId: 'g' })
    for (const id of ['a', 'b', 'c']) s.db.state.orders.push({ ...s.db.state.orders[0], _id: id, clientOpenid: `client_${id}` })
    const messages = new Map()
    const subscriptions = new Map()
    const deliveryKeys = new Map()
    let failed = false
    s.context.appendOrderClientMessage = async (order, message) => {
      messages.set(order._id, (messages.get(order._id) || 0) + 1)
      if (order._id === 'b' && failure.startsWith('message') && !failed) {
        failed = true
        if (failure === 'message_throw') throw new Error('neighbor message unavailable')
        return null
      }
      assert.ok(message.idempotencyKey)
      return { _id: `message_${order._id}` }
    }
    s.context.notifyOrder = async (openid, key, order, detail, role, deliveryKey) => {
      subscriptions.set(order._id, (subscriptions.get(order._id) || 0) + 1)
      const keys = deliveryKeys.get(order._id) || []
      deliveryKeys.set(order._id, [...keys, deliveryKey])
      if (order._id === 'b' && failure.startsWith('subscription') && !failed) {
        failed = true
        if (failure === 'subscription_throw') throw new Error('neighbor subscription unavailable')
        return { status: 'failed' }
      }
      return { status: 'sent' }
    }
    s.rebuild()
    const result = await s.service.cancelStaffAcceptedOrder('staff', await s.data())
    assert.equal(result.cancelled, true)
    assert.ok(s.db.state.orders.every(order => order.status === 'paid' && !order.staffOpenid))
    const event = s.db.state.payment_events.find(row => row.eventType === 'staff_cancellation')
    assert.equal(event.notificationStatus, 'pending')
    assert.equal(event.messageDone, true)
    assert.equal(event.subscriptionDone, true)
    assert.equal(messages.get('c'), 1)
    assert.equal(subscriptions.get('c'), 1)
    await s.service.retryStaffCancellationNotifications()
    assert.equal(s.db.state.payment_events.find(row => row._id === event._id).notificationStatus, 'done')
    for (const id of ['o', 'a', 'c']) {
      assert.equal(messages.get(id), 1)
      assert.equal(subscriptions.get(id), 1)
    }
    assert.equal(messages.get('b'), failure.startsWith('message') ? 2 : 1)
    assert.equal(subscriptions.get('b'), failure.startsWith('subscription') ? 2 : 1)
    for (const keys of deliveryKeys.values()) {
      assert.ok(keys[0])
      assert.equal(new Set(keys).size, 1)
    }
    await s.service.retryStaffCancellationNotifications()
    assert.equal(messages.get('b'), failure.startsWith('message') ? 2 : 1)
    assert.equal(subscriptions.get('b'), failure.startsWith('subscription') ? 2 : 1)
  })
}

test('direct staff cancellation refunds only the balance after earlier compensation', async () => {
  const s = setup({ publishMode: 'direct' })
  enableRefundSettlement(s)
  await s.context.requestOrderRefund(structuredClone(s.db.state.orders[0]), 20, '此前补偿', 'admin_manual', 'admin', 'compensation')
  const quote = await s.service.getStaffCancellationQuote('staff', { orderId: 'o' })
  assert.equal(quote.refundAmount, 80)
  const input = await s.data()
  const result = await s.service.cancelStaffAcceptedOrder('staff', input)
  assert.equal(result.refundAmount, 80)
  assert.equal(s.db.state.orders[0].refundedAmount, 100)
  assert.equal(s.db.state.orders[0].paymentStatus, 'refunded')
  assert.equal(s.db.state.orders[0].staffOpenid, '')
  assert.deepEqual(s.db.state.refunds.map(row => row.refundAmount), [20, 80])
  assert.equal(s.db.state.payment_events.find(row => row.eventType === 'staff_cancellation').refundAmount, 80)
  await s.service.cancelStaffAcceptedOrder('staff', input)
  assert.equal(s.db.state.refunds.length, 2)
})

test('direct staff cancellation rechecks the latest partial compensation before reservation', async () => {
  const s = setup({ publishMode: 'direct' })
  enableRefundSettlement(s)
  const refund = s.context.createRefundForOrder
  s.context.createRefundForOrder = async (...args) => {
    await s.context.requestOrderRefund(structuredClone(s.db.state.orders[0]), 20, '并发补偿', 'admin_manual', 'admin', 'compensation')
    return refund(...args)
  }
  s.rebuild()
  await assert.rejects(s.service.cancelStaffAcceptedOrder('staff', await s.data()), /退款金额已变化/)
  assert.equal(s.db.state.orders[0].status, 'assigned')
  assert.equal(s.db.state.orders[0].staffOpenid, 'staff')
  assert.equal(s.db.state.orders[0].refundedAmount, 20)
  assert.equal(s.db.state.payment_events.filter(row => row.eventType === 'staff_cancellation').length, 0)
  assert.equal(s.db.state.refunds.length, 1)
})

function enableRefundSettlement(s) {
  Object.assign(s.context, require('../../cloudfunctions/api/services/refundEarnings')({ ...s.context,
    parseDateValue: require('../../cloudfunctions/api/utils/time').parseDateValue }))
  Object.assign(s.context, createRefunds(s.context))
  Object.assign(s.context, createLifecycle(s.context))
  s.rebuild()
}

test('message failure leaves durable pending event and is retried before subscription', async () => {
  const s = setup()
  const append = s.context.appendOrderClientMessage
  let attempts = 0
  s.context.appendOrderClientMessage = (...args) => { if (++attempts === 1) throw new Error('message unavailable'); return append(...args) }
  s.rebuild()
  await s.service.cancelStaffAcceptedOrder('staff', await s.data())
  assert.equal(s.db.state.payment_events[0].messageDone, false)
  assert.equal(s.counts().subscriptionCalls, 0)
  await s.service.retryStaffCancellationNotifications()
  assert.equal(attempts, 2)
  assert.equal(s.counts().subscriptionCalls, 1)
  assert.equal(s.db.state.payment_events[0].notificationStatus, 'done')
})

test('refund dispatch error after commit does not undo cancellation or require a second refund', async () => {
  const s = setup({ publishMode: 'direct' })
  const original = s.context.createRefundForOrder
  s.context.createRefundForOrder = async (...args) => { await original(...args); throw new Error('ambiguous gateway result') }
  s.rebuild()
  const data = await s.data()
  assert.equal((await s.service.cancelStaffAcceptedOrder('staff', data)).cancelled, true)
  await s.service.cancelStaffAcceptedOrder('staff', data)
  assert.equal(s.db.state.refunds.length, 1)
  assert.equal(s.db.state.orders[0].status, 'cancelled')
})
