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
      return { where: (...args) => transaction.collection(name).where(...args), doc(id) {
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

test('an earning created after a refund logs only its actual credited balance', async () => {
  for (const [refundedAmount, expected] of [[40, 42], [100, 0]]) {
    const currentOrder = { ...order, refundedAmount }
    const { db, ensureStaffEarning } = setup({ orders: [currentOrder] })
    const earning = await ensureStaffEarning(currentOrder)
    assert.equal(earning.amount, expected)
    assert.equal(earning.deductedAmount, 70 - expected)
    assert.equal(db.state.finance_logs[0].amountDelta, expected)
    assert.equal(db.state.finance_logs[0].detail.refundDeductedAmount, 70 - expected)
    assert.equal(earning.status, expected ? 'available' : 'refunded_void')
    await ensureStaffEarning(currentOrder)
    assert.equal(db.state.finance_logs.length, 1)
  }
})

test('order revenue split rounds platform cents first and assigns staff the residual', async () => {
  const db = createCollectionStore({ staff_earnings: [], finance_logs: [], orders: [] })
  const service = createService({
    db,
    now: () => time,
    parseDateValue: value => new Date(value),
    getSystemSettings: async () => ({ settlement: { staffCommissionRate: 0.5, settlementDelayDays: 0 } })
  })
  const earning = await service.calculateStaffEarningForOrder({ payAmount: 0.01 })
  assert.equal(earning.earningAmount, 0)
  const summary = service.buildOrderProfitSummary({
    payAmount: 0.01,
    paymentStatus: 'paid',
    paidAt: time,
    status: 'completed'
  }, null, 0.5)
  assert.equal(summary.staffReward + summary.platformProfit, summary.netPayAmount)
  assert.equal(summary.staffReward, 0)
  assert.equal(summary.platformProfit, 0.01)

  const uneven = await service.calculateStaffEarningForOrder({ payAmount: 100.01 })
  assert.equal(uneven.earningAmount, 50)
  const unevenSummary = service.buildOrderProfitSummary({
    payAmount: 100.01,
    paymentStatus: 'paid',
    paidAt: time,
    status: 'completed'
  }, null, 0.7)
  assert.equal(unevenSummary.platformProfit, 30)
  assert.equal(unevenSummary.staffReward, 70.01)
  assert.equal(Math.round((unevenSummary.platformProfit + unevenSummary.staffReward) * 100), 10001)
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

test('mock payment orders create mock_settled non-withdrawable earnings without contaminating ledger balance', async () => {
  const { db, ensureStaffEarning, summarizeStaffEarnings } = setup()
  const mockOrder = { _id: 'mock_order_1', staffOpenid: 'staff', payAmount: 100, paymentChannel: 'mock', isMockPayment: true }
  const earning = await ensureStaffEarning(mockOrder)
  assert.equal(earning.isMock, true)
  assert.equal(earning.paymentChannel, 'mock')
  assert.equal(earning.isWithdrawable, false)
  assert.equal(earning.status, 'mock_settled')
  assert.equal(earning.amount, 70)

  // 检查财务流水
  const log = db.state.finance_logs.find(l => l.orderId === 'mock_order_1')
  assert.ok(log)
  assert.equal(log.action, 'staff_earning_mock_created')
  assert.equal(log.amountDelta, 0)
  assert.equal(log.detail.isMock, true)

  // 检查汇总：不能进入 available、pending 或 total
  const summary = summarizeStaffEarnings([
    earning,
    { _id: 'real_1', amount: 50, status: 'available', isMock: false, paymentChannel: 'wechat' }
  ])
  assert.equal(summary.available, 50)
  assert.equal(summary.total, 50)
  assert.equal(summary.mockTotal, 70)
})

test('a successful mock payment after failed attempts never creates withdrawable earnings', async () => {
  const legacy = { ...order, paymentStatus: 'paid' }
  const payments = [
    { _id: 'attempt_1', orderId: order._id, status: 'failed', channel: 'wechat' },
    { _id: 'attempt_2', orderId: order._id, status: 'failed', channel: 'mock' },
    { _id: 'attempt_3', orderId: order._id, status: 'success', channel: 'mock' }
  ]
  const { db, ensureStaffEarning } = setup({ orders: [legacy], payments })
  const earning = await ensureStaffEarning(legacy)
  assert.equal(earning.status, 'mock_settled')
  assert.equal(earning.isWithdrawable, false)
  assert.equal(db.state.finance_logs[0].amountDelta, 0)
})

test('refresh quarantines previously misclassified available and pending mock earnings and fixes creation logs', async () => {
  const payments = [
    { _id: 'attempt_1', orderId: order._id, status: 'failed', channel: 'wechat' },
    { _id: 'attempt_2', orderId: order._id, status: 'failed', channel: 'wechat' },
    { _id: 'attempt_3', orderId: order._id, status: 'paid', channel: 'mock' }
  ]
  const rows = ['available', 'pending'].map(status => ({ _id: status, orderId: order._id, staffOpenid: 'staff',
    status, amount: 70, isMock: false, paymentChannel: 'wechat', isWithdrawable: true, availableAt: '2026-09-01' }))
  const logs = rows.map(row => ({ _id: row._id, targetId: row._id, action: 'staff_earning_created', amountDelta: 70,
    detail: { paymentChannel: 'wechat', isMock: false } }))
  const { db, refreshStaffEarnings } = setup({ orders: [{ ...order, paymentStatus: 'paid' }], payments,
    staff_earnings: rows, finance_logs: logs })
  await refreshStaffEarnings('staff')
  assert.ok(db.state.staff_earnings.every(row => row.status === 'mock_settled' && row.isWithdrawable === false))
  assert.ok(db.state.finance_logs.every(log => log.amountDelta === 0 && log.detail.isMock === true))
})

test('an unavailable payment ledger cannot release or create withdrawable earnings', async () => {
  const { db, ensureStaffEarning, refreshStaffEarnings } = setup({
    orders: [{ ...order, paymentStatus: 'paid' }],
    staff_earnings: [{ _id: 'unverified', orderId: order._id, staffOpenid: 'staff',
      status: 'available', amount: 70, isMock: false, paymentChannel: 'wechat' }]
  })
  const collection = db.collection.bind(db)
  db.collection = name => {
    const query = collection(name)
    if (name === 'payments') query.get = async () => { throw new Error('payment ledger unavailable') }
    return query
  }
  const runTransaction = db.runTransaction.bind(db)
  db.runTransaction = callback => runTransaction(tx => callback({
    collection(name) {
      if (name === 'payments') return { where: () => ({ limit: () => ({
        get: async () => { throw new Error('payment ledger unavailable') }
      }) }) }
      return tx.collection(name)
    }
  }))
  await assert.rejects(ensureStaffEarning({ ...order, _id: 'new-order' }), /payment ledger unavailable/)
  await assert.rejects(refreshStaffEarnings('staff'), /收益支付渠道核对失败/)
  assert.equal(db.state.staff_earnings.length, 1)
  assert.equal(db.state.finance_logs.length, 0)
})
