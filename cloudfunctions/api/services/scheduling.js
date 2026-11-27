const { clockHours } = require('../utils/time')
const { readDocuments } = require('../utils/documentPages')
const { isParticipatingGroupOrder } = require('../utils/groupBuyMembership')
const { extractOrderPetSnapshots, summarizePetsForStaff } = require('../utils/petOrderSummary')
module.exports = function createService({
  WEEKDAY_NAMES,
  calcDistanceKm,
  db,
  formatDateKey,
  formatDateTimeParts,
  formatDistance,
  getDateKeyFromTime,
  now,
  getOrderPaymentDeadline,
  parseDateTimeParts,
  safeText,
  toTimeValue
}) {
  function normalizeScheduleSlots(raw) {
    const list = Array.isArray(raw) ? raw : []
    const sorted = list
      .map((slot) => ({
        start: Math.max(0, Math.min(23, Math.floor(Number(slot.start || 0)))),
        end: Math.max(1, Math.min(24, Math.floor(Number(slot.end || 0))))
      }))
      .filter((slot) => slot.end > slot.start)
      .sort((a, b) => a.start - b.start || a.end - b.end)
    const merged = []
    for (const slot of sorted) {
      const prev = merged[merged.length - 1]
      if (prev && slot.start <= prev.end) {
        prev.end = Math.max(prev.end, slot.end)
      } else {
        merged.push({ start: slot.start, end: slot.end })
      }
    }
    return merged
  }

  function normalizeWeeklySchedule(raw) {
    if (!raw || typeof raw !== 'object') return null
    const result = {}
    let hasAnySlot = false
    for (let day = 1; day <= 7; day += 1) {
      const key = String(day)
      const normalizedList = normalizeScheduleSlots(raw[key])
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
      const startVal = clockHours(startParts)
      const endVal = clockHours(endParts)
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

      const segmentStart = clockHours(currParts)
      const segmentEnd = isEndDay ? (clockHours(endParts)) : 24

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
    const mergedSlots = normalizeScheduleSlots(slots)
    const startParts = parseDateTimeParts(startTimeStr)
    const endParts = parseDateTimeParts(endTimeStr)
    if (!startParts || !endParts || endParts.dateObj <= startParts.dateObj) throw new Error('服务时间格式无效')
    const startKey = getDateKeyFromTime(startTimeStr)
    const endKey = getDateKeyFromTime(endTimeStr)
    const endsAtMidnight = endParts.dateObj.getTime() === toTimeValue(dateKey) + 86400000
    if (startKey !== dateKey || (endKey !== dateKey && !endsAtMidnight)) throw new Error('跨日期服务需按天校验排班')
    if (!mergedSlots.length) throw new Error(emptyMessage)
    const startVal = clockHours(startParts)
    const endVal = endsAtMidnight ? 24 : clockHours(endParts)
    const fits = mergedSlots.some((slot) => startVal >= slot.start && endVal <= slot.end)
    if (!fits) {
      const allowedText = mergedSlots.map((s) => `${String(s.start).padStart(2, '0')}:00-${String(s.end).padStart(2, '0')}:00`).join('、')
      throw new Error(`预约时间不在宠托师当天可接单时间段（${allowedText}）内`)
    }
  }

  function isAdminDeletedOrder(order = {}) {
    return Boolean(order.adminDeletedAt)
  }

  function isOrderConflictCandidate(order = {}) {
    if (isAdminDeletedOrder(order)) return false
    if (['paid', 'assigned', 'on_the_way', 'in_service', 'day_completed'].includes(order.status)) return true
    if (order.status === 'pending_pay' && order.publishMode === 'direct') {
      const deadline = getOrderPaymentDeadline(order)
      // A payment in flight keeps its hold until provider reconciliation closes it.
      // Releasing it by wall time alone can let a late successful callback double-book.
      return order.paymentStatus !== 'closed' && (order.paymentStatus === 'paying' || !!order.paymentNo || deadline > now().getTime())
    }
    return false
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
      if (profile.bookableUntilDate && dateKey > profile.bookableUntilDate) {
        throw new Error(`宠托师暂未开放 ${profile.bookableUntilDate} 之后的预约服务`)
      }
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
      await validateStaffScheduleOnly(profile, session.startTime, session.endTime, options)
    }

    const candidate = { serviceSessions: sessions }
    const conflict = await findStaffOrderConflict(profile.openid, candidate, options.excludeOrderId, options.transaction)
    if (conflict) throw new Error('宠托师该时间段已有订单，无法重复预约')
  }

  async function* staffConflictOrderPages(openid, store = db) {
    let cursor1 = ''
    while (true) {
      const where1 = { staffOpenid: openid, status: db.command.in(['paid', 'assigned', 'on_the_way', 'in_service', 'day_completed']) }
      if (cursor1) where1._id = db.command.gt(cursor1)
      const page1 = (await store.collection('orders').where(where1).orderBy('_id', 'asc').limit(100).get()).data || []
      if (page1.length) yield page1
      if (page1.length < 100) break
      cursor1 = page1[page1.length - 1]._id
    }
    let cursor2 = ''
    while (true) {
      const where2 = { requestedStaffOpenid: openid, publishMode: 'direct', status: db.command.in(['paid', 'pending_pay']) }
      if (cursor2) where2._id = db.command.gt(cursor2)
      const page2 = (await store.collection('orders').where(where2).orderBy('_id', 'asc').limit(100).get()).data || []
      if (page2.length) yield page2
      if (page2.length < 100) break
      cursor2 = page2[page2.length - 1]._id
    }
  }

  async function findStaffOrderConflict(openid, candidate, excludeOrderId = '', transaction = null) {
    const seenIds = new Set()
    for await (const page of staffConflictOrderPages(openid, transaction || db)) {
      for (const item of page) {
        if (item._id === excludeOrderId || seenIds.has(item._id)) continue
        seenIds.add(item._id)
        if (candidate.groupBuyId && item.groupBuyId && candidate.groupBuyId === item.groupBuyId) continue
        if (!isOrderConflictCandidate(item) || !orderTimeRangesOverlap(candidate, item)) continue
        const current = transaction ? (await transaction.collection('orders').doc(item._id).get().catch(() => ({ data: null }))).data : item
        if (!current) continue
        if (candidate.groupBuyId && current.groupBuyId && candidate.groupBuyId === current.groupBuyId) continue
        const isMatch = current.staffOpenid === openid || (current.requestedStaffOpenid === openid && current.publishMode === 'direct')
        if (isMatch && isOrderConflictCandidate(current) && orderTimeRangesOverlap(candidate, current)) return current
      }
    }
    return null
  }

  function buildAcceptRiskNotice(warnings = []) {
    const hasLargeDog = warnings.some((item) => item && item.type === 'large_dog')
    const hasScheduleOrRange = warnings.some((item) => item && item.type !== 'large_dog')
    const noticeTitle = hasLargeDog && hasScheduleOrRange
      ? '接单风险与大型犬安全确认'
      : hasLargeDog
        ? '大型犬接单安全确认'
        : '超出接单设置确认'
    const noticeDesc = hasLargeDog && !hasScheduleOrRange
      ? '该订单包含体重 ≥25kg 的大型犬，接单前请确认具备相应控犬与安全照护能力。'
      : hasLargeDog
        ? '该订单包含大型犬且与你的接单设置存在差异，请仔细核对后再确认接单。'
        : '该订单与你的接单设置不完全匹配，请确认是否仍要继续接单。'
    const noticeItems = [
      ...(hasLargeDog ? [
        '服务大型犬须确认自身具备控犬与应急处理能力：进出家门先确认防冲门措施，外出遛狗必须全程佩戴牢固牵引绳或胸背带并短牵控绳，严禁松绳脱手，主动避让行人与其他动物。'
      ] : []),
      '接单后必须按订单约定时间准时出发并完成服务，不得因距离较远或非本人常规接单时间擅自迟到、爽约或降低服务质量。',
      '未按规定时间服务、未及时出发、无法按时到达或服务缺失，可能导致客户投诉、订单退款、差评、收益扣减或保证金/信用处罚。',
      '若服务过程中发生异常，应第一时间联系客户并在平台内留痕，必要时联系平台客服协助处理。',
      '继续接单即表示你已充分评估交通、时间、服务距离和自身安排，并承诺遵守平台履约规范。'
    ]
    return {
      requiresConfirmation: warnings.length > 0,
      hasLargeDog,
      warnings,
      noticeTitle,
      noticeDesc,
      noticeItems
    }
  }

  async function resolveOrderPetsForRisk(targetOrders = []) {
    const collected = []
    for (const item of targetOrders) {
      if (!item) continue
      const snapshots = extractOrderPetSnapshots(item)
      if (snapshots.length && snapshots.every((pet) => Number(pet.weight) > 0)) {
        collected.push(...snapshots)
        continue
      }
      const petIds = Array.isArray(item.petIds) && item.petIds.length ? item.petIds : [item.petId].filter(Boolean)
      if (petIds.length && db && typeof db.collection === 'function') {
        const loaded = await Promise.all(petIds.map(async (petId, idx) => {
          const doc = await db.collection('pets').doc(petId).get().catch(() => ({ data: null }))
          return doc && doc.data ? { ...(snapshots[idx] || {}), ...doc.data } : snapshots[idx]
        }))
        collected.push(...loaded.filter(Boolean))
      } else {
        collected.push(...snapshots)
      }
    }
    return collected
  }

  async function checkAcceptOrderRisk(profile, order, options = {}) {
    const warnings = []

    // 检查大型犬风险（单户订单或同小区拼单整团子单中任一狗狗体重 ≥25kg 均需提醒确认）
    let targetOrders = Array.isArray(options.bundleOrders) && options.bundleOrders.length ? options.bundleOrders : [order]
    if (!options.bundleOrders && order && order.groupBuyId && db && typeof db.collection === 'function') {
      try {
        const siblings = await readDocuments(db, db.command, 'orders', { groupBuyId: order.groupBuyId })
        const participating = siblings.filter(isParticipatingGroupOrder)
        if (participating.length) targetOrders = participating
      } catch (_) {}
    }
    const allPets = await resolveOrderPetsForRisk(targetOrders)
    const petSummary = summarizePetsForStaff(allPets)
    if (petSummary.hasLargeDog) {
      const dogLabels = petSummary.largeDogs.map((d) => d.label).join('、')
      warnings.push({
        type: 'large_dog',
        title: `订单包含大型犬（≥25kg）：${dogLabels}`,
        detail: `本单需服务大型犬（${dogLabels}），力量与爆发力较强。接单前请确认具备大型犬控绳与安抚经验，进出家门严防冲门，遛狗全程系牢牵引绳并避开密集人群与其他犬只。`,
        largeDogs: petSummary.largeDogs
      })
    }

    // 检查距离风险 - 这里是基于固定服务地址的距离，仅作为参考提示
    // 实际的强制限制已在acceptOrder中使用实时位置验证
    const radiusKm = Math.max(Number(profile.serviceRadiusKm || 5), 1)
    let maxDistanceKm = null
    for (const target of targetOrders) {
      if (!target) continue
      const dist = calcDistanceKm(profile.serviceLatitude, profile.serviceLongitude, target.addressLatitude, target.addressLongitude)
      if (dist !== null && (maxDistanceKm === null || dist > maxDistanceKm)) {
        maxDistanceKm = dist
      }
    }
    if (maxDistanceKm !== null && maxDistanceKm > radiusKm) {
      warnings.push({
        type: 'range',
        title: '订单地址距离你的固定服务地址较远',
        detail: `订单距离你设置的固定服务地址约 ${formatDistance(maxDistanceKm)}，已超出 ${radiusKm}km 接单范围。接单以当前位置为准，请确认能按时到达。`,
        distanceKm: maxDistanceKm,
        radiusKm
      })
    }

    // 检查时间风险 - 作为警告，提示宠托师确认按时履约（含拼单整团各户服务时段）
    const sessions = targetOrders.filter(Boolean).flatMap((target) => getOrderTimeRanges(target))
    const failedSessions = []
    const seenSessionFailure = new Set()

    for (const session of sessions) {
      try {
        await validateStaffScheduleOnly(profile, session.startTime, session.endTime)
      } catch (error) {
        const msg = `${session.startTime}：${error.message || '不在你设置的可接单时间段内'}`
        if (!seenSessionFailure.has(msg)) {
          seenSessionFailure.add(msg)
          failedSessions.push(msg)
        }
      }
    }

    if (failedSessions.length) {
      warnings.push({
        type: 'time',
        title: '订单时间不在你的接单时间内',
        detail: failedSessions.slice(0, 3).join('；') + (failedSessions.length > 3 ? `；另有 ${failedSessions.length - 3} 次` : '') + '。接单后请务必按时服务。'
      })
    }

    return buildAcceptRiskNotice(warnings)
  }

  async function buildStaffAvailability(profile, startDateKey = '', days = 14) {
    // Use Beijing noon so UTC conversion cannot move the calendar to the previous day.
    const today = formatDateKey(new Date(now().getTime() + 8 * 60 * 60 * 1000))
    const baseParts = parseDateTimeParts(`${startDateKey || today} 12:00`)
    const base = baseParts ? baseParts.dateObj : now()
    const normalizedWeekly = normalizeWeeklySchedule(profile.weeklySchedule)
    const maxDays = Math.min(Math.max(Number(days || 14), 1), 31)
    const exceptions = await readDocuments(db, db.command, 'staff_schedule_exceptions', { staffOpenid: profile.openid })
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
      if (profile.bookableUntilDate && dateKey > profile.bookableUntilDate) {
        status = 'unavailable'
        slots = []
        remark = `接单截止至 ${profile.bookableUntilDate}`
      } else if (exception) {
        source = 'exception'
        status = exception.status === 'available' ? 'available' : 'unavailable'
        slots = status === 'available' ? normalizeScheduleSlots(exception.slots) : []
        remark = exception.remark || (status === 'unavailable' ? '休息不接单' : '')
      }
      const dayStart = toTimeValue(dateKey)
      const dayEnd = dayStart + 86400000
      const busyOrders = availableOrders
        .flatMap(order => getOrderTimeRanges(order)
          .filter(range => toTimeValue(range.startTime) < dayEnd && toTimeValue(range.endTime) > dayStart)
          .map(range => ({ orderId: order._id,
            startTime: toTimeValue(range.startTime) < dayStart ? formatDateTimeParts(new Date(dayStart)) : range.startTime,
            endTime: toTimeValue(range.endTime) > dayEnd ? formatDateTimeParts(new Date(dayEnd)) : range.endTime,
            serviceSummary: order.serviceSummary || '' })))
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
