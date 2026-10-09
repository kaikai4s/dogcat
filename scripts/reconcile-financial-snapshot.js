// Local exports only. This tool never connects to a database or payment gateway.
const fs = require('node:fs')
const { audit } = require('./audit-financial-snapshot')
const COST_FIELDS = ['mallCostFen', 'paymentFeeFen', 'taxFen', 'marketingFen', 'reimbursementFen', 'operatingCostFen']
const COLLECTIONS = ['orders', 'mall_orders', 'payments', 'refunds', 'staff_earnings', 'withdraw_requests', 'staff_deposits', 'order_incidents']

function timestamp(value) {
  if (value == null || value === '') return NaN
  if (typeof value === 'number' || value instanceof Date) return new Date(value).getTime()
  if (typeof value !== 'string') return NaN
  const text = value.trim().replace(' ', 'T')
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text}+08:00`)
}
function beijingDay(time) { return new Date(time + 28800000).toISOString().slice(0, 10) }
function yuanToFen(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return NaN
  const fen = Math.round(value * 100)
  return Number.isSafeInteger(fen) && Math.abs(value * 100 - fen) < 1e-7 ? fen : NaN
}
function validFen(value) { return Number.isSafeInteger(value) && value >= 0 }

function reconcile(snapshot, statement, costs = {}) {
  const base = audit(snapshot)
  if (!statement || typeof statement !== 'object' || !statement.period) throw new Error('账单必须包含 period、payments、refunds、withdrawals')
  const { startDate, endDate } = statement.period
  const boundary = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('账单日期格式不正确')
    const time = timestamp(`${value}T00:00:00`)
    if (!Number.isFinite(time) || beijingDay(time) !== value) throw new Error('账单日期不存在')
    return time
  }
  const start = boundary(startDate), end = boundary(endDate) + 86400000
  if (start >= end) throw new Error('账单开始日期不能晚于结束日期')
  const missing = COLLECTIONS.filter(name => !Array.isArray(snapshot[name]))
  const findings = [...base.findings]
  const add = (code, collection, id) => findings.push({ code, collection, id: String(id || '') })
  const rows = name => snapshot[name] || []
  const days = new Map()
  const day = time => {
    const date = beijingDay(time)
    if (!days.has(date)) days.set(date, { date, serviceGmvFen: 0, receivedFen: 0, refundFen: 0,
      staffEarningFen: 0, paidWithdrawFen: 0, depositsReceivedFen: 0 })
    return days.get(date)
  }
  const timeOf = (row, fields) => fields.map(key => timestamp(row[key])).find(Number.isFinite)
  const inPeriod = time => Number.isFinite(time) && time >= start && time < end
  for (let time = start; time < end; time += 86400000) day(time)
  const total = (collection, predicate, dates, amountField, metric, classify) => {
    for (const row of rows(collection).filter(predicate)) {
      const time = timeOf(row, dates)
      if (!Number.isFinite(time)) { add('MISSING_ACCOUNTING_DATE', collection, row._id); continue }
      if (!inPeriod(time)) continue
      const amount = yuanToFen(row[amountField])
      if (!validFen(amount)) { add('INVALID_AMOUNT', collection, row._id); continue }
      const target = day(time), key = classify ? classify(row) : metric
      target[key] += amount
      if (!Number.isSafeInteger(target[key])) throw new Error('汇总金额超出安全范围')
    }
  }
  const paid = row => ['success', 'paid'].includes(row.status)
  total('orders', row => row.paymentStatus === 'paid' || ['paid', 'assigned', 'in_service', 'day_completed', 'completed'].includes(row.status), ['paidAt', 'createdAt'], 'payAmount', 'serviceGmvFen')
  total('payments', paid, ['paidAt', 'updatedAt', 'createdAt'], 'amount', 'receivedFen', row => row.targetType === 'staff_deposit' ? 'depositsReceivedFen' : 'receivedFen')
  total('refunds', row => row.status === 'success', ['succeededAt', 'updatedAt', 'createdAt'], 'refundAmount', 'refundFen')
  total('staff_earnings', () => true, ['createdAt', 'completedAt'], 'amount', 'staffEarningFen')
  total('withdraw_requests', row => row.status === 'paid', ['paidAt', 'createdAt'], 'amount', 'paidWithdrawFen')

  function compare(collection, gatewayName, key, amountField, predicate, dates, reference) {
    if (!Array.isArray(statement[gatewayName])) { missing.push(`statement.${gatewayName}`); return }
    const local = new Map(), gateway = new Map()
    const addRow = (map, row, source) => {
      const id = row[key]
      if (!id) { add('MISSING_BUSINESS_NUMBER', source, row._id); return }
      if (map.has(id)) add('DUPLICATE_BUSINESS_NUMBER', source, id)
      else map.set(id, row)
    }
    for (const row of rows(collection).filter(predicate)) {
      const time = timeOf(row, dates)
      if (inPeriod(time)) addRow(local, row, collection)
    }
    for (const row of statement[gatewayName]) {
      if (!row || typeof row !== 'object') throw new Error(`账单 ${gatewayName} 记录格式错误`)
      if (!validFen(row.amountFen)) add('INVALID_GATEWAY_AMOUNT', `statement.${gatewayName}`, row[key])
      if (!inPeriod(timeOf(row, dates))) { add('INVALID_GATEWAY_DATE', `statement.${gatewayName}`, row[key]); continue }
      addRow(gateway, row, `statement.${gatewayName}`)
    }
    for (const [id, row] of local) {
      const other = gateway.get(id)
      if (!other) { add('MISSING_GATEWAY_RECORD', collection, id); continue }
      if (yuanToFen(row[amountField]) !== other.amountFen) add('GATEWAY_AMOUNT_MISMATCH', collection, id)
      if (reference && (!row[reference] || !other[reference] || row[reference] !== other[reference])) add('PAYMENT_REFERENCE_MISMATCH', collection, id)
      if (beijingDay(timeOf(row, dates)) !== beijingDay(timeOf(other, dates))) add('ACCOUNTING_DAY_MISMATCH', collection, id)
    }
    for (const id of gateway.keys()) if (!local.has(id)) add('MISSING_LOCAL_RECORD', collection, id)
  }
  compare('payments', 'payments', 'paymentNo', 'amount', paid, ['paidAt', 'updatedAt', 'createdAt'], 'wxTransactionId')
  compare('refunds', 'refunds', 'refundNo', 'refundAmount', row => row.status === 'success', ['succeededAt', 'updatedAt', 'createdAt'], 'wxRefundId')
  // Withdrawal exports use the internal request ID as the stable matching key.
  compare('withdraw_requests', 'withdrawals', '_id', 'amount', row => row.status === 'paid', ['paidAt', 'createdAt'], 'paymentReference')
  for (const payment of rows('payments').filter(row => paid(row) && row.targetType !== 'staff_deposit')) {
    const collection = payment.targetType === 'mall_order' ? 'mall_orders' : 'orders'
    if (!snapshot[collection]) continue
    const order = rows(collection).find(row => row._id === payment.orderId)
    if (!order) add('PAYMENT_ORDER_MISSING', 'payments', payment._id)
    else if (yuanToFen(payment.amount) !== yuanToFen(order.payAmount) || order.paymentNo !== payment.paymentNo) add('ORDER_PAYMENT_MISMATCH', 'payments', payment._id)
  }
  const costDays = new Map()
  if (costs.days != null && !Array.isArray(costs.days)) throw new Error('成本 days 必须是数组')
  for (const row of costs.days || []) {
    if (!row || typeof row !== 'object') throw new Error('成本记录格式错误')
    const time = boundary(row.date)
    if (!inPeriod(time) || costDays.has(row.date) || !COST_FIELDS.every(field => validFen(row[field]))) throw new Error('成本日期重复、超出范围或金额不完整')
    costDays.set(row.date, row)
    day(time)
  }
  const daily = [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map(row => {
    const cost = costDays.get(row.date)
    const costTotal = cost ? COST_FIELDS.reduce((sum, field) => sum + cost[field], 0) : null
    const remainingAfterStaffFen = row.receivedFen - row.refundFen - row.staffEarningFen
    const profitEstimateFen = costs.complete === true && cost ? remainingAfterStaffFen - costTotal : null
    for (const value of [remainingAfterStaffFen, costTotal, profitEstimateFen]) if (value !== null && !Number.isSafeInteger(value)) throw new Error('成本或利润汇总超出安全范围')
    return { ...row, remainingAfterStaffFen, costTotalFen: costTotal, profitEstimateFen }
  })
  if (statement.complete !== true) missing.push('statement.complete')
  return { readOnly: true, period: { startDate, endDate }, timezone: 'Asia/Shanghai',
    coverage: { complete: !missing.length, missing, costsComplete: costs.complete === true && daily.every(row => row.profitEstimateFen !== null) },
    reconciliationPassed: !missing.length && !findings.length, daily, findings,
    accountingScope: { depositsExcludedFromRevenue: true, withdrawalsAreCashOutflow: true,
      profitIsEstimate: true, historicalDateFallback: true, sourceSnapshotConsistencyVerified: false } }
}

if (require.main === module) {
  try {
    if (process.argv.length < 4 || process.argv.length > 5) throw new Error('用法：node scripts/reconcile-financial-snapshot.js <snapshot.json> <statement.json> [costs.json]')
    const read = path => JSON.parse(fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
    const report = reconcile(read(process.argv[2]), read(process.argv[3]), process.argv[4] ? read(process.argv[4]) : {})
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (!report.reconciliationPassed) process.exitCode = 2
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
module.exports = { reconcile }
