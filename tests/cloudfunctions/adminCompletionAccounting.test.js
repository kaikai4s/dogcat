const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const optimistic = require('./optimisticTransactions')
const createContext = require('../../cloudfunctions/api/services/context')
const createExecution = require('../../cloudfunctions/api/services/serviceExecution')
const createAdmin = require('../../cloudfunctions/api/handlers/admin')
const createOrder = require('../../cloudfunctions/api/handlers/order')

const clock = new Date('2026-11-10T16:35:00Z')
function fixture(patch = {}, overrides = {}) {
  const db = createCollectionStore({
    users: [{ _id: 'admin', openid: 'admin', roles: ['admin'], status: 'active' },
      { _id: 'staff', openid: 'staff', roles: ['staff'], status: 'active' },
      { _id: 'client', openid: 'client', roles: ['client'], status: 'active', completedOrderCount: 2,
        points: 0, totalPoints: 0, retroCardCount: 0 }],
    staff_profiles: [{ _id: 'profile', openid: 'staff', staffLevel: 'certified', completedOrderCount: 0 }],
    platform_configs: [{ _id: 'settings', key: 'system_settings', value: { settlement: { staffCommissionRate: .7, settlementDelayDays: 0 } } }],
    orders: [{ _id: 'order', clientOpenid: 'client', clientUserId: 'client', staffOpenid: 'staff', staffUserId: 'staff', staffProfileId: 'profile',
      status: 'in_service', paymentStatus: 'paid', paymentChannel: 'wechat', payAmount: 100,
      startTime: '2026-11-10 00:00', endTime: '2026-11-11 01:00', activeSessionIndex: 2, currentSessionStartedAt: '2026-11-11 00:00',
      serviceSessions: [{ index: 1, startTime: '2026-11-10 00:00', endTime: '2026-11-10 01:00', status: 'completed', finishedAt: '2026-11-10 01:00' },
        { index: 2, startTime: '2026-11-11 00:00', endTime: '2026-11-11 01:00', status: 'in_service', startedAt: '2026-11-11 00:00' }], ...patch }]
  })
  optimistic(db)
  const c = { ...createContext({ db, cloud: {} }), now: () => clock, ...overrides }
  const execution = createExecution(c)
  const context = { ...c, ...execution }
  const admin = createAdmin(context)
  const order = createOrder(context)
  const complete = (data = {}) => admin('admin', 'manualCompleteOrder', {
    orderId: 'order', remark: '已核实全部服务凭证', deductAmount: 20, evidenceImages: ['cloud://admin-proof'], ...data
  })
  return { db, c, context, execution, admin, order, complete }
}

test('admin completion and staff retries share one count, points, milestone and earning', async () => {
  const f = fixture()
  await f.complete()
  await f.order('staff', 'finishService', { id: 'order' })
  await f.order('staff', 'finishService', { id: 'order' })
  assert.equal(f.db.state.users.find(user => user._id === 'client').completedOrderCount, 3)
  assert.equal(f.db.state.users.find(user => user._id === 'client').retroCardCount, 1)
  assert.equal(f.db.state.retro_card_logs.length, 1)
  assert.equal(f.db.state.point_logs.length, 1)
  assert.equal(f.db.state.staff_earnings.length, 1)
  assert.equal(f.db.state.staff_earnings[0].amount, 50)
  assert.equal(f.db.state.staff_profiles[0].completedOrderCount, 1)
  assert.equal(f.db.state.orders[0].clientOrderCounted, true)
  assert.equal(f.db.state.orders[0].pointsAwarded, true)
})

test('admin completion persists all visit completion states and preserves earlier finish times', async () => {
  const f = fixture()
  await f.complete()
  assert.deepEqual(f.db.state.orders[0].serviceSessions.map(session => session.status), ['completed', 'completed'])
  assert.equal(f.db.state.orders[0].serviceSessions[0].finishedAt, '2026-11-10 01:00')
  assert.equal(f.db.state.orders[0].serviceSessions[1].finishedAt.toISOString(), clock.toISOString())
  assert.equal(f.db.state.orders[0].lastCompletedSessionIndex, 2)
})

test('admin completion applies earlier refunds before reporting the actual earning', async () => {
  const f = fixture({ refundedAmount: 40, refundAmount: 40, refundStatus: 'partially_refunded' })
  const result = await f.complete()
  assert.equal(f.db.state.staff_earnings[0].amount, 22)
  assert.equal(result.finalStaffReward, 22)
  assert.equal(f.db.state.orders[0].adminManualStaffReward, 22)
  assert.equal(f.db.state.staff_earnings[0].deductAmount, 20)
  assert.equal(f.db.state.staff_earnings[0].deductedAmount, 28)
})

test('admin completion rolls back the order, rewards and evidence when earning creation fails', async () => {
  let fail = true
  const f = fixture({}, { ensureStaffEarning: async (...args) => {
    if (fail) throw new Error('earning write unavailable')
    return f.c.ensureStaffEarning(...args)
  } })
  // Retain the real implementation for the successful retry.
  const realEarning = createContext({ db: f.db, cloud: {} }).ensureStaffEarning
  f.c.ensureStaffEarning = realEarning
  await assert.rejects(f.complete(), /earning write unavailable/)
  assert.equal(f.db.state.orders[0].status, 'in_service')
  assert.equal(f.db.state.users.find(user => user._id === 'client').completedOrderCount, 2)
  assert.equal((f.db.state.point_logs || []).length, 0)
  assert.equal((f.db.state.checkin_logs || []).length, 0)
  assert.equal((f.db.state.retro_card_logs || []).length, 0)
  fail = false
  await f.complete()
  assert.equal(f.db.state.orders[0].status, 'completed')
  assert.equal(f.db.state.staff_earnings.length, 1)
  assert.equal(f.db.state.checkin_logs.length, 1)
})

for (const deductAmount of [-1, .005, 'invalid', Infinity]) {
  test(`admin completion rejects invalid deduction ${deductAmount} without completing the order`, async () => {
    const f = fixture()
    await assert.rejects(f.complete({ deductAmount }), /金额|扣除/)
    assert.equal(f.db.state.orders[0].status, 'in_service')
    assert.equal((f.db.state.staff_earnings || []).length, 0)
  })
}

test('concurrent admin completions create one evidence set and one set of rewards', async () => {
  const f = fixture()
  const results = await Promise.allSettled([f.complete(), f.complete()])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(f.db.state.checkin_logs.length, 1)
  assert.equal(f.db.state.users.find(user => user._id === 'client').completedOrderCount, 3)
  assert.equal(f.db.state.retro_card_logs.length, 1)
})

function addGroup(f) {
  f.db.state.orders[0] = { ...f.db.state.orders[0], groupBuyId: 'group', groupBuyStatus: 'formed' }
  f.db.state.orders.push({ ...structuredClone(f.db.state.orders[0]), _id: 'other', clientOpenid: 'other-client', clientUserId: 'other-client',
    status: 'assigned', activeSessionIndex: 0, currentSessionStartedAt: '',
    serviceSessions: f.db.state.orders[0].serviceSessions.map(session => ({ ...session, status: 'pending', finishedAt: '' })) })
  f.db.state.users.push({ _id: 'other-client', openid: 'other-client', roles: ['client'], status: 'active', completedOrderCount: 0 })
  f.db.state.pet_playground_groups = [{ _id: 'group', status: 'formed' }]
}

test('admin verified group household waits for its siblings and settles once through recovery', async () => {
  const f = fixture()
  addGroup(f)
  const result = await f.complete()
  assert.equal(result.status, 'day_completed')
  assert.equal(result.partialGroupCompleted, true)
  assert.equal(f.db.state.orders[0].groupCompletionPending, true)
  assert.equal((f.db.state.staff_earnings || []).length, 0)
  assert.equal(f.db.state.users.find(user => user._id === 'client').completedOrderCount, 2)
  await f.admin('admin', 'manualCompleteOrder', { orderId: 'other', remark: '第二户也已全部核实', deductAmount: 0 })
  await f.execution.retryPendingGroupCompletions()
  await f.execution.retryPendingGroupCompletions()
  assert.ok(f.db.state.orders.every(order => order.status === 'completed'))
  assert.equal(f.db.state.staff_earnings.length, 2)
  assert.equal(f.db.state.staff_earnings.find(earning => earning.orderId === 'order').amount, 50)
  assert.equal(f.db.state.staff_earnings.find(earning => earning.orderId === 'other').amount, 70)
  assert.equal(f.db.state.users.find(user => user._id === 'client').completedOrderCount, 3)
})

test('an order completed manually while its refund is pending keeps the earning blocked', async () => {
  const f = fixture({ paymentStatus: 'refunding', pendingEarningRefundIds: ['refund'] })
  await f.complete()
  assert.deepEqual(f.db.state.staff_earnings[0].pendingRefundIds, ['refund'])
})

test('manual group settlement recovers after accounting failure without losing approvals or deductions', async () => {
  let fail = false
  const f = fixture({}, { ensureStaffEarning: async (...args) => {
    if (fail) throw new Error('group earning unavailable')
    return f.c.ensureStaffEarning(...args)
  } })
  f.c.ensureStaffEarning = createContext({ db: f.db, cloud: {} }).ensureStaffEarning
  addGroup(f)
  await f.complete()
  fail = true
  await assert.rejects(f.admin('admin', 'manualCompleteOrder', { orderId: 'other', remark: '第二户核实完成', deductAmount: 10 }), /group earning unavailable/)
  assert.ok(f.db.state.orders.every(order => order.status === 'day_completed' && order.groupCompletionPending))
  assert.equal((f.db.state.staff_earnings || []).length, 0)
  assert.equal((f.db.state.point_logs || []).length, 0)
  assert.equal(f.db.state.staff_profiles[0].completedOrderCount, 0)
  // A refund confirmed during the wait must affect eventual earnings.
  f.db.state.orders[0] = { ...f.db.state.orders[0], refundedAmount: 40 }
  await assert.rejects(f.complete({ deductAmount: 0 }), /已核实/)
  assert.equal(f.db.state.orders[0].adminManualDeductEarning, 20)
  fail = false
  await f.execution.retryPendingGroupCompletions()
  await f.execution.retryPendingGroupCompletions()
  assert.ok(f.db.state.orders.every(order => order.status === 'completed' && !order.groupCompletionPending))
  assert.equal(f.db.state.staff_earnings.find(row => row.orderId === 'order').amount, 22)
  assert.equal(f.db.state.staff_earnings.find(row => row.orderId === 'other').amount, 60)
  assert.equal(f.db.state.staff_profiles[0].completedOrderCount, 2)
  assert.equal(f.db.state.checkin_logs.length, 1)
  assert.ok(f.db.state.orders.every(order => order.completedAt.toISOString() === clock.toISOString()))
})

test('admin completion racing normal completion commits rewards and profile count once', async () => {
  const f = fixture()
  const snapshot = structuredClone(f.db.state.orders[0])
  const results = await Promise.allSettled([
    f.complete(), f.execution.completeOrderService(snapshot, snapshot.serviceSessions[1], clock)
  ])
  assert.ok(results.some(result => result.status === 'fulfilled'))
  assert.equal(f.db.state.orders[0].status, 'completed')
  assert.equal(f.db.state.staff_earnings.length, 1)
  assert.equal(f.db.state.point_logs.length, 1)
  assert.equal(f.db.state.retro_card_logs.length, 1)
  assert.equal(f.db.state.users.find(user => user._id === 'client').completedOrderCount, 3)
  const manualWon = f.db.state.orders[0].completionType === 'admin_manual'
  assert.equal(f.db.state.staff_profiles[0].completedOrderCount, manualWon ? 1 : 0)
  assert.equal((f.db.state.checkin_logs || []).length, manualWon ? 1 : 0)
  assert.equal(f.db.state.staff_earnings[0].amount, manualWon ? 50 : 70)
})

test('failed earning calculation cannot silently complete an order with zero reward', async () => {
  const f = fixture({}, { calculateStaffEarningForOrder: async () => { throw new Error('commission unavailable') } })
  await assert.rejects(f.complete(), /commission unavailable/)
  assert.equal(f.db.state.orders[0].status, 'in_service')
  assert.equal((f.db.state.checkin_logs || []).length, 0)
})

test('foreign staff profile fails atomically before any completion accounting commits', async () => {
  const f = fixture()
  f.db.state.staff_profiles[0].openid = 'another-staff'
  await assert.rejects(f.complete(), /档案归属/)
  assert.equal(f.db.state.orders[0].status, 'in_service')
  assert.equal((f.db.state.point_logs || []).length, 0)
  assert.equal((f.db.state.checkin_logs || []).length, 0)
})

test('an existing ledger cannot silently ignore a new manual deduction', async () => {
  const f = fixture()
  await f.c.ensureStaffEarning(f.db.state.orders[0], clock)
  await assert.rejects(f.complete(), /收益与核实扣减不一致/)
  assert.equal(f.db.state.orders[0].status, 'in_service')
  assert.equal(f.db.state.staff_earnings[0].amount, 70)
  assert.equal((f.db.state.checkin_logs || []).length, 0)
})

for (const paymentStatus of ['unpaid', 'paying', 'refunded', 'failed']) {
  test(`manual completion rejects explicit ${paymentStatus} payment status`, async () => {
    const f = fixture({ paymentStatus })
    await assert.rejects(f.complete(), /支付状态/)
    assert.equal(f.db.state.orders[0].status, 'in_service')
    assert.equal((f.db.state.checkin_logs || []).length, 0)
  })
}

test('delivery failure leaves completed accounting and its durable notification intact', async () => {
  const f = fixture({}, { notifyOrder: async () => { throw new Error('notification unavailable') } })
  await f.complete()
  assert.equal(f.db.state.orders[0].status, 'completed')
  assert.equal(f.db.state.staff_earnings.length, 1)
  assert.equal(f.db.state.point_logs.length, 1)
  assert.equal(f.db.state.checkin_logs.length, 1)
  assert.equal(f.db.state.subscription_logs.filter(row => row.delivery && row.status === 'queued').length, 1)
})

test('manual group recovery never recounts a household committed before another household failed', async () => {
  let fail = false
  const f = fixture({}, { ensureStaffEarning: async (...args) => {
    if (fail && args[0]._id === 'other') throw new Error('second household earning unavailable')
    return f.c.ensureStaffEarning(...args)
  } })
  f.c.ensureStaffEarning = createContext({ db: f.db, cloud: {} }).ensureStaffEarning
  addGroup(f)
  await f.complete()
  fail = true
  await assert.rejects(f.admin('admin', 'manualCompleteOrder', { orderId: 'other', remark: '第二户核实完成' }), /second household earning unavailable/)
  assert.equal(f.db.state.orders[0].status, 'completed')
  assert.equal(f.db.state.orders[1].status, 'day_completed')
  assert.equal(f.db.state.staff_earnings.length, 1)
  fail = false
  await f.execution.retryPendingGroupCompletions()
  await f.execution.retryPendingGroupCompletions()
  assert.equal(f.db.state.staff_earnings.length, 2)
  assert.equal(f.db.state.point_logs.length, 2)
  assert.equal(f.db.state.retro_card_logs.length, 1)
  assert.equal(f.db.state.staff_profiles[0].completedOrderCount, 2)
  assert.equal(f.db.state.users.find(user => user._id === 'client').completedOrderCount, 3)
})

test('simultaneous manual verifications of two group households settle both exactly once', async () => {
  const f = fixture()
  addGroup(f)
  await Promise.all([f.complete(), f.admin('admin', 'manualCompleteOrder', { orderId: 'other', remark: '第二户已核实' })])
  await f.execution.retryPendingGroupCompletions()
  assert.ok(f.db.state.orders.every(order => order.status === 'completed' && !order.groupCompletionPending))
  assert.equal(f.db.state.staff_earnings.length, 2)
  assert.equal(f.db.state.staff_profiles[0].completedOrderCount, 2)
  assert.equal(f.db.state.checkin_logs.length, 1)
  assert.equal(f.db.state.point_logs.length, 2)
})

test('manual completion rejects temporary or malformed proof lists before recording evidence', async () => {
  for (const evidenceImages of [['wxfile://temporary.jpg'], ['https://temporary.test/proof.jpg'], [null], 'cloud://proof', Array(5).fill('cloud://proof')]) {
    const f = fixture()
    await assert.rejects(f.complete({ evidenceImages }), /凭证图片/)
    assert.equal(f.db.state.orders[0].status, 'in_service')
    assert.equal((f.db.state.checkin_logs || []).length, 0)
  }
})

test('legacy manual completion without accounting markers never increments an ambiguous historical count again', async () => {
  const f = fixture({ status: 'completed', completionType: 'admin_manual', completedAt: clock, adminManualDeductEarning: 20 })
  f.db.state.users.find(user => user._id === 'client').completedOrderCount = 3
  f.db.state.staff_profiles[0].completedOrderCount = 1
  await f.c.ensureStaffEarning(f.db.state.orders[0], clock)
  await f.execution.ensureOrderCompletionRewards(f.db.state.orders[0], clock)
  await f.execution.ensureOrderCompletionRewards(f.db.state.orders[0], clock)
  assert.equal(f.db.state.users.find(user => user._id === 'client').completedOrderCount, 3)
  assert.equal(f.db.state.staff_profiles[0].completedOrderCount, 1)
  assert.equal(f.db.state.orders[0].legacyManualAccountingNeedsReview, true)
  assert.equal(f.db.state.orders[0].completionOrdinalNeedsReview, true)
  assert.equal(f.db.state.staff_earnings.length, 1)
  assert.equal(f.db.state.point_logs.length, 1)
  assert.equal((f.db.state.retro_card_logs || []).length, 0)
})
