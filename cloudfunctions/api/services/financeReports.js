module.exports = function createService({
  parseDateValue,
  safeText
}) {
  function buildDateRange(data = {}) {
    const startText = safeText(data.startDate).trim()
    const endText = safeText(data.endDate).trim()
    const start = startText ? parseDateValue(`${startText} 00:00:00`) : null
    const end = endText ? parseDateValue(`${endText} 23:59:59`) : null
    return { start, end, startDate: startText, endDate: endText }
  }

  function inDateRange(item, range, fields = ['createdAt']) {
    if (!range.start && !range.end) return true
    const date = fields.map((field) => parseDateValue(item[field])).find(Boolean)
    if (!date) return false
    if (range.start && date < range.start) return false
    if (range.end && date > range.end) return false
    return true
  }

  function sumAmount(list = [], field = 'amount') {
    return Math.round(list.reduce((sum, item) => sum + Number(item[field] || 0), 0) * 100) / 100
  }

  function statusCount(list = []) {
    return list.reduce((acc, item) => {
      const status = item.status || 'unknown'
      acc[status] = (acc[status] || 0) + 1
      return acc
    }, {})
  }

  function limitList(list = [], size = 50) {
    const pageSize = Math.min(Math.max(Number(size || 50), 1), 100)
    return list.slice(0, pageSize)
  }

  function paginateList(list = [], data = {}) {
    const page = Math.max(Number(data.page || 1), 1)
    const pageSize = Math.min(Math.max(Number(data.pageSize || 20), 1), 100)
    const total = list.length
    const start = (page - 1) * pageSize
    return {
      list: list.slice(start, start + pageSize),
      total,
      page,
      pageSize,
      hasMore: start + pageSize < total
    }
  }

  function messageTimeValue(thread = {}) {
    const source = thread.lastMessageAt || thread.updatedAt || thread.createdAt
    const time = source instanceof Date ? source.getTime() : new Date(source || 0).getTime()
    return Number.isFinite(time) ? time : 0
  }

  function sortMessageThreads(list = []) {
    return list.slice().sort((a, b) => {
      const unreadDiff = (Number(b.unreadCount || 0) > 0) - (Number(a.unreadCount || 0) > 0)
      if (unreadDiff !== 0) return unreadDiff
      return messageTimeValue(b) - messageTimeValue(a)
    })
  }

  return {
    buildDateRange,
    inDateRange,
    sumAmount,
    statusCount,
    limitList,
    paginateList,
    messageTimeValue,
    sortMessageThreads
  }
}
