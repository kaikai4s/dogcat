function now() { return new Date() }
function nowMs() { return Date.now() }

function nowText() { return new Date().toISOString() }

function beijingClockText(value = now()) {
  const source = parseDateValue(value)
  if (!source) return ''
  const cst = new Date(source.getTime() + 8 * 60 * 60 * 1000)
  const hour = String(cst.getUTCHours()).padStart(2, '0')
  const minute = String(cst.getUTCMinutes()).padStart(2, '0')
  return `${hour}:${minute}`
}

function clockHours(parts) {
  return parts.hour + parts.minute / 60 + (parts.second || 0) / 3600 + (parts.millisecond || 0) / 3600000
}

function cstTodayStart() {
  const cstOffset = 8 * 60 * 60 * 1000
  const cstMs = Date.now() + cstOffset
  return new Date(Math.floor(cstMs / 86400000) * 86400000 - cstOffset)
}

function toCstParts(date = now()) {
  const source = parseDateValue(date) || new Date(NaN)
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

function beijingDateText(value = now()) {
  const date = parseDateValue(value)
  return date ? toCstParts(date).dateKey : ''
}

function parseDateValue(value) {
  if (value === undefined || value === null || value === '') return null
  const timestamp = parseTimeValue(value)
  return Number.isFinite(timestamp) ? new Date(timestamp) : null
}

function parseTimeValue(value) {
  if (value === undefined || value === null || value === '') return NaN
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  const text = String(value).trim()
  if (/^\d{10,13}$/.test(text)) return Number(text) * (text.length === 10 ? 1000 : 1)
  const calendar = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/)
  if (calendar) {
    const [, y, m, d, h = '0', min = '0', sec = '0'] = calendar
    const day = new Date(Date.UTC(+y, +m - 1, +d))
    if (day.getUTCFullYear() !== +y || day.getUTCMonth() !== +m - 1 || day.getUTCDate() !== +d ||
        +h > 23 || +min > 59 || +sec > 59) return NaN
  }
  // Timezone-free business dates are Beijing wall time in every runtime.
  const local = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,3}))?)?)?$/)
  if (local) {
    const [, y, m, d, h = '0', min = '0', sec = '0', ms = '0'] = local
    return Date.UTC(+y, +m - 1, +d, +h - 8, +min, +sec, Number(ms.padEnd(3, '0')))
  }
  return new Date(text).getTime()
}

function toTimeValue(value) {
  const timestamp = parseTimeValue(value)
  return Number.isFinite(timestamp) ? timestamp : 0
}

module.exports = { now, nowMs, nowText, clockHours, beijingClockText, beijingDateText, cstTodayStart, toCstParts, parseDateValue, toTimeValue }
