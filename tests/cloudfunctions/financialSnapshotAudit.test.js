const test = require('node:test')
const assert = require('node:assert/strict')
const { audit } = require('../../scripts/audit-financial-snapshot')

test('financial snapshot audit finds historical anomalies without changing data or exposing customer details', () => {
  const snapshot = {
    orders: [{ _id: 'order', status: 'completed', staffOpenid: 'private-staff', payAmount: 100, refundAmount: 120 }],
    staff_earnings: [{ _id: 'a', orderId: 'other', status: 'frozen', frozenIncidentId: 'missing' }, { _id: 'b', orderId: 'other', status: 'withdrawing' }],
    order_incidents: [], withdraw_requests: [{ _id: 'withdrawal', status: 'paid', name: 'private-name' }],
    refunds: [{ _id: 'refund', orderId: 'order', status: 'success', refundAmount: 120 }],
    staff_deposits: [{ _id: 'deposit', paidAmount: 500, refundedAmount: 100, forfeitedAmount: 0, availableRefundAmount: 500 }]
  }
  const original = structuredClone(snapshot)
  const report = audit(snapshot)
  for (const code of ['REFUND_EXCEEDS_PAYMENT', 'DUPLICATE_ORDER_EARNING', 'ORPHAN_FROZEN_EARNING', 'ORPHAN_WITHDRAWING_EARNING', 'WITHDRAWAL_WITHOUT_PAYMENT_EVIDENCE', 'COMPLETED_ORDER_WITHOUT_EARNING', 'DEPOSIT_BALANCE_MISMATCH']) assert.ok(report.findings.some(row => row.code === code), code)
  assert.equal(JSON.stringify(report).includes('private-'), false)
  assert.deepEqual(snapshot, original)
})

test('financial audit validates input and does not treat unexported collections as empty', () => {
  assert.throws(() => audit({ orders: {} }), /记录数组/)
  const report = audit({ orders: [{ _id: 'o', status: 'completed', staffOpenid: 's', payAmount: 100, refundAmount: 100 }] })
  assert.equal(report.findings.length, 0)
  assert.deepEqual(Object.keys(report.collections), ['orders'])
})
