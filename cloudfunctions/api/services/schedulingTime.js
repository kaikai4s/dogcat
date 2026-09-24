module.exports = function createService({
  
}) {
  function parseDateTimeParts(dateStr) {
    if (!dateStr) return null
    const text = String(dateStr).trim()
    const match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{1,2})/)
    if (match) {
      const year = Number(match[1])
      const month = Number(match[2]) - 1
      const day = Number(match[3])
      const hour = Number(match[4])
      const minute = Number(match[5])

      // 修复：使用 UTC 正午时间来计算星期几，避免时区问题
      // 正午12:00不会因为时区调整而跨天
      const dateForDayOfWeek = new Date(Date.UTC(year, month, day, 12, 0))
      const jsDay = dateForDayOfWeek.getUTCDay()
      const dayOfWeek = jsDay === 0 ? 7 : jsDay

      // 将北京时间转为UTC时间（减去8小时）用于存储
      const dateObj = new Date(Date.UTC(year, month, day, hour - 8, minute))

      // 返回北京时间的 dayOfWeek, hour, minute，用于时间段判断
      return { dayOfWeek, hour, minute, day, dateObj }
    }
    const d = new Date(text)
    if (Number.isNaN(d.getTime())) return null
    // 修复：从UTC时间转换为北京时间
    const beijingTime = new Date(d.getTime() + 8 * 60 * 60 * 1000)
    const year = beijingTime.getUTCFullYear()
    const month = beijingTime.getUTCMonth()
    const day = beijingTime.getUTCDate()
    const hour = beijingTime.getUTCHours()
    const minute = beijingTime.getUTCMinutes()

    // 使用 UTC 正午时间计算星期几
    const dateForDayOfWeek = new Date(Date.UTC(year, month, day, 12, 0))
    const jsDay = dateForDayOfWeek.getUTCDay()
    const dayOfWeek = jsDay === 0 ? 7 : jsDay

    // 构造UTC时间用于存储
    const dateObj = new Date(Date.UTC(year, month, day, hour - 8, minute))
    return { dayOfWeek, hour, minute, day, dateObj }
  }

  function formatDateKey(dateObj) {
    return `${dateObj.getUTCFullYear()}-${String(dateObj.getUTCMonth() + 1).padStart(2, '0')}-${String(dateObj.getUTCDate()).padStart(2, '0')}`
  }

  function getDateKeyFromTime(value) {
    const parts = parseDateTimeParts(value)
    return parts ? formatDateKey(new Date(parts.dateObj.getTime() + 8 * 60 * 60 * 1000)) : ''
  }

  return {
    parseDateTimeParts,
    formatDateKey,
    getDateKeyFromTime
  }
}
