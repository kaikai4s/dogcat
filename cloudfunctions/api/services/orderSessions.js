module.exports = function createService({
  ORDER_STATUS,
  db,
  formatDateKey,
  now,
  parseDateTimeParts,
  safeText,
  toTimeValue
}) {
  function validateOrderTime(data) {
    const sessions = buildOrderSessions(data)
    sessions.forEach((session) => {
      const start = toTimeValue(session.startTime)
      const end = toTimeValue(session.endTime)
      if (!start || !end || end <= start) throw new Error('服务时间不正确')
      if (start < Date.now()) throw new Error('服务开始时间不能早于当前时间')
    })
  }

  function formatDateTimeParts(dateObj) {
    // 修复：dateObj 存储的是UTC时间（已减去8小时），需要加回8小时得到北京时间
    const beijingTime = new Date(dateObj.getTime() + 8 * 60 * 60 * 1000)
    return `${beijingTime.getUTCFullYear()}-${String(beijingTime.getUTCMonth() + 1).padStart(2, '0')}-${String(beijingTime.getUTCDate()).padStart(2, '0')} ${String(beijingTime.getUTCHours()).padStart(2, '0')}:${String(beijingTime.getUTCMinutes()).padStart(2, '0')}`
  }

  function formatDateTime(val) {
    const ts = toTimeValue(val)
    if (!ts) return ''
    return formatDateTimeParts(new Date(ts))
  }

  function addMinutesToDateTimeText(startTime, durationMinutes) {
    const parts = parseDateTimeParts(startTime)
    if (!parts) return ''
    return formatDateTimeParts(new Date(parts.dateObj.getTime() + Number(durationMinutes || 0) * 60000))
  }

  function buildOrderSessions(data = {}) {
    if (!data.startTime || !data.endTime) throw new Error('请选择服务时间')
    const startParts = parseDateTimeParts(data.startTime)
    const endParts = parseDateTimeParts(data.endTime)
    if (!startParts || !endParts || endParts.dateObj <= startParts.dateObj) throw new Error('服务时间不正确')
    const orderType = data.orderType === 'multi_day' || data.serviceFrequency === 'multi_day' || (data.endDate && data.endDate > String(data.startTime || '').slice(0, 10)) ? 'multi_day' : 'single'
    const durationMinutes = Math.max(Math.floor(Number(data.durationMinutes || ((endParts.dateObj.getTime() - startParts.dateObj.getTime()) / 60000))), 1)
    if (orderType !== 'multi_day') return [{ index: 1, date: formatDateKey(startParts.dateObj), startTime: data.startTime, endTime: addMinutesToDateTimeText(data.startTime, durationMinutes) || data.endTime, status: 'pending' }]

    const endDateText = safeText(data.endDate || data.serviceEndDate).trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(endDateText)) throw new Error('请选择连续服务结束日期')
    const [endYear, endMonth, endDay] = endDateText.split('-').map(Number)
    const [startYear, startMonth, startDay] = String(data.startTime).slice(0, 10).split('-').map(Number)
    const startDayTime = new Date(Date.UTC(startYear, startMonth - 1, startDay)).getTime()
    const endDayTime = new Date(Date.UTC(endYear, endMonth - 1, endDay)).getTime()
    if (endDayTime < startDayTime) throw new Error('连续服务结束日期不能早于开始日期')
    const sessions = []
    const utcHour = startParts.hour - 8
    const utcMinute = startParts.minute
    let current = new Date(Date.UTC(startYear, startMonth - 1, startDay, utcHour, utcMinute))
    const finalDay = new Date(Date.UTC(endYear, endMonth - 1, endDay, utcHour, utcMinute))
    while (current <= finalDay) {
      if (sessions.length >= 31) throw new Error('连续服务最多支持31天')
      const end = new Date(current.getTime() + durationMinutes * 60000)
      sessions.push({ index: sessions.length + 1, date: formatDateKey(current), startTime: formatDateTimeParts(current), endTime: formatDateTimeParts(end), status: 'pending' })
      current = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + 1, utcHour, utcMinute))
    }
    return sessions
  }

  function normalizeServiceSessions(order = {}) {
    const source = Array.isArray(order.serviceSessions) && order.serviceSessions.length
      ? order.serviceSessions
      : (order.startTime && order.endTime ? [{ index: 1, date: String(order.startTime).slice(0, 10), startTime: order.startTime, endTime: order.endTime }] : [])
    return source.map((session, index) => ({
      ...session,
      index: Number(session.index || index + 1),
      date: session.date || String(session.startTime || '').slice(0, 10),
      status: session.status || (Number(order.lastCompletedSessionIndex || 0) >= Number(session.index || index + 1) ? 'completed' : 'pending')
    }))
  }

  function beijingDateKey(value = now()) {
    return formatDateKey(new Date(toTimeValue(value) + 8 * 60 * 60 * 1000))
  }

  function getActiveServiceSession(order = {}) {
    const activeIndex = Number(order.activeSessionIndex || 0)
    return normalizeServiceSessions(order).find((session) => session.status === 'in_service' || (activeIndex && Number(session.index) === activeIndex)) || null
  }

  function getTodayServiceSession(order = {}, current = now()) {
    const today = beijingDateKey(current)
    return normalizeServiceSessions(order).find((session) => session.date === today && session.status !== 'completed') || null
  }

  function getNextPendingServiceSession(order = {}, current = now()) {
    return getTodayServiceSession(order, current) || normalizeServiceSessions(order).find((session) => session.status !== 'completed') || null
  }

  function markServiceSession(sessions, targetIndex, patch) {
    return normalizeServiceSessions({ serviceSessions: sessions }).map((session) => Number(session.index) === Number(targetIndex) ? { ...session, ...patch } : session)
  }

  function isFinalServiceSession(order = {}, session = {}) {
    const sessions = normalizeServiceSessions(order)
    return sessions.filter((item) => Number(item.index) !== Number(session.index)).every((item) => item.status === 'completed')
  }

  async function findActiveStaffService(staffOpenid, excludeOrderId = '') {
    if (!staffOpenid) return null
    const res = await db.collection('orders').where({ staffOpenid, status: ORDER_STATUS.IN_SERVICE }).limit(10).get()
    return (res.data || []).find((order) => !excludeOrderId || order._id !== excludeOrderId) || null
  }

  return {
    validateOrderTime,
    formatDateTimeParts,
    formatDateTime,
    addMinutesToDateTimeText,
    buildOrderSessions,
    normalizeServiceSessions,
    beijingDateKey,
    getActiveServiceSession,
    getTodayServiceSession,
    getNextPendingServiceSession,
    markServiceSession,
    isFinalServiceSession,
    findActiveStaffService
  }
}
