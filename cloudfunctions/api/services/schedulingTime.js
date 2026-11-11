const { parseDateValue } = require('../utils/time')

module.exports = function createService() {
  function parseDateTimeParts(value) {
    const dateObj = parseDateValue(value)
    if (!dateObj) return null
    const beijing = new Date(dateObj.getTime() + 8 * 60 * 60 * 1000)
    const jsDay = beijing.getUTCDay()
    return {
      dayOfWeek: jsDay === 0 ? 7 : jsDay,
      hour: beijing.getUTCHours(), minute: beijing.getUTCMinutes(), day: beijing.getUTCDate(),
      second: beijing.getUTCSeconds(), millisecond: beijing.getUTCMilliseconds(), dateObj
    }
  }

  function formatDateKey(dateObj) {
    return `${dateObj.getUTCFullYear()}-${String(dateObj.getUTCMonth() + 1).padStart(2, '0')}-${String(dateObj.getUTCDate()).padStart(2, '0')}`
  }

  function getDateKeyFromTime(value) {
    const parts = parseDateTimeParts(value)
    return parts ? formatDateKey(new Date(parts.dateObj.getTime() + 8 * 60 * 60 * 1000)) : ''
  }

  return { parseDateTimeParts, formatDateKey, getDateKeyFromTime }
}
