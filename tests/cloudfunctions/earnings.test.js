const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const optimistic = require('./optimisticTransactions')
const createService = require('../../cloudfunctions/api/services/earnings')

const order = { _id: 'order', staffOpenid: 'staff', payAmount: 100 }
const time = new Date('2026-09-22T12:00:00Z')
function setup(initial = {}) {
  const db = createCollectionStore({ staff_earnings: [], finance_logs: [], ...initial })
  const retries = optimistic(db)
  const service = createService({
    db, now: () => time, parseDateValue: value => new Date(value),
    getSystemSettings: async () => ({ settlement: { staffCommissionRate: 0.7, settlementDelayDays: 0 } })
  })
  return { db, retries, ...service }
}

test('overlapping completions use document-only transactions and create one earning and ledger entry', async () => {
  const { db, retries, ensureStaffEarning } = setup()
  const results = await Promise.all(Array.from({ length: 4 }, () => ensureStaffEarning(order)))
  assert.ok(retries() > 0, 'must exercise transaction conflicts')
  assert.equal(new Set(results.map(row => row._id)).size, 1)
  assert.equal(db.state.staff_earnings.length, 1)
  assert.equal(db.state.finance_logs.length, 1)
  assert.equal(db.state.staff_earnings[0].amount, 70)
  assert.equal(db.state.finance_logs[0].amountDelta, 70)
  assert.equal(db.state.finance_logs[0].targetId, results[0]._id)
  await ensureStaffEarning(order, time, { overrideAmount: 200 })
  assert.equal(db.state.staff_earnings[0].amount, 70)
  assert.equal(db.state.finance_logs.length, 1)
})

test('historical random-ID earnings retain their frozen or withdrawn state and amount', async () => {
  for (const status of ['frozen', 'withdrawn']) {
    const historical = { _id: 'legacy', orderId: order._id, staffOpenid: 'staff', status, amount: 12 }
    const { db, ensureStaffEarning } = setup({ staff_earnings: [historical] })
    const results = await Promise.all([ensureStaffEarning(order), ensureStaffEarning(order)])
    assert.deepEqual(results, [historical, historical])
    assert.deepEqual(db.state.staff_earnings, [historical])
    assert.equal(db.state.finance_logs.length, 0)
  }
})

for (const failingCollection of ['staff_earnings', 'finance_logs']) {
  test(`earning creation rolls back on ${failingCollection} failure and can be retried`, async () => {
    const { db, ensureStaffEarning } = setup()
    const run = db.runTransaction
    db.runTransaction = callback => run(transaction => callback({ collection(name) {
      return { doc(id) {
        const document = transaction.collection(name).doc(id)
        if (name === failingCollection) document.set = async () => { throw new Error('injected write failure') }
        return document
      } }
    } }))
    await assert.rejects(ensureStaffEarning(order), /injected write failure/)
    assert.equal(db.state.staff_earnings.length, 0)
    assert.equal(db.state.finance_logs.length, 0)
    db.runTransaction = run
    await ensureStaffEarning(order)
    assert.equal(db.state.staff_earnings.length, 1)
    assert.equal(db.state.finance_logs.length, 1)
  })
}

test('earning lookup failures propagate without creating a replacement record', async () => {
  const { db, ensureStaffEarning } = setup()
  db.runTransaction = callback => callback({ collection() {
    return { doc() { return { get: async () => { throw new Error('collection does not exist') } } } }
  } })
  await assert.rejects(ensureStaffEarning(order), /collection does not exist/)
  assert.equal(db.state.staff_earnings.length, 0)
})

test('urgent rewards and deductions are reflected in the same committed finance log', async () => {
  const { db, ensureStaffEarning } = setup()
  const result = await ensureStaffEarning({ ...order, isUrgent: true, urgentStaffReward: 150 }, time, { deductAmount: 20, deductReason: 'late' })
  assert.equal(result.amount, 130)
  assert.equal(result.originalAmount, 150)
  assert.equal(db.state.finance_logs[0].amountDelta, 130)
  assert.equal(db.state.finance_logs[0].detail.deductAmount, 20)
})

test('earning refresh traverses 205 changing rows without releasing frozen, withdrawing or other staff earnings', async () => {
  const rows = Array.from({ length: 205 }, (_, i) => ({
    _id: `e${String(i).padStart(3, '0')}`, staffOpenid: 'staff', status: 'pending', availableAt: '2026-09-01'
  }))
  const { db, refreshStaffEarnings } = setup({ staff_earnings: [
    ...rows,
    { _id: 'frozen', staffOpenid: 'staff', status: 'frozen', availableAt: '2026-09-01' },
    { _id: 'other', staffOpenid: 'other', status: 'pending', availableAt: '2026-09-01' },
    { _id: 'future', staffOpenid: 'staff', status: 'pending', availableAt: '2027-01-01' }
  ] })
  // A withdrawal wins after the page has been read, before the pending update.
  const collection = db.collection
  db.collection = name => {
    const query = collection(name)
    const update = query.update.bind(query)
    query.update = async args => {
      if (query._where?._id === 'e050') db.state.staff_earnings.find(row => row._id === 'e050').status = 'withdrawing'
      return update(args)
    }
    return query
  }
  await refreshStaffEarnings('staff')
  assert.equal(db.state.staff_earnings.filter(row => row.status === 'available').length, 204)
  for (const [id, status] of [['e050', 'withdrawing'], ['frozen', 'frozen'], ['other', 'pending'], ['future', 'pending']]) {
    assert.equal(db.state.staff_earnings.find(row => row._id === id).status, status)
  }
})
