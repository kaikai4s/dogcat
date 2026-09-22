// Read-only audit of locally exported collections. Never connects to the database.
const fs = require('node:fs')

function audit(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('快照必须是以集合名为键、记录数组为值的 JSON 对象')
  for (const [name, rows] of Object.entries(snapshot)) {
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || !row._id)) throw new Error(`集合 ${name} 必须包含带 _id 的记录数组`)
  }
  const findings = []
  const rows = name => snapshot[name] || []
  const add = (code, collection, row) => findings.push({ code, collection, id: row._id })
  const cents = value => {
    const n = Number(value), rounded = Math.round(n * 100)
    return value != null && value !== '' && Number.isFinite(n) && Number.isSafeInteger(rounded) && n >= 0 && Math.abs(n * 100 - rounded) < 1e-7 ? rounded : NaN
  }
  const duplicate = (collection, field, code, predicate = () => true) => {
    const groups = new Map()
    for (const row of rows(collection).filter(predicate)) {
      if (!row[field]) continue
      const list = groups.get(row[field]) || []; list.push(row); groups.set(row[field], list)
    }
    for (const group of groups.values()) if (group.length > 1) for (const row of group) add(code, collection, row)
  }
  duplicate('staff_earnings', 'orderId', 'DUPLICATE_ORDER_EARNING')
  duplicate('payments', 'paymentNo', 'DUPLICATE_PAYMENT_NUMBER')
  duplicate('staff_deposits', 'staffOpenid', 'DUPLICATE_UNPAID_DEPOSIT', row => row.status === 'unpaid')
  for (const row of rows('staff_deposits')) {
    const [paid, refunded, forfeited, available] = ['paidAmount', 'refundedAmount', 'forfeitedAmount', 'availableRefundAmount'].map(key => cents(row[key]))
    if (![paid, refunded, forfeited, available].every(Number.isSafeInteger) || paid !== refunded + forfeited + available) add('DEPOSIT_BALANCE_MISMATCH', 'staff_deposits', row)
    if (row.status === 'refunded' && !row.refundPaymentReference && !row.wxRefundId) add('REFUND_WITHOUT_PAYMENT_EVIDENCE', 'staff_deposits', row)
  }
  for (const row of rows('staff_earnings')) {
    if (row.status === 'frozen' && (!row.frozenIncidentId || (snapshot.order_incidents && !rows('order_incidents').some(incident => incident._id === row.frozenIncidentId)))) add('ORPHAN_FROZEN_EARNING', 'staff_earnings', row)
    if (row.status === 'withdrawing' && (!row.withdrawRequestId || (snapshot.withdraw_requests && !rows('withdraw_requests').some(withdrawal => withdrawal._id === row.withdrawRequestId)))) add('ORPHAN_WITHDRAWING_EARNING', 'staff_earnings', row)
  }
  for (const row of rows('withdraw_requests')) if (row.status === 'paid' && !row.paymentReference && !row.wxTransferId) add('WITHDRAWAL_WITHOUT_PAYMENT_EVIDENCE', 'withdraw_requests', row)
  for (const collection of ['orders', 'mall_orders']) for (const order of rows(collection)) {
    if (snapshot.refunds) {
      const refunds = rows('refunds').filter(row => row.orderId === order._id && ['success', 'processing'].includes(row.status))
      const amounts = refunds.map(row => cents(row.refundAmount))
      if (amounts.some(amount => !Number.isSafeInteger(amount))) add('INVALID_REFUND_AMOUNT', collection, order)
      else {
        const reserved = amounts.reduce((sum, value) => sum + value, 0)
        if (reserved > cents(order.payAmount)) add('REFUND_EXCEEDS_PAYMENT', collection, order)
        const legacyApplication = collection === 'mall_orders' && ['applied', 'rejected'].includes(order.refundStatus) && order.paymentStatus === 'paid' && !order.refundNo && !refunds.length
        if (!legacyApplication && cents(order.refundAmount || 0) > reserved) add('REFUND_DETAIL_MISSING', collection, order)
      }
    }
    if (snapshot.staff_earnings && collection === 'orders' && order.status === 'completed' && order.staffOpenid && !rows('staff_earnings').some(row => row.orderId === order._id)) add('COMPLETED_ORDER_WITHOUT_EARNING', collection, order)
  }
  return { readOnly: true, collections: Object.fromEntries(Object.entries(snapshot).map(([name, records]) => [name, records.length])), findings }
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('用法：node scripts/audit-financial-snapshot.js <snapshot.json>')
    const report = audit(JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, '')))
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (report.findings.length) process.exitCode = 2
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
module.exports = { audit }
