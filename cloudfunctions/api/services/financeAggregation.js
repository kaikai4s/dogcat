module.exports = function createService({ db, safeText }) {
  function buildFinanceRange(data = {}) {
    function boundary(value) {
      const text = safeText(value).trim()
      if (!text) return null
      const date = new Date(`${text}T00:00:00+08:00`)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(date.getTime()) ||
          new Date(date.getTime() + 28800000).toISOString().slice(0, 10) !== text) {
        throw new Error('统计日期格式不正确')
      }
      return date
    }
    const start = boundary(data.startDate)
    const end = boundary(data.endDate)
    if (start && end && start > end) throw new Error('开始日期不能晚于结束日期')
    return { start, end: end && new Date(end.getTime() + 86400000),
      startDate: safeText(data.startDate).trim(), endDate: safeText(data.endDate).trim() }
  }

  async function aggregateFinanceDashboard(data = {}) {
    const range = buildFinanceRange(data)
    const $ = db.command.aggregate
    const eq = (field, value) => $.eq([`$${field}`, value])
    const isIn = (field, values) => $.in([`$${field}`, values])
    // $type is a native aggregation expression not wrapped by SDK 4.0.2.
    function dateValue(field) {
      const value = `$${field}`
      const type = { $type: value }
      const zoned = $.or(['Z', 'z', '+', '-'].map(token => $.gte([$.indexOfBytes([value, token, 10]), 0])))
      return $.cond([$.eq([type, 'date']), value,
        $.cond([$.eq([type, 'string']), $.cond([zoned,
          $.dateFromString({ dateString: value, onError: null, onNull: null }),
          $.dateFromString({ dateString: value, timezone: '+08:00', onError: null, onNull: null })]), null])])
    }
    function dated(collection, fields) {
      let pipeline = db.collection(collection).aggregate()
      if (range.start || range.end || collection === 'finance_logs') {
        const date = fields.reduceRight((fallback, field) => $.ifNull([dateValue(field), fallback]), null)
        pipeline = pipeline.addFields({ reportDate: date })
        const conditions = [$.neq(['$reportDate', null])]
        if (range.start) conditions.push($.gte(['$reportDate', range.start]))
        if (range.end) conditions.push($.lt(['$reportDate', range.end]))
        if (range.start || range.end) pipeline = pipeline.match(db.command.expr($.and(conditions)))
      }
      return pipeline
    }
    async function summarize(collection, fields, amountField, filter, amountFilter) {
      let pipeline = dated(collection, fields)
      if (filter) pipeline = pipeline.match(db.command.expr(filter))
      const amount = `$${amountField}`
      const valid = $.and([$.in([{ $type: amount }, ['int', 'long', 'double', 'decimal']]),
        $.gte([amount, 0]), $.lt([amount, 90071992547409])])
      const included = amountFilter || $.literal(true)
      const cents = $.floor($.add([$.multiply([amount, 100]), 0.5]))
      const result = await pipeline.group({
        _id: $.ifNull(['$status', 'unknown']), count: $.sum(1),
        cents: $.sum($.cond([included, $.cond([valid, cents, 0]), 0])),
        invalid: $.sum($.cond([included, $.cond([valid, 0, 1]), 0]))
      }).group({ _id: null, count: $.sum('$count'), cents: $.sum('$cents'), invalid: $.sum('$invalid'),
        statuses: $.push({ status: '$_id', count: '$count', cents: '$cents' }) }).end()
      const summary = result.list[0] || { count: 0, cents: 0, invalid: 0, statuses: [] }
      if (summary.invalid || !Number.isSafeInteger(summary.cents)) throw new Error(`财务数据金额异常，请核对 ${collection}`)
      return summary
    }
    const paidOrder = $.or([eq('paymentStatus', 'paid'), isIn('status', ['paid', 'assigned', 'in_service', 'day_completed', 'completed'])])
    const paidPayment = $.and([isIn('status', ['success', 'paid']), $.neq([$.ifNull(['$targetType', '']), 'staff_deposit'])])
    const [orders, payments, refunds, earnings, withdraws, logResult, recent] = await Promise.all([
      summarize('orders', ['paidAt', 'createdAt'], 'payAmount', paidOrder),
      summarize('payments', ['paidAt', 'updatedAt', 'createdAt'], 'amount', paidPayment),
      summarize('refunds', ['createdAt', 'updatedAt'], 'refundAmount', null, eq('status', 'success')),
      summarize('staff_earnings', ['createdAt', 'completedAt'], 'amount'),
      summarize('withdraw_requests', ['createdAt', 'paidAt'], 'amount'),
      dated('finance_logs', ['createdAt']).group({ _id: null, count: $.sum(1) }).end(),
      dated('finance_logs', ['createdAt']).sort({ reportDate: -1, _id: -1 }).limit(10).end()
    ])
    const statuses = summary => Object.fromEntries(summary.statuses.map(item => [item.status, item.count]))
    const withdrawAmount = status => (withdraws.statuses.find(item => item.status === status)?.cents || 0) / 100
    return {
      range: { startDate: range.startDate, endDate: range.endDate },
      metrics: {
        gmv: orders.cents / 100, received: payments.cents / 100, refundAmount: refunds.cents / 100,
        netRevenue: (payments.cents - refunds.cents) / 100, staffEarningAmount: earnings.cents / 100,
        platformGrossProfit: (payments.cents - refunds.cents - earnings.cents) / 100,
        pendingWithdrawAmount: withdrawAmount('pending'), withdrawingAmount: withdrawAmount('approved'),
        paidWithdrawAmount: withdrawAmount('paid')
      },
      counts: { paidOrders: orders.count, payments: payments.count, refunds: refunds.count,
        earnings: earnings.count, withdraws: withdraws.count, logs: logResult.list[0]?.count || 0,
        withdrawStatus: statuses(withdraws), earningStatus: statuses(earnings), refundStatus: statuses(refunds) },
      recentLogs: recent.list.map(({ reportDate, ...log }) => log)
    }
  }
  return { aggregateFinanceDashboard }
}
