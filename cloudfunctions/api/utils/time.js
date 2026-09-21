function now() { return new Date() }

function nowText() { return new Date().toISOString() }

function beijingClockText(value = now()) {
  const source = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(source.getTime())) return ''
  const cst = new Date(source.getTime() + 8 * 60 * 60 * 1000)
  const hour = String(cst.getUTCHours()).padStart(2, '0')
  const minute = String(cst.getUTCMinutes()).padStart(2, '0')
  return `${hour}:${minute}`
}

function cstTodayStart() {
  const cstOffset = 8 * 60 * 60 * 1000
  const cstMs = Date.now() + cstOffset
  return new Date(Math.floor(cstMs / 86400000) * 86400000 - cstOffset)
}

function toCstParts(date = now()) {
  const source = date instanceof Date ? date : new Date(date)
  const cst = new Date(source.getTime() + 8 * 60 * 60 * 1000)
  const year = cst.getUTCFullYear()
  const month = String(cst.getUTCMonth() + 1).padStart(2, '0')
  const day = String(cst.getUTCDate()).padStart(2, '0')
  return {
    year,
    month,
    day,
    monthKey: `${year}-${month}`,
    dateKey: `${year}-${month}-${day}`,
    dayNumber: Number(day)
  }
}

function parseDateValue(value) {
  if (!value) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  const text = String(value)
  const direct = new Date(text)
  if (!Number.isNaN(direct.getTime())) return direct
  const normalized = new Date(text.replace(/-/g, '/'))
  return Number.isNaN(normalized.getTime()) ? null : normalized
}

function toTimeValue(value) {
  if (!value) return 0
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const text = String(value).trim()
  if (/^\d{10,13}$/.test(text)) {
    const num = Number(text)
    return Number.isFinite(num) ? (text.length === 10 ? num * 1000 : num) : 0
  }
  const localMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/)
  if (localMatch) {
    const [, year, month, day, hour = '0', minute = '0', second = '0'] = localMatch
    return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 8, Number(minute), Number(second))
  }
  let parsed = new Date(text).getTime()
  if (Number.isNaN(parsed)) {
    parsed = new Date(text.replace(/-/g, '/').replace('T', ' ')).getTime()
  }
  return Number.isNaN(parsed) ? 0 : parsed
}

module.exports = { now, nowText, beijingClockText, cstTodayStart, toCstParts, parseDateValue, toTimeValue }
