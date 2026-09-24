module.exports = function createService({
  WEEKDAY_NAMES,
  calcDistanceKm,
  db,
  formatDateKey,
  formatDateTimeParts,
  formatDistance,
  getDateKeyFromTime,
  now,
  parseDateTimeParts,
  safeText,
  toTimeValue
}) {
  function normalizeWeeklySchedule(raw) {
    if (!raw || typeof raw !== 'object') return null
    const result = {}
    let hasAnySlot = false
    for (let day = 1; day <= 7; day += 1) {
      const key = String(day)
      const list = Array.isArray(raw[key]) ? raw[key] : []
      const normalizedList = list
        .map((slot) => ({
          start: Math.max(0, Math.min(23, Math.floor(Number(slot.start || 0)))),
          end: Math.max(1, Math.min(24, Math.floor(Number(slot.end || 0))))
        }))
        .filter((slot) => slot.end > slot.start)
        .sort((a, b) => a.start - b.start)

      result[key] = normalizedList
      if (normalizedList.length > 0) hasAnySlot = true
    }
    return hasAnySlot ? result : null
  }

  function formatWeeklyScheduleText(weeklySchedule) {
    const normalized = normalizeWeeklySchedule(weeklySchedule)
    if (!normalized) return '全天可预约'
    const items = []
    for (let day = 1; day <= 7; day += 1) {
      const slots = normalized[String(day)] || []
      if (slots.length > 0) {
        const slotText = slots.map((s) => `${String(s.start).padStart(2, '0')}:00-${String(s.end).padStart(2, '0')}:00`).join('、')
        items.push(`${WEEKDAY_NAMES[day]} ${slotText}`)
      }
    }
    return items.length > 0 ? items.join('；') : '暂未设置接单时间段'
  }

  function validateSitterScheduleTime(weeklySchedule, startTimeStr, endTimeStr) {
    const normalized = normalizeWeeklySchedule(weeklySchedule)
    if (!normalized) return // 未配置按周时间段则不做时间段硬限制

    if (!startTimeStr || !endTimeStr) throw new Error('请选择服务时间')
    const startParts = parseDateTimeParts(startTimeStr)
    const endParts = parseDateTimeParts(endTimeStr)
    if (!startParts || !endParts || endParts.dateObj <= startParts.dateObj) {
      throw new Error('服务时间格式无效')
    }

    const durationHours = (endParts.dateObj.getTime() - startParts.dateObj.getTime()) / (3600 * 1000)

    if (startParts.dayOfWeek === endParts.dayOfWeek && durationHours <= 24) {
      const dayOfWeek = startParts.dayOfWeek
      const dayName = WEEKDAY_NAMES[dayOfWeek] || `周${dayOfWeek}`
      const startVal = startParts.hour + startParts.minute / 60
      const endVal = endParts.hour + endParts.minute / 60
      const slots = normalized[String(dayOfWeek)] || []
      if (!slots.length) {
        throw new Error(`宠托师在${dayName}未设置可接单时间段`)
      }
      const fitsInSlot = slots.some((slot) => startVal >= slot.start && endVal <= slot.end)
      if (!fitsInSlot) {
        const allowedText = slots.map((s) => `${String(s.start).padStart(2, '0')}:00-${String(s.end).padStart(2, '0')}:00`).join('、')
        throw new Error(`预约时间不在宠托师${dayName}的可接单时间段（${allowedText}）内`)
      }
      return
    }

    const startBeijingStr = formatDateTimeParts(startParts.dateObj)
    const endBeijingStr = formatDateTimeParts(endParts.dateObj)
    let currTime = startParts.dateObj.getTime()
    const endTime = endParts.dateObj.getTime()

    while (currTime < endTime) {
      const currBeijingStr = formatDateTimeParts(new Date(currTime))
      const currParts = parseDateTimeParts(currBeijingStr)
      const dayOfWeek = currParts.dayOfWeek
      const dayName = WEEKDAY_NAMES[dayOfWeek] || `周${dayOfWeek}`
      const slots = normalized[String(dayOfWeek)] || []

      if (!slots.length) {
        throw new Error(`宠托师在${dayName}未设置可接单时间段`)
      }

      const currDateStr = currBeijingStr.slice(0, 10)
      const endDateStr = endBeijingStr.slice(0, 10)
      const isEndDay = currDateStr === endDateStr

      const segmentStart = currParts.hour + currParts.minute / 60
      const segmentEnd = isEndDay ? (endParts.hour + endParts.minute / 60) : 24

      const fits = slots.some((slot) => segmentStart >= slot.start && segmentEnd <= slot.end)
      if (!fits) {
        const allowedText = slots.map((s) => `${String(s.start).padStart(2, '0')}:00-${String(s.end).padStart(2, '0')}:00`).join('、')
        throw new Error(`预约时间不在宠托师${dayName}的可接单时间段（${allowedText}）内`)
      }

      if (isEndDay) break
      const [cYear, cMonth, cDay] = currDateStr.split('-').map(Number)
      currTime = Date.UTC(cYear, cMonth - 1, cDay + 1, -8, 0)
    }
  }

  function normalizeScheduleSlots(raw) {
    const list = Array.isArray(raw) ? raw : []
    return list
      .map((slot) => ({
        start: Math.max(0, Math.min(23, Math.floor(Number(slot.start || 0)))),
        end: Math.max(1, Math.min(24, Math.floor(Number(slot.end || 0))))
      }))
      .filter((slot) => slot.end > slot.start)
      .sort((a, b) => a.start - b.start)
  }

  function normalizeScheduleException(data = {}, profile = {}) {
    const dateKey = safeText(data.dateKey).trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error('请选择日期')
    const status = data.status === 'available' ? 'available' : 'unavailable'
    const slots = status === 'available' ? normalizeScheduleSlots(data.slots) : []
    if (status === 'available' && !slots.length) throw new Error('请设置可接单时间段')
    return {
      staffProfileId: profile._id || data.staffProfileId || '',
      staffOpenid: profile.openid || data.staffOpenid || '',
      dateKey,
      status,
      slots,
      remark: safeText(data.remark).trim().slice(0, 80)
    }
  }

  function validateSlotsForDate(slots, startTimeStr, endTimeStr, dateKey, emptyMessage) {
    const startParts = parseDateTimeParts(startTimeStr)
    const endParts = parseDateTimeParts(endTimeStr)
    if (!startParts || !endParts || endParts.dateObj <= startParts.dateObj) throw new Error('服务时间格式无效')
    const startKey = getDateKeyFromTime(startTimeStr)
    const endKey = getDateKeyFromTime(endTimeStr)
    const endsAtMidnight = endParts.dateObj.getTime() === toTimeValue(dateKey) + 86400000
    if (startKey !== dateKey || (endKey !== dateKey && !endsAtMidnight)) throw new Error('跨日期服务需按天校验排班')
    if (!slots.length) throw new Error(emptyMessage)
    const startVal = startParts.hour + startParts.minute / 60
    const endVal = endsAtMidnight ? 24 : endParts.hour + endParts.minute / 60
    const fits = slots.some((slot) => startVal >= slot.start && endVal <= slot.end)
    if (!fits) {
      const allowedText = slots.map((s) => `${String(s.start).padStart(2, '0')}:00-${String(s.end).padStart(2, '0')}:00`).join('、')
      throw new Error(`预约时间不在宠托师当天可接单时间段（${allowedText}）内`)
    }
  }

  function isAdminDeletedOrder(order = {}) {
    return Boolean(order.adminDeletedAt)
  }

  function isOrderConflictCandidate(order = {}) {
    return !isAdminDeletedOrder(order) && ['paid', 'assigned', 'in_service', 'day_completed'].includes(order.status)
  }

  function timeRangesOverlap(startA, endA, startB, endB) {
    const aStart = toTimeValue(startA)
    const aEnd = toTimeValue(endA)
    const bStart = toTimeValue(startB)
    const bEnd = toTimeValue(endB)
    return aStart > 0 && aEnd > aStart && bStart > 0 && bEnd > bStart && aStart < bEnd && bStart < aEnd
  }

  function getOrderTimeRanges(order = {}) {
    const sessions = Array.isArray(order.serviceSessions) ? order.serviceSessions : []
    const ranges = sessions
      .filter(session => !['completed', 'cancelled'].includes(session.status))
      .map((session) => ({ startTime: session.startTime, endTime: session.endTime }))
      .filter((session) => session.startTime && session.endTime)
    if (sessions.length) return ranges
    return order.startTime && order.endTime ? [{ startTime: order.startTime, endTime: order.endTime }] : []
  }

  function orderTimeRangesOverlap(orderA = {}, orderB = {}) {
    return getOrderTimeRanges(orderA).some((rangeA) => getOrderTimeRanges(orderB).some((rangeB) => timeRangesOverlap(rangeA.startTime, rangeA.endTime, rangeB.startTime, rangeB.endTime)))
  }

  async function validateStaffScheduleOnly(profile, startTimeStr, endTimeStr, options = {}) {
    if (!profile || !profile.openid) throw new Error('宠托师不可用')
    const start = parseDateTimeParts(startTimeStr)
    const end = parseDateTimeParts(endTimeStr)
    if (!start || !end || end.dateObj <= start.dateObj) throw new Error('服务时间格式无效')
    let cursor = start.dateObj.getTime()
    const finish = end.dateObj.getTime()
    // Split at Beijing midnight so each day's exception overrides its weekly schedule.
    while (cursor < finish) {
      const segmentStart = formatDateTimeParts(new Date(cursor))
      const dateKey = getDateKeyFromTime(segmentStart)
      const segmentEndTs = Math.min(finish, toTimeValue(dateKey) + 86400000)
      const segmentEnd = formatDateTimeParts(new Date(segmentEndTs))
      const exception = Array.isArray(options.exceptions)
        ? options.exceptions.find(item => item.staffOpenid === profile.openid && item.dateKey === dateKey)
        : (await db.collection('staff_schedule_exceptions').where({ staffOpenid: profile.openid, dateKey }).limit(1).get()).data[0]
      if (exception) {
        if (exception.status === 'unavailable') throw new Error('宠托师当天设置为休息，无法预约')
        validateSlotsForDate(normalizeScheduleSlots(exception.slots), segmentStart, segmentEnd, dateKey, '宠托师当天未设置可接单时间段')
      } else {
        validateSitterScheduleTime(profile.weeklySchedule, segmentStart, segmentEnd)
      }
      cursor = segmentEndTs
    }
  }

  async function validateStaffAvailability(profile, startTimeStr, endTimeStr, options = {}) {
    return validateStaffAvailabilityForSessions(profile, [{ startTime: startTimeStr, endTime: endTimeStr }], options)
  }

  async function validateStaffAvailabilityForSessions(profile, sessions = [], options = {}) {
    for (const session of sessions) {
      await validateStaffScheduleOnly(profile, session.startTime, session.endTime)
    }

    const candidate = { serviceSessions: sessions }
    const conflict = await findStaffOrderConflict(profile.openid, candidate, options.excludeOrderId)
    if (conflict) throw new Error('宠托师该时间段已有订单，无法重复预约')
  }

  async function* staffConflictOrderPages(openid) {
    let cursor = ''
    while (true) {
      const where = { staffOpenid: openid, status: db.command.in(['paid', 'assigned', 'in_service', 'day_completed']) }
      if (cursor) where._id = db.command.gt(cursor)
      const page = (await db.collection('orders').where(where).orderBy('_id', 'asc').limit(100).get()).data || []
      yield page
      if (page.length < 100) return
      cursor = page[page.length - 1]._id
    }
  }

  async function findStaffOrderConflict(openid, candidate, excludeOrderId = '', transaction = null) {
    for await (const page of staffConflictOrderPages(openid)) {
      for (const item of page) {
        if (item._id === excludeOrderId || !isOrderConflictCandidate(item) || !orderTimeRangesOverlap(candidate, item)) continue
        const current = transaction ? (await transaction.collection('orders').doc(item._id).get()).data : item
        if (current && current.staffOpenid === openid && isOrderConflictCandidate(current) && orderTimeRangesOverlap(candidate, current)) return current
      }
    }
    return null
  }

  function buildAcceptRiskNotice(warnings = []) {
    return {
      requiresConfirmation: warnings.length > 0,
      warnings,
      noticeTitle: '超出接单设置确认',
      noticeItems: [
        '接单后必须按订单约定时间准时出发并完成服务，不得因距离较远或非本人常规接单时间擅自迟到、爽约或降低服务质量。',
        '未按规定时间服务、未及时出发、无法按时到达或服务缺失，可能导致客户投诉、订单退款、差评、收益扣减或保证金/信用处罚。',
        '若服务过程中发生异常，应第一时间联系客户并在平台内留痕，必要时联系平台客服协助处理。',
        '继续接单即表示你已充分评估交通、时间、服务距离和自身安排，并承诺遵守平台履约规范。'
      ]
    }
  }

  async function checkAcceptOrderRisk(profile, order) {
    console.log('【调试】开始风险检测')
    console.log('【调试】宠托师信息:', {
      openid: profile.openid,
      serviceLatitude: profile.serviceLatitude,
      serviceLongitude: profile.serviceLongitude,
      serviceRadiusKm: profile.serviceRadiusKm,
      hasWeeklySchedule: !!profile.weeklySchedule,
      weeklySchedule: profile.weeklySchedule
    })
    console.log('【调试】订单信息:', {
      orderId: order._id,
      startTime: order.startTime,
      endTime: order.endTime,
      addressLatitude: order.addressLatitude,
      addressLongitude: order.addressLongitude
    })

    const warnings = []

    // 【修改】检查距离风险 - 这里是基于固定服务地址的距离，仅作为参考提示
    // 实际的强制限制已在acceptOrder中使用实时位置验证
    const radiusKm = Math.max(Number(profile.serviceRadiusKm || 5), 1)
    const distanceKm = calcDistanceKm(profile.serviceLatitude, profile.serviceLongitude, order.addressLatitude, order.addressLongitude)
    console.log('【调试】距离检测:', { distanceKm, radiusKm, 超出: distanceKm !== null && distanceKm > radiusKm })
    if (distanceKm !== null && distanceKm > radiusKm) {
      warnings.push({
        type: 'range',
        title: '订单地址距离你的固定服务地址较远',
        detail: `订单距离你设置的固定服务地址约 ${formatDistance(distanceKm)}，已超出 ${radiusKm}km 接单范围。接单以当前位置为准，请确认能按时到达。`,
        distanceKm,
        radiusKm
      })
    }

    // 【修改】检查时间风险 - 改为仅警告，不阻止接单
    const sessions = getOrderTimeRanges(order)
    console.log('【调试】订单时间段:', sessions)
    const failedSessions = []
    const hasWeeklySchedule = normalizeWeeklySchedule(profile.weeklySchedule) !== null
    console.log('【调试】是否配置接单时间:', hasWeeklySchedule)

    for (const session of sessions) {
      try {
        await validateStaffScheduleOnly(profile, session.startTime, session.endTime)
        console.log('【调试】时间段验证通过:', session.startTime)
      } catch (error) {
        console.log('【调试】时间段验证失败:', session.startTime, error.message)
        failedSessions.push(`${session.startTime}：${error.message || '不在你设置的可接单时间段内'}`)
      }
    }

    if (failedSessions.length) {
      console.log('【调试】时间不匹配，添加风险警告，失败数量:', failedSessions.length)
      warnings.push({
        type: 'time',
        title: '订单时间不在你的接单时间内',
        detail: failedSessions.slice(0, 3).join('；') + (failedSessions.length > 3 ? `；另有 ${failedSessions.length - 3} 次` : '') + '。接单后请务必按时服务。'
      })
    }

    console.log('【调试】最终warnings数量:', warnings.length)
    console.log('【调试】warnings内容:', JSON.stringify(warnings, null, 2))

    const result = buildAcceptRiskNotice(warnings)
    console.log('【调试】风险通知结果:', JSON.stringify(result, null, 2))
    return result
  }

  async function buildStaffAvailability(profile, startDateKey = '', days = 14) {
    // Use Beijing noon so UTC conversion cannot move the calendar to the previous day.
    const today = formatDateKey(new Date(now().getTime() + 8 * 60 * 60 * 1000))
    const baseParts = parseDateTimeParts(`${startDateKey || today} 12:00`)
    const base = baseParts ? baseParts.dateObj : now()
    const normalizedWeekly = normalizeWeeklySchedule(profile.weeklySchedule)
    const maxDays = Math.min(Math.max(Number(days || 14), 1), 31)
    const exceptions = (await db.collection('staff_schedule_exceptions').where({ staffOpenid: profile.openid }).get()).data || []
    const orders = []
    for await (const page of staffConflictOrderPages(profile.openid)) orders.push(...page)
    const availableOrders = orders.filter(isOrderConflictCandidate)
    const list = []
    for (let i = 0; i < maxDays; i += 1) {
      const date = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + i, 0, 0))
      const dateKey = formatDateKey(date)
      const dayOfWeek = date.getUTCDay() === 0 ? 7 : date.getUTCDay()
      const exception = exceptions.find((item) => item.dateKey === dateKey)
      let source = 'weekly'
      let slots = normalizedWeekly ? (normalizedWeekly[String(dayOfWeek)] || []) : [{ start: 0, end: 24 }]
      let status = slots.length ? 'available' : 'unavailable'
      let remark = ''
      if (exception) {
        source = 'exception'
        status = exception.status === 'available' ? 'available' : 'unavailable'
        slots = status === 'available' ? normalizeScheduleSlots(exception.slots) : []
        remark = exception.remark || ''
      }
      const busyOrders = availableOrders
        .flatMap(order => getOrderTimeRanges(order)
          .filter(range => getDateKeyFromTime(range.startTime) === dateKey)
          .map(range => ({ orderId: order._id, ...range, serviceSummary: order.serviceSummary || '' })))
      list.push({ dateKey, dayOfWeek, dayName: WEEKDAY_NAMES[dayOfWeek], source, status, slots, busyOrders, remark })
    }
    return list
  }

  return {
    normalizeWeeklySchedule,
    formatWeeklyScheduleText,
    validateSitterScheduleTime,
    normalizeScheduleSlots,
    normalizeScheduleException,
    validateSlotsForDate,
    isAdminDeletedOrder,
    isOrderConflictCandidate,
    findStaffOrderConflict,
    timeRangesOverlap,
    getOrderTimeRanges,
    orderTimeRangesOverlap,
    validateStaffScheduleOnly,
    validateStaffAvailability,
    validateStaffAvailabilityForSessions,
    buildAcceptRiskNotice,
    checkAcceptOrderRisk,
    buildStaffAvailability
  }
}
