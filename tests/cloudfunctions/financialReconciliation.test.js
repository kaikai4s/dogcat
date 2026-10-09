const test = require('node:test')
const assert = require('node:assert/strict')
const { reconcile } = require('../../scripts/reconcile-financial-snapshot')

function fixture() {
  const snapshot = { orders: [{ _id: 'o', paymentStatus: 'paid', payAmount: 100, paymentNo: 'p', paidAt: '2026-10-01 00:00' }],
    mall_orders: [], payments: [{ _id: 'p1', orderId: 'o', targetType: 'order', status: 'success', paymentNo: 'p', wxTransactionId: 'wxp', amount: 100, paidAt: '2026-09-30T16:00:00Z' }],
    refunds: [{ _id: 'r1', orderId: 'o', status: 'success', refundNo: 'r', wxRefundId: 'wxr', refundAmount: 20, createdAt: '2026-09-30 10:00', succeededAt: '2026-10-02 09:00' }],
    staff_earnings: [{ _id: 'e', orderId: 'o', amount: 50, completedAt: '2026-10-01 20:00', status: 'available' }],
    withdraw_requests: [{ _id: 'w', status: 'paid', amount: 50, paymentReference: 'proof', createdAt: '2026-09-30 10:00', paidAt: '2026-10-02 09:00' }],
    staff_deposits: [], order_incidents: [] }
  const statement = { complete: true, period: { startDate: '2026-10-01', endDate: '2026-10-02' },
    payments: [{ paymentNo: 'p', amountFen: 10000, wxTransactionId: 'wxp', paidAt: '2026-10-01T00:00:00+08:00' }],
    refunds: [{ refundNo: 'r', amountFen: 2000, wxRefundId: 'wxr', succeededAt: '2026-10-02 09:00' }],
    withdrawals: [{ _id: 'w', amountFen: 5000, paymentReference: 'proof', paidAt: '2026-10-02 09:00' }] }
  return { snapshot, statement }
}

test('local reconciliation matches references and Beijing success dates without counting withdrawals twice', () => {
  const { snapshot, statement } = fixture()
  const report = reconcile(snapshot, statement)
  assert.equal(report.reconciliationPassed, true)
  assert.equal(report.daily[0].receivedFen, 10000)
  assert.equal(report.daily[0].staffEarningFen, 5000)
  assert.equal(report.daily[0].remainingAfterStaffFen, 5000)
  assert.equal(report.daily[1].refundFen, 2000)
  assert.equal(report.daily[1].paidWithdrawFen, 5000)
  assert.equal(report.daily[1].remainingAfterStaffFen, -2000)
  assert.equal(report.daily[0].profitEstimateFen, null)
  assert.equal(report.coverage.costsComplete, false)
})

test('missing collections and incomplete gateway exports cannot pass reconciliation', () => {
  const { snapshot, statement } = fixture()
  delete snapshot.staff_deposits
  delete statement.withdrawals
  statement.complete = false
  const result = reconcile(snapshot, statement)
  assert.equal(result.reconciliationPassed, false)
  assert.deepEqual(result.coverage.missing, ['staff_deposits', 'statement.withdrawals', 'statement.complete'])
})

test('duplicate, missing and mismatched external records fail and report no personal data', () => {
  const { snapshot, statement } = fixture()
  snapshot.payments[0].openid = 'private-user'
  statement.payments[0].amountFen = 9999
  statement.payments[0].wxTransactionId = 'different'
  statement.payments.push({ ...statement.payments[0] })
  statement.refunds = []
  statement.withdrawals.push({ _id: 'external', amountFen: 50, paidAt: '2026-10-02 09:00', paymentReference: 'other' })
  const result = reconcile(snapshot, statement)
  assert.equal(result.reconciliationPassed, false)
  for (const code of ['DUPLICATE_BUSINESS_NUMBER', 'GATEWAY_AMOUNT_MISMATCH', 'PAYMENT_REFERENCE_MISMATCH', 'MISSING_GATEWAY_RECORD', 'MISSING_LOCAL_RECORD']) assert.ok(result.findings.some(item => item.code === code), code)
  assert.ok(!JSON.stringify(result).includes('private-user'))
})

test('deposits are reconciled separately; complete costs produce only an explicitly labeled estimate', () => {
  const { snapshot, statement } = fixture()
  snapshot.payments.push({ _id: 'dp', targetType: 'staff_deposit', paymentNo: 'dp', wxTransactionId: 'wxd', status: 'success', amount: 500, paidAt: '2026-10-01 12:00' })
  statement.payments.push({ paymentNo: 'dp', wxTransactionId: 'wxd', amountFen: 50000, paidAt: '2026-10-01 12:00' })
  const zero = { mallCostFen: 0, paymentFeeFen: 0, taxFen: 0, marketingFen: 0, reimbursementFen: 0, operatingCostFen: 0 }
  const result = reconcile(snapshot, statement, { complete: true, days: [{ ...zero, date: '2026-10-01', paymentFeeFen: 60 }, { ...zero, date: '2026-10-02' }] })
  assert.equal(result.daily[0].receivedFen, 10000)
  assert.equal(result.daily[0].depositsReceivedFen, 50000)
  assert.equal(result.daily[0].profitEstimateFen, 4940)
  assert.equal(result.coverage.costsComplete, true)
  assert.equal(result.accountingScope.profitIsEstimate, true)
  assert.throws(() => reconcile(snapshot, statement, { days: [{ date: '2026-10-01', paymentFeeFen: 1 }] }), /不完整/)
  statement.period.startDate = '2026-02-30'
  assert.throws(() => reconcile(snapshot, statement), /不存在/)
})

test('quiet days still require costs and earnings follow the dashboard creation date', () => {
  const { snapshot, statement } = fixture()
  statement.period.endDate = '2026-10-03'
  snapshot.staff_earnings[0].createdAt = '2026-10-02 10:00'
  const zero = { mallCostFen: 0, paymentFeeFen: 0, taxFen: 0, marketingFen: 0, reimbursementFen: 0, operatingCostFen: 0 }
  const result = reconcile(snapshot, statement, { complete: true, days: [
    { ...zero, date: '2026-10-01' }, { ...zero, date: '2026-10-02' }
  ] })
  assert.equal(result.daily.length, 3)
  assert.equal(result.daily[0].staffEarningFen, 0)
  assert.equal(result.daily[1].staffEarningFen, 5000)
  assert.equal(result.daily[2].profitEstimateFen, null)
  assert.equal(result.coverage.costsComplete, false)
})
