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
