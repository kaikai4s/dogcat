const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')

const admin = { _id: 'admin', openid: 'admin' }
function setup(status = 'withdrawing', requestStatus = 'pending') {
  const db = createCollectionStore({
    users: [{ ...admin, roles: ['admin'], status: 'active' }, { _id: 'staff', openid: 'staff', roles: ['staff'], status: 'active' }],
    staff_earnings: [{ _id: 'e', orderId: 'order', staffOpenid: 'staff', amount: 80, status,
      withdrawRequestId: status === 'withdrawing' ? 'w' : '', frozenIncidentId: status === 'frozen' ? 'i' : '' }],
    withdraw_requests: [{ _id: 'w', staffOpenid: 'staff', amount: 80, status: requestStatus, earningIds: ['e'] }],
    order_incidents: [{ _id: 'i', orderId: 'order', staffOpenid: 'staff', status: 'processing', frozenEarningIds: status === 'frozen' ? ['e'] : [] }],
    finance_logs: [], admin_operation_logs: [], incident_actions: [], order_timeline: []
  })
  return { db, context: createContext({ db, cloud: {} }) }
}

const optimistic = require('./optimisticTransactions')

test('competing approve/reject decisions commit exactly once', async () => {
  const { db, context } = setup()
  const retries = optimistic(db)
  const results = await Promise.allSettled([
    context.settleWithdrawal(admin, { id: 'w', approved: true }),
    context.settleWithdrawal(admin, { id: 'w', approved: false })
  ])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.ok(retries() > 0)
  assert.equal(db.state.finance_logs.length, 1)
  assert.equal(db.state.admin_operation_logs.length, 1)
  assert.equal(db.state.staff_earnings[0].status, db.state.withdraw_requests[0].status === 'approved' ? 'withdrawing' : 'available')
})

test('concurrent payout confirmations are idempotent and cannot be frozen afterwards', async () => {
  const { db, context } = setup('withdrawing', 'approved')
  optimistic(db)
  const results = await Promise.all([
    context.settleWithdrawal(admin, { id: 'w' }, true), context.settleWithdrawal(admin, { id: 'w' }, true)
  ])
  assert.equal(results.filter(r => r.changed).length, 1)
  assert.equal(db.state.withdraw_requests[0].status, 'paid')
  assert.equal(db.state.staff_earnings[0].status, 'withdrawn')
  assert.equal(db.state.finance_logs.length, 1)
  await assert.rejects(context.freezeIncidentEarnings('i', 'admin'), /正在提现或已打款/)
})

test('withdrawal reservation and incident freeze cannot both reserve an earning', async () => {
  const { db, context } = setup('available')
  db.state.withdraw_requests = []
  const retries = optimistic(db)
  const run = db.runTransaction
  let started = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  db.runTransaction = async callback => {
    if (++started === 2) release()
    await gate
    return run(callback)
  }
  const results = await Promise.allSettled([
    context.createWithdrawRequest('staff', { amount: 80, clientRequestId: 'race' }),
    context.freezeIncidentEarnings('i', 'admin')
  ])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.ok(retries() > 0)
  const earning = db.state.staff_earnings[0]
  if (earning.status === 'frozen') {
    assert.equal(db.state.withdraw_requests.length, 0)
    assert.deepEqual(db.state.order_incidents[0].frozenEarningIds, ['e'])
  } else {
    assert.equal(earning.status, 'withdrawing')
    assert.deepEqual(db.state.order_incidents[0].frozenEarningIds, [])
  }
})

test('two incidents cannot overwrite each other and repeat freeze retains the association', async () => {
  const { db, context } = setup('available')
  db.state.order_incidents.push({ ...db.state.order_incidents[0], _id: 'other', frozenEarningIds: [] })
  const retries = optimistic(db)
  const results = await Promise.allSettled([context.freezeIncidentEarnings('i', 'admin'), context.freezeIncidentEarnings('other', 'admin')])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.ok(retries() > 0)
  const owner = db.state.staff_earnings[0].frozenIncidentId
  assert.deepEqual((await context.freezeIncidentEarnings(owner, 'admin')).frozenEarningIds, ['e'])
  assert.equal(db.state.finance_logs.length, 1)
})

test('release versus deduction cannot both commit; duplicate deduction never subtracts twice', async () => {
  const { db, context } = setup('frozen')
  const retries = optimistic(db)
  const deduct = { status: 'resolved', earningDecision: 'deduct', deductAmount: 30 }
  const results = await Promise.allSettled([
    context.closeIncidentFinancially('i', deduct, 'admin'),
    context.closeIncidentFinancially('i', { status: 'resolved', earningDecision: 'release' }, 'admin')
  ])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.ok(retries() > 0)
  assert.equal(db.state.staff_earnings[0].amount, 50)
  await context.closeIncidentFinancially('i', deduct, 'admin')
  assert.equal(db.state.staff_earnings[0].amount, 50)
  assert.equal(db.state.finance_logs.length, 1)
  assert.equal(db.state.order_incidents[0].earningResolution.deductedAmount, 30)
})

test('foreign, mismatched and stale earning associations block all withdrawal writes', async () => {
  for (const mutation of [{ staffOpenid: 'other' }, { withdrawRequestId: 'other' }, { amount: 1 }, { status: 'frozen' }, { frozenIncidentId: 'i' }]) {
    const { db, context } = setup()
    Object.assign(db.state.staff_earnings[0], mutation)
    const before = structuredClone(db.state)
    await assert.rejects(context.settleWithdrawal(admin, { id: 'w', approved: false }))
    assert.deepEqual(db.state, before)
  }
})

test('foreign incident association and invalid or excessive deductions never modify money', async () => {
  for (const mutation of [{ frozenIncidentId: 'other' }, { staffOpenid: 'other' }, { orderId: 'other' }, { withdrawRequestId: 'w' }]) {
    const { db, context } = setup('frozen')
    Object.assign(db.state.staff_earnings[0], mutation)
    await assert.rejects(context.closeIncidentFinancially('i', { status: 'closed', earningDecision: 'deduct', deductAmount: 10 }, 'admin'), /归属或状态/)
    assert.equal(db.state.staff_earnings[0].amount, 80)
  }
  for (const deductAmount of [-1, NaN, Infinity, 81, 0.001, '']) {
    const { db, context } = setup('frozen')
    await assert.rejects(context.closeIncidentFinancially('i', { status: 'closed', earningDecision: 'deduct', deductAmount }, 'admin'))
    assert.equal(db.state.staff_earnings[0].amount, 80)
  }
})

for (const failingCollection of ['staff_earnings', 'finance_logs', 'admin_operation_logs', 'incident_actions', 'order_timeline']) {
  test(`failure writing ${failingCollection} rolls back the complete financial operation`, async () => {
    const incident = ['incident_actions', 'order_timeline'].includes(failingCollection)
    const { db, context } = setup(incident ? 'frozen' : 'withdrawing')
    const original = db.runTransaction
    db.runTransaction = callback => original(tx => callback({ collection(name) {
      const collection = tx.collection(name)
      const doc = collection.doc
      collection.doc = id => {
        const record = doc(id)
        if (name === failingCollection) record.update = record.set = async () => { throw new Error('injected failure') }
        return record
      }
      return collection
    } }))
    const before = structuredClone(db.state)
    await assert.rejects(incident
      ? context.closeIncidentFinancially('i', { status: 'closed', earningDecision: 'deduct', deductAmount: 30 }, 'admin')
      : context.settleWithdrawal(admin, { id: 'w', approved: false }), /injected failure/)
    assert.deepEqual(db.state, before)
  })
}

test('keep-frozen can later be deducted; release respects the original settlement deadline', async () => {
  const { db, context } = setup('frozen')
  db.state.staff_earnings[0].availableAt = new Date('2099-01-01')
  await context.closeIncidentFinancially('i', { status: 'closed', earningDecision: 'keep_frozen' }, 'admin')
  await context.closeIncidentFinancially('i', { status: 'closed', earningDecision: 'deduct', deductAmount: 0.01 }, 'admin')
  assert.equal(db.state.staff_earnings[0].amount, 79.99)
  assert.equal(db.state.staff_earnings[0].status, 'pending')
})

test('financial write routes remain admin-only', async () => {
  const { db } = setup()
  const fn = loadCloudFunction('api', db, 'staff')
  for (const [module, action] of [['admin', 'auditWithdrawRequest'], ['admin', 'markWithdrawPaid'], ['incident', 'freezeStaffEarning'], ['incident', 'closeIncident']]) {
    const result = await fn.main({ module, action, data: { id: 'w', incidentId: 'i' } })
    assert.equal(result.ok, false)
  }
  assert.equal(db.state.finance_logs.length, 0)
})

test('approval or payout racing a freeze never changes withdrawal-reserved earnings to frozen', async () => {
  for (const paid of [false, true]) {
    const { db, context } = setup('withdrawing', paid ? 'approved' : 'pending')
    optimistic(db)
    const results = await Promise.allSettled([
      context.settleWithdrawal(admin, { id: 'w', approved: true }, paid),
      context.freezeIncidentEarnings('i', 'admin')
    ])
    assert.equal(results[0].status, 'fulfilled')
    assert.equal(results[1].status, 'rejected')
    assert.equal(db.state.staff_earnings[0].status, paid ? 'withdrawn' : 'withdrawing')
    assert.deepEqual(db.state.order_incidents[0].frozenEarningIds, [])
  }
})

test('rejection releases reservation so a later freeze and deduction are consistent', async () => {
  const { db, context } = setup()
  await context.settleWithdrawal(admin, { id: 'w', approved: false })
  await context.freezeIncidentEarnings('i', 'admin')
  await context.closeIncidentFinancially('i', { status: 'closed', earningDecision: 'deduct', deductAmount: 0 }, 'admin')
  assert.equal(db.state.staff_earnings[0].status, 'deducted')
  assert.equal(db.state.staff_earnings[0].amount, 0)
  assert.equal(db.state.withdraw_requests[0].status, 'rejected')
})

test('oversized freeze batches and duplicate withdrawal associations fail without partial changes', async () => {
  const { db, context } = setup('available')
  db.state.staff_earnings = Array.from({ length: 51 }, (_, i) => ({ ...db.state.staff_earnings[0], _id: `e${i}` }))
  await assert.rejects(context.freezeIncidentEarnings('i', 'admin'), /50笔/)
  assert.ok(db.state.staff_earnings.every(row => row.status === 'available'))
  db.state.withdraw_requests[0].earningIds = ['e0', 'e0']
  await assert.rejects(context.settleWithdrawal(admin, { id: 'w', approved: true }), /关联记录异常/)
})

test('failed incident finance log rolls back the deduction and closing status', async () => {
  const { db, context } = setup('frozen')
  const original = db.runTransaction
  db.runTransaction = callback => original(tx => callback({ collection(name) {
    if (name === 'finance_logs') return { doc() { return { async set() { throw new Error('log unavailable') } } } }
    return tx.collection(name)
  } }))
  const before = structuredClone(db.state)
  await assert.rejects(context.closeIncidentFinancially('i', { status: 'closed', earningDecision: 'deduct', deductAmount: 30 }, 'admin'), /log unavailable/)
  assert.deepEqual(db.state, before)
})
