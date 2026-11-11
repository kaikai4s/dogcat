const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const optimistic = require('./optimisticTransactions')
const createContext = require('../../cloudfunctions/api/services/context')
const createAssignment = require('../../cloudfunctions/api/services/orderAssignment')

const clock = new Date('2026-11-12T16:00:00Z')
const at = hours => new Date(clock.getTime() + hours * 3600000)
function fixture(patch = {}, overrides = {}) {
  const order = { _id: 'order', clientOpenid: 'client', staffOpenid: '', status: 'paid', paymentStatus: 'paid', payAmount: 100,
    startTime: at(5), endTime: at(6), paidAt: at(-2), createdAt: at(-2), ...patch }
  const db = createCollectionStore({ orders: [order],
    users: [{ _id: 'user', openid: 'staff', roles: ['staff'], status: 'active' }],
    staff_profiles: [{ _id: 'profile', openid: 'staff', auditStatus: 'approved', staffLevel: 'certified' }],
    pet_playground_groups: order.groupBuyId ? [{ _id: order.groupBuyId, status: 'formed', formedAt: at(-2).getTime() }] : [] })
  optimistic(db)
  const c = createContext({ db, cloud: {} })
  const service = createAssignment({ ...c, now: () => clock, notifyStaffDirectOrder: async () => ({ status: 'skipped' }), ...overrides })
  const assign = () => service.assignOrderAtomically('order', structuredClone(db.state.orders.find(row => row._id === 'order')),
    { staffOpenid: 'staff', staffUserId: 'user', staffProfileId: 'profile', status: 'assigned' }, { admin: true })
  return { db, c, service, assign }
}

for (const paymentStatus of [undefined, 'unpaid', 'paying', 'refunding', 'refunded']) {
  test(`assignment transaction rejects a paid-status order whose payment is ${paymentStatus}`, async () => {
    const f = fixture({ paymentStatus })
    await assert.rejects(f.assign(), /支付|退款/)
    assert.equal(f.db.state.orders[0].status, 'paid')
    assert.equal(f.db.state.orders[0].staffOpenid, '')
    assert.equal((f.db.state.subscription_deliveries || []).length, 0)
    assert.equal(f.db.state.users[0].staffAssignmentRevision, undefined)
  })
}

test('formed group assignment respects the exact Beijing two-hour expiry boundary', async () => {
  const patch = { groupBuyId: 'group', groupBuyStatus: 'formed', startTime: at(2), endTime: at(3) }
  const due = fixture(patch)
  await assert.rejects(due.assign(), /过期|截止|2小时/)
  assert.equal(due.db.state.orders[0].status, 'paid')
  const early = fixture(patch, { now: () => new Date(clock.getTime() - 1) })
  assert.equal((await early.assign()).status, 'assigned')
})

test('direct auto-accept scans all pages beyond ineligible old orders', async () => {
  const f = fixture({ publishMode: 'direct', requestedStaffOpenid: 'staff' })
  f.db.state.orders.unshift(...Array.from({ length: 155 }, (_, i) => ({ ...f.db.state.orders[0],
    _id: `a_old_${String(i).padStart(3, '0')}`, requestedStaffOpenid: '' })))
  assert.deepEqual(await f.service.autoAcceptDueDirectOrders(), ['order'])
  assert.equal(f.db.state.orders.find(row => row._id === 'order').status, 'assigned')
  assert.ok(f.db.state.orders.filter(row => row._id !== 'order').every(row => row.status === 'paid'))
})

test('auto-accept fallback republishes an unserved direct order when its staff remains revoked', async () => {
  const f = fixture({ publishMode: 'direct', requestedStaffOpenid: 'staff', requestedStaffSnapshot: { displayName: 'staff' } })
  f.db.state.staff_profiles[0].auditStatus = 'revoked'
  assert.deepEqual(await f.service.autoAcceptDueDirectOrders(), [])
  assert.equal(f.db.state.orders[0].publishMode, 'open')
  assert.equal(f.db.state.orders[0].requestedStaffOpenid, '')
  assert.equal(f.db.state.orders[0].requestedStaffSnapshot, null)
  assert.equal(f.db.state.order_timeline.length, 1)
})

test('auto-accept republishes a direct order after the appointed user loses the staff role', async () => {
  const f = fixture({ publishMode: 'direct', requestedStaffOpenid: 'staff' })
  f.db.state.users[0].roles = ['client']
  assert.deepEqual(await f.service.autoAcceptDueDirectOrders(), [])
  assert.equal(f.db.state.orders[0].publishMode, 'open')
  assert.equal(f.db.state.orders[0].requestedStaffOpenid, '')
})

for (const missing of ['staff_profiles', 'users', 'both']) {
  test(`auto-accept republishes a paid direct order when its appointed ${missing} is missing`, async () => {
    const f = fixture({ publishMode: 'direct', requestedStaffOpenid: 'staff' })
    if (missing !== 'users') f.db.state.staff_profiles = []
    if (missing !== 'staff_profiles') f.db.state.users = []
    assert.deepEqual(await f.service.autoAcceptDueDirectOrders(), [])
    assert.equal(f.db.state.orders[0].publishMode, 'open')
    assert.equal(f.db.state.orders[0].requestedStaffOpenid, '')
    assert.equal(f.db.state.order_timeline.length, 1)
  })
}

for (const missing of ['staff_profiles', 'users']) {
  test(`auto-accept keeps a direct appointment if missing ${missing} reappears before the transaction`, async () => {
    const f = fixture({ publishMode: 'direct', requestedStaffOpenid: 'staff' })
    const original = structuredClone(f.db.state[missing][0])
    f.db.state[missing] = []
    let checked = false
    const run = f.db.runTransaction
    f.db.runTransaction = callback => {
      checked = true
      f.db.state[missing] = [{ ...original, _id: 'restored_identity' }]
      return run(callback)
    }
    assert.deepEqual(await f.service.autoAcceptDueDirectOrders(), [])
    assert.equal(checked, true)
    assert.equal(f.db.state.orders[0].publishMode, 'direct')
    assert.equal((f.db.state.order_timeline || []).length, 0)
  })
}

for (const phase of ['lookup', 'transaction']) {
  test(`auto-accept does not treat ${phase} identity read failure as a deleted profile`, async () => {
    const f = fixture({ publishMode: 'direct', requestedStaffOpenid: 'staff' })
    f.db.state.staff_profiles = []
    if (phase === 'lookup') {
      const collection = f.db.collection
      f.db.collection = name => {
        const query = collection(name)
        if (name === 'staff_profiles') query.get = async () => { throw new Error('profile database unavailable') }
        return query
      }
    } else {
      const run = f.db.runTransaction
      f.db.runTransaction = callback => run(tx => callback({ collection(name) {
        if (name === 'staff_profiles') throw new Error('profile database unavailable')
        return tx.collection(name)
      } }))
    }
    assert.deepEqual(await f.service.autoAcceptDueDirectOrders(), [])
    assert.equal(f.db.state.orders[0].publishMode, 'direct')
    assert.equal((f.db.state.order_timeline || []).length, 0)
  })
}

test('missing-profile fallback preserves a paid direct order concurrently assigned elsewhere', async () => {
  const f = fixture({ publishMode: 'direct', requestedStaffOpenid: 'staff' })
  f.db.state.staff_profiles = []
  let checked = false
  const run = f.db.runTransaction
  f.db.runTransaction = callback => {
    checked = true
    f.db.state.orders[0] = { ...f.db.state.orders[0], status: 'assigned', staffOpenid: 'other' }
    return run(callback)
  }
  assert.deepEqual(await f.service.autoAcceptDueDirectOrders(), [])
  assert.equal(checked, true)
  assert.equal(f.db.state.orders[0].publishMode, 'direct')
  assert.equal(f.db.state.orders[0].staffOpenid, 'other')
})

test('auto-accept fallback preserves a direct appointment if the staff role is restored before its transaction', async () => {
  const f = fixture({ publishMode: 'direct', requestedStaffOpenid: 'staff' })
  f.db.state.users[0].roles = ['client']
  const run = f.db.runTransaction
  f.db.runTransaction = callback => {
    f.db.state.users[0] = { ...f.db.state.users[0], roles: ['staff'] }
    return run(callback)
  }
  assert.deepEqual(await f.service.autoAcceptDueDirectOrders(), [])
  assert.equal(f.db.state.orders[0].publishMode, 'direct')
  assert.equal((f.db.state.order_timeline || []).length, 0)
})

test('auto-accept fallback rechecks staff eligibility before removing the direct appointment', async () => {
  const f = fixture({ publishMode: 'direct', requestedStaffOpenid: 'staff' })
  f.db.state.staff_profiles[0].auditStatus = 'revoked'
  const run = f.db.runTransaction
  f.db.runTransaction = callback => {
    f.db.state.staff_profiles[0] = { ...f.db.state.staff_profiles[0], auditStatus: 'approved' }
    return run(callback)
  }
  assert.deepEqual(await f.service.autoAcceptDueDirectOrders(), [])
  assert.equal(f.db.state.orders[0].publishMode, 'direct')
  assert.equal((f.db.state.order_timeline || []).length, 0)
})

test('auto-accept fallback cannot republish an order already assigned by another operation', async () => {
  const f = fixture({ publishMode: 'direct', requestedStaffOpenid: 'staff' })
  f.db.state.staff_profiles[0].auditStatus = 'revoked'
  const collection = f.db.collection
  let changed = false
  f.db.collection = name => {
    const query = collection(name)
    if (name === 'staff_profiles') {
      const get = query.get.bind(query)
      query.get = async () => {
        if (!changed) {
          changed = true
          f.db.state.orders[0] = { ...f.db.state.orders[0], status: 'assigned', staffOpenid: 'other_staff' }
        }
        return get()
      }
    }
    return query
  }
  assert.deepEqual(await f.service.autoAcceptDueDirectOrders(), [])
  assert.equal(f.db.state.orders[0].status, 'assigned')
  assert.equal(f.db.state.orders[0].staffOpenid, 'other_staff')
  assert.equal(f.db.state.orders[0].publishMode, 'direct')
  assert.equal(f.db.state.orders[0].requestedStaffOpenid, 'staff')
  assert.equal((f.db.state.order_timeline || []).length, 0)
})

test('availability shows the portion of an overnight visit on both occupied Beijing days', async () => {
  const f = fixture({ staffOpenid: 'staff', status: 'assigned', startTime: '2026-11-12T15:30:00Z', endTime: '2026-11-12T16:30:00Z' })
  const days = await f.c.buildStaffAvailability({ openid: 'staff' }, '2026-11-12', 2)
  assert.deepEqual(days.map(day => day.busyOrders.length), [1, 1])
  assert.equal(f.c.toTimeValue(days[0].busyOrders[0].startTime), f.c.toTimeValue('2026-11-12 23:30'))
  assert.equal(f.c.toTimeValue(days[0].busyOrders[0].endTime), f.c.toTimeValue('2026-11-13 00:00'))
  assert.equal(f.c.toTimeValue(days[1].busyOrders[0].startTime), f.c.toTimeValue('2026-11-13 00:00'))
  assert.equal(f.c.toTimeValue(days[1].busyOrders[0].endTime), f.c.toTimeValue('2026-11-13 00:30'))
  f.db.state.orders[0].endTime = '2026-11-12T16:00:00Z'
  const exact = await f.c.buildStaffAvailability({ openid: 'staff' }, '2026-11-12', 2)
  assert.deepEqual(exact.map(day => day.busyOrders.length), [1, 0])
})

test('availability reads the current date exception beyond a hundred historical exceptions', async () => {
  const f = fixture()
  f.db.state.orders = []
  f.db.state.staff_schedule_exceptions = [
    ...Array.from({ length: 110 }, (_, i) => ({ _id: `history_${i}`, staffOpenid: 'staff', dateKey: '2025-01-01', status: 'available', slots: [{ start: 0, end: 24 }] })),
    { _id: 'z_today', staffOpenid: 'staff', dateKey: '2026-11-13', status: 'unavailable' }
  ]
  const collection = f.db.collection
  f.db.collection = name => {
    const query = collection(name)
    if (name === 'staff_schedule_exceptions') {
      const get = query.get.bind(query)
      query.get = async () => {
        if (query._limit === null) query.limit(100)
        return get()
      }
    }
    return query
  }
  const days = await f.c.buildStaffAvailability({ openid: 'staff' }, '2026-11-13', 1)
  assert.equal(days[0].status, 'unavailable')
  assert.equal(days[0].source, 'exception')
})

for (const refundedAmount of [0, 20]) {
  test(`profit summary separates confirmed refunds from pending amounts (already refunded ${refundedAmount})`, () => {
    const f = fixture()
    const order = { payAmount: 100, status: 'cancelled', paymentStatus: 'refunding', refundStatus: 'processing',
      paidAt: at(-2), refundAmount: 100, refundedAmount }
    const summary = f.c.buildOrderProfitSummary(order)
    assert.equal(summary.refundAmount, refundedAmount)
    assert.equal(summary.pendingRefundAmount, 100 - refundedAmount)
    assert.equal(summary.netPayAmount, 100 - refundedAmount)
    assert.equal(summary.settlementStatus, 'refunding')
    assert.match(summary.settlementStatusText, /退款处理中/)
  })
}

for (const paymentStatus of ['unpaid', 'paying', 'closed']) {
  test(`profit summary does not invent revenue for cancelled ${paymentStatus} orders`, () => {
    const f = fixture()
    const summary = f.c.buildOrderProfitSummary({ payAmount: 100, status: 'cancelled', paymentStatus })
    assert.equal(summary.hasPayment, false)
    assert.equal(summary.netPayAmount, 0)
    assert.equal(summary.staffReward, 0)
    assert.equal(summary.platformProfit, 0)
  })
}

test('legacy full-refund summaries recognize a confirmed payment even without paidAt', () => {
  const f = fixture()
  const summary = f.c.buildOrderProfitSummary({ payAmount: 100, status: 'cancelled', paymentStatus: 'refunded', refundAmount: 100 })
  assert.equal(summary.hasPayment, true)
  assert.equal(summary.refundAmount, 100)
  assert.equal(summary.netPayAmount, 0)
  assert.equal(summary.settlementStatus, 'refunded')
})
