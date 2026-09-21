const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createService = require('../../cloudfunctions/api/services/financeAggregation')

function report(initial, range = {}) {
  const db = createCollectionStore(initial)
  // The dashboard must use database aggregation, never collection.get().
  const collection = db.collection
  db.collection = name => ({ aggregate: () => collection(name).aggregate() })
  return createService({ db, safeText: value => value == null ? '' : String(value) }).aggregateFinanceDashboard(range)
}

test('finance aggregates more than 100 rows and returns only ten recent logs', async () => {
  const rows = Array.from({ length: 251 }, (_, i) => ({ _id: String(i).padStart(3, '0'),
    status: 'paid', amount: 0.1, payAmount: 0.1, createdAt: new Date('2026-09-01T00:00:00Z') }))
  const result = await report({ orders: rows, payments: rows, finance_logs: rows })
  assert.equal(result.metrics.gmv, 25.1)
  assert.equal(result.metrics.received, 25.1)
  assert.equal(result.counts.payments, 251)
  assert.equal(result.counts.logs, 251)
  assert.equal(result.recentLogs.length, 10)
  assert.equal(result.recentLogs[0]._id, '250')
  assert.ok(!('reportDate' in result.recentLogs[0]))
})

test('finance uses successful payments and actual successful refunds, excluding deposits', async () => {
  const result = await report({
    payments: [{ status: 'success', amount: 100 }, { status: 'paid', amount: 50 },
      { status: 'pending', amount: 500 }, { status: 'failed', amount: 600 },
      { status: 'success', targetType: 'staff_deposit', amount: 1000 }],
    refunds: [{ status: 'success', amount: 100, refundAmount: 20 },
      { status: 'processing', amount: 100, refundAmount: 80 }, { status: 'failed', refundAmount: 40 }],
    staff_earnings: [{ status: 'available', amount: 70 }],
    withdraw_requests: [{ status: 'pending', amount: 10 }, { status: 'approved', amount: 20 },
      { status: 'paid', amount: 30 }, { status: 'rejected', amount: 40 }]
  })
  assert.equal(result.metrics.received, 150)
  assert.equal(result.metrics.refundAmount, 20)
  assert.equal(result.metrics.netRevenue, 130)
  assert.equal(result.metrics.platformGrossProfit, 60)
  assert.equal(result.metrics.pendingWithdrawAmount, 10)
  assert.equal(result.metrics.withdrawingAmount, 20)
  assert.equal(result.metrics.paidWithdrawAmount, 30)
  assert.equal(result.counts.payments, 2)
  assert.deepEqual(result.counts.refundStatus, { success: 1, processing: 1, failed: 1 })
})

test('missing payment records never become GMV cash receipts; empty collections return zeros', async () => {
  const result = await report({ orders: [{ status: 'day_completed', payAmount: 100 }] })
  assert.equal(result.metrics.gmv, 100)
  assert.equal(result.metrics.received, 0)
  const empty = await report({})
  assert.ok(Object.values(empty.metrics).every(value => value === 0))
  assert.deepEqual(empty.recentLogs, [])
})

test('date range uses Beijing midnight, inclusive milliseconds and parseable fallback fields', async () => {
  const dates = [new Date('2026-08-31T16:00:00Z'), '2026-09-01 00:00:00',
    '2026-09-01T23:59:59.999+08:00', '2026-09-01T15:59:59.999Z',
    '2026-08-31T15:59:59.999Z', '2026-09-02 00:00:00', 'invalid', null]
  const payments = dates.map(paidAt => ({ status: 'success', amount: 1, paidAt }))
  payments.push({ status: 'success', amount: 1, paidAt: 'bad', updatedAt: '2026-09-01 12:00' })
  const result = await report({ payments }, { startDate: '2026-09-01', endDate: '2026-09-01' })
  assert.equal(result.metrics.received, 5)
  const endOnly = await report({ payments }, { endDate: '2026-09-01' })
  assert.equal(endOnly.metrics.received, 6)
})

test('invalid dates and invalid successful amounts fail explicitly', async () => {
  for (const range of [{ startDate: '2026-02-30' }, { endDate: 'bad' },
    { startDate: '2026-09-02', endDate: '2026-09-01' }]) {
    await assert.rejects(report({}, range), /日期/)
  }
  for (const amount of [undefined, '100', NaN, Infinity, -1]) {
    await assert.rejects(report({ payments: [{ status: 'success', amount }] }), /金额异常/)
  }
  await assert.rejects(report({ refunds: [{ status: 'success', amount: 100 }] }), /金额异常/)
})

test('status group output is not truncated at 100 statuses', async () => {
  const refunds = Array.from({ length: 151 }, (_, i) => ({ status: `legacy_${i}` }))
  const result = await report({ refunds })
  assert.equal(result.counts.refunds, 151)
  assert.equal(Object.keys(result.counts.refundStatus).length, 151)
})

test('finance dashboard still requires administrator permission', async () => {
  const db = createCollectionStore({ users: [{ openid: 'client', roles: ['client'], status: 'active' }] })
  const result = await loadCloudFunction('api', db, 'client').main({ module: 'admin', action: 'financeDashboard', data: {} })
  assert.equal(result.ok, false)
})
