const { beijingDateText, beijingClockText, toTimeValue } = require('./time')

// Allocate integer cents with a stable remainder order so discounts never lose a cent.
function cents(value) {
  const result = Math.round(Number(value) * 100)
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('订单场次金额异常，请核对')
  return result
}

function allocate(total, weights) {
  if (!weights.length) return []
  const sum = weights.reduce((a, b) => a + b, 0)
  if (!sum) return allocate(total, weights.map(() => 1))
  const divisor = BigInt(sum)
  const shares = weights.map((weight, index) => {
    const numerator = BigInt(total) * BigInt(weight)
    return { index, value: Number(numerator / divisor), remainder: numerator % divisor }
  })
  let remaining = total - shares.reduce((a, b) => a + b.value, 0)
  const ranked = [...shares].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1)
  for (const share of ranked) {
    if (!remaining) break
    share.value += 1
    remaining -= 1
  }
  return shares.map(share => share.value)
}

function sameSessionTime(left, right) {
  if (left === right) return true
  const timestamp = toTimeValue(left)
  return timestamp > 0 && timestamp === toTimeValue(right)
}

function getOrderSessionPricing(order, suppliedSessions) {
  const snapshot = order.priceSnapshot || {}
  const sessions = suppliedSessions || order.serviceSessions || order.sessions || snapshot.sessions || []
  if (!sessions.length) return []
  const paid = cents(order.payAmount ?? snapshot.payAmount ?? order.amount ?? 0)
  const original = cents(order.amount ?? snapshot.originalAmount ?? (paid / 100 + Number(order.discountAmount || 0)))
  const frozen = snapshot.sessionPricing
  let gross
  if (Array.isArray(frozen) && frozen.length === sessions.length && frozen.every((row, i) => sameSessionTime(row.startTime, sessions[i].startTime)) &&
      frozen.reduce((sum, row) => sum + cents(row.amount), 0) === original) {
    gross = frozen.map(row => cents(row.amount))
  } else {
    const items = Array.isArray(snapshot.surchargeItems) ? snapshot.surchargeItems : (snapshot.services || []).filter(item => ['date_surcharge', 'time_surcharge'].includes(item.type))
    const surcharge = sessions.map(() => 0)
    let surchargeTotal = 0
    for (const item of items) {
      const matched = sessions.map((session, i) => ({ session, i })).filter(({ session }) => {
        if (item.type === 'date_surcharge') return (item.dates || [item.dateRule?.date]).includes(beijingDateText(session.startTime) || session.date)
        const clock = beijingClockText(session.startTime)
        return item.timeRule && clock >= item.timeRule.startTime && clock <= item.timeRule.endTime
      })
      if (!matched.length) continue
      const amount = cents(item.price)
      surchargeTotal += amount
      allocate(amount, matched.map(() => 1)).forEach((value, i) => { surcharge[matched[i].i] += value })
    }
    if (surchargeTotal > original) throw new Error('订单场次加价金额异常，请核对')
    gross = allocate(original - surchargeTotal, sessions.map(() => 1)).map((value, i) => value + surcharge[i])
  }
  const net = allocate(paid, gross)
  return sessions.map((session, i) => ({ index: session.index || i + 1, date: session.date, startTime: session.startTime,
    amount: gross[i] / 100, payAmount: net[i] / 100, discountAmount: (gross[i] - net[i]) / 100 }))
}

function freezeOrderSessionPricing(pricing) {
  return { ...pricing, priceSnapshot: { ...pricing.priceSnapshot, sessionPricing: getOrderSessionPricing(pricing) } }
}

module.exports = { getOrderSessionPricing, freezeOrderSessionPricing }
