const { readOptionalDocument } = require('../utils/documentPages')
const { matchesStaffGender } = require('../utils/staffGender')

function isStaffPreviouslyAssignedToOrder(order = {}, staffOpenid = '') {
  if (!order || !staffOpenid) return false
  const target = String(staffOpenid).trim()
  if (!target) return false
  if (String(order.originalStaffOpenid || '').trim() === target) return true
  if (Array.isArray(order.previousStaffRecords)) {
    return order.previousStaffRecords.some(r => String(r && r.staffOpenid || '').trim() === target)
  }
  return false
}

function buildPublicOrderGrabData(order = {}, detail = {}, helpers = {}) {
  const sanitize = (value) => String(value || '').replace(/[\r\n\t]+/g, ' ').trim()
  const formatDateTime = helpers.formatDateTime || ((v) => String(v || ''))
  const now = helpers.now || (() => new Date())

  const isUrgent = Boolean(
    order.isUrgent === true ||
    order.assignmentSource === 'admin_urgent_republish' ||
    (Number(order.urgentBonus || 0) > 0) ||
    (Number(order.urgentStaffReward || 0) > 0)
  )

  // 1. 服务类别 (thing1, 限制 20 字)
  const rawService = order.serviceSummary || (order.serviceType === 'walk' ? '上门遛狗' : '上门喂养') || '宠护服务'
  const serviceType = sanitize(rawService).slice(0, 20) || '宠护服务'

  // 2. 服务标题 (thing2, 限制 20 字)
  const locationDesc = sanitize(order.serviceAddress || order.addressDetail || order.city || '附近需求')
  const prefix = isUrgent ? '【加急抢单】' : '【抢单提醒】'
  const maxLocLen = 20 - prefix.length
  const title = (prefix + locationDesc.slice(0, maxLocLen)).slice(0, 20)

  // 3. 宠物名称 (thing3, 限制 20 字)
  const pets = Array.isArray(order.petSnapshots) && order.petSnapshots.length
    ? order.petSnapshots
    : [order.petSnapshot].filter(Boolean)
  const rawPetNames = pets.map(p => p && p.name).filter(Boolean).join('、') || order.petName || '爱宠'
  const petName = sanitize(rawPetNames).slice(0, 20) || '爱宠'

  // 4. 需求时间 (time4, 限制 20 字，标准时间格式)
  const timeText = sanitize(formatDateTime(order.startTime || detail.startTime || now())).slice(0, 20)

  // 5. 订单金额 (amount5, 限制金额格式，支持小数两位)
  const rawAmount = Number(detail.staffEarning !== undefined ? detail.staffEarning : (order.payAmount || 0))
  const amountStr = Math.max(0, rawAmount).toFixed(2)

  return {
    thing1: { value: serviceType },
    thing2: { value: title },
    thing3: { value: petName },
    time4: { value: timeText },
    amount5: { value: amountStr }
  }
}

module.exports = function createService(context) {
  const {
    calcDistanceKm,
    calculateStaffEarningForOrder,
    db,
    formatDateTime,
    formatDistance,
    getDateKeyFromTime,
    getOrderTimeRanges,
    getSystemSettings,
    hasCoordinate,
    makeIdempotencyKey,
    now,
    orderMatchesCity,
    safeText,
    sendSubscribeMessage,
    toTimeValue,
    validateStaffScheduleOnly,
    validateStaffTakeOrderAbility,
    findStaffOrderConflict
  } = context

  /**
   * 判断订单是否属于可被抢单状态
   */
  function isOrderEligibleForGrab(order) {
    if (!order || !order._id) return false
    if (order.status !== 'paid' || order.paymentStatus !== 'paid') return false
    if (order.publishMode !== 'open') return false
    if (order.staffOpenid || order.requestedStaffOpenid) return false
    if (order.deletedAt) return false
    if (order.isAdminDeleted === true || order.deletedByAdmin === true) return false
    // 拼单必须成团且未退款
    if (order.groupBuyId && (order.groupBuyStatus !== 'formed' || order.groupBuyRefundRequired)) return false
    // 服务开始时间已过
    const startTs = toTimeValue(order.startTime)
    if (startTs && startTs <= now().getTime()) return false
    return true
  }

  /**
   * 筛选单个宠托师是否符合该订单的可抢单资格
   */
  async function checkSitterEligibilityForOrder(profile, order, settings, scheduleExceptions = []) {
    if (!profile || !profile.openid) return { eligible: false, reason: 'invalid_profile' }

    // 1. 不能抢自己发布的订单
    if (order.clientOpenid && profile.openid === order.clientOpenid) {
      return { eligible: false, reason: 'self_order' }
    }

    // 2. 接单开关
    if (profile.acceptOrders === false) {
      return { eligible: false, reason: 'take_orders_disabled' }
    }

    // 3. 宠托师资格、培训与保证金状态
    const ability = validateStaffTakeOrderAbility(profile, settings.staffDeposit)
    if (!ability.can) {
      return { eligible: false, reason: ability.reason || 'inability' }
    }

    // 4. 固定服务地址与有效经纬度设置
    if (!hasCoordinate(profile.serviceLatitude, profile.serviceLongitude) || !profile.serviceAddress) {
      return { eligible: false, reason: 'missing_service_address' }
    }

    // 5. 客户指定性别要求
    if (!matchesStaffGender(order, profile)) {
      return { eligible: false, reason: 'gender_mismatch' }
    }

    // 6. 历史接单记录排查（超时违约转加急禁止重抢）
    if (isStaffPreviouslyAssignedToOrder(order, profile.openid)) {
      return { eligible: false, reason: 'previously_assigned_staff' }
    }

    // 7. 历史取消排查（该宠托师此前已取消过该订单）
    if (Array.isArray(order.cancelledStaffOpenids) && order.cancelledStaffOpenids.includes(profile.openid)) {
      return { eligible: false, reason: 'previously_cancelled_staff' }
    }

    // 8. 疫苗认证拒绝设置校验
    const hasUnvaccinatedPets = Boolean(
      (Array.isArray(order.petSnapshots) && order.petSnapshots.some(p => p && p.isVaccinated === false)) ||
      (order.petSnapshot && order.petSnapshot.isVaccinated === false) ||
      order.hasUnvaccinatedPets === true
    )
    if (profile.rejectUnvaccinatedPets === true && hasUnvaccinatedPets) {
      return { eligible: false, reason: 'unvaccinated_pet_rejected' }
    }

    // 9. 服务范围判断（Service Range & Distance）
    const orderLat = Number(order.serviceLatitude || order.addressLatitude || 0)
    const orderLng = Number(order.serviceLongitude || order.addressLongitude || 0)
    if (!hasCoordinate(orderLat, orderLng)) {
      return { eligible: false, reason: 'order_missing_coordinates' }
    }

    const distanceKm = calcDistanceKm(profile.serviceLatitude, profile.serviceLongitude, orderLat, orderLng)
    const serviceRadiusKm = Math.max(Number(profile.serviceRadiusKm || 5), 1)
    if (distanceKm === null || distanceKm > serviceRadiusKm) {
      return { eligible: false, reason: 'out_of_service_range', distanceKm, serviceRadiusKm }
    }

    if (profile.city && typeof orderMatchesCity === 'function' && !orderMatchesCity(order, profile.city)) {
      return { eligible: false, reason: 'city_mismatch' }
    }

    // 10. 服务时间范围判断（Service Time & Schedule）
    const sessions = getOrderTimeRanges(order)
    if (!sessions.length) {
      return { eligible: false, reason: 'empty_order_sessions' }
    }

    // 10.1 截止日期检查
    for (const session of sessions) {
      const dateKey = getDateKeyFromTime(session.startTime)
      if (profile.bookableUntilDate && dateKey > profile.bookableUntilDate) {
        return { eligible: false, reason: 'beyond_bookable_until_date', dateKey, bookableUntilDate: profile.bookableUntilDate }
      }
    }

    // 10.2 排班检查（周排班 weeklySchedule 与特殊休息日 staff_schedule_exceptions）
    try {
      for (const session of sessions) {
        await validateStaffScheduleOnly(profile, session.startTime, session.endTime, { exceptions: scheduleExceptions })
      }
    } catch (scheduleErr) {
      return { eligible: false, reason: 'out_of_working_hours', error: scheduleErr.message }
    }

    // 10.3 订单重叠冲突检查
    if (typeof findStaffOrderConflict === 'function') {
      const conflict = await findStaffOrderConflict(profile.openid, order, order._id)
      if (conflict) {
        return { eligible: false, reason: 'schedule_conflict', conflictOrderId: conflict._id }
      }
    }

    // 11. 在途订单上限与单日接单上限
    const inOp = db.command && typeof db.command.in === 'function' ? db.command.in : (list) => list
    const activeStatuses = ['assigned', 'on_the_way', 'in_service', 'day_completed']
    const activeOrdersRes = await db.collection('orders').where({
      staffOpenid: profile.openid,
      status: inOp(activeStatuses)
    }).count().catch(() => ({ total: 0 }))
    const maxActiveOrders = Number(settings.dispatch && settings.dispatch.maxStaffActiveOrders || 8)
    if ((activeOrdersRes.total || 0) >= maxActiveOrders) {
      return { eligible: false, reason: 'max_active_orders_reached' }
    }

    const targetDate = String(order.serviceStartDate || order.startTime || '').slice(0, 10)
    if (targetDate) {
      const dailyOrdersRes = await db.collection('orders').where({
        staffOpenid: profile.openid,
        status: inOp(['assigned', 'on_the_way', 'in_service', 'day_completed', 'completed'])
      }).get().catch(() => ({ data: [] }))
      const sameDayOrders = (dailyOrdersRes.data || []).filter((o) => {
        const oDate = String(o.serviceStartDate || o.startTime || '').slice(0, 10)
        return oDate === targetDate && o._id !== order._id
      })
      const maxDailyOrders = Number(settings.dispatch && settings.dispatch.maxStaffDailyOrders || 6)
      if (sameDayOrders.length >= maxDailyOrders) {
        return { eligible: false, reason: 'max_daily_orders_reached' }
      }
    }

    return { eligible: true, distanceKm }
  }

  /**
   * 当公共订单发布/支付或转加急时，通知符合全部条件的就近宠托师
   */
  async function notifyEligibleSittersForPublicOrder(order, options = {}) {
    if (!isOrderEligibleForGrab(order)) {
      return { status: 'skipped', reason: 'order_not_eligible_for_grab', notifiedCount: 0 }
    }

    const settings = await getSystemSettings()
    if (!settings.subscription || !settings.subscription.enabled) {
      return { status: 'skipped', reason: 'subscription_disabled', notifiedCount: 0 }
    }

    // 1. 获取候选宠托师档案
    let candidateProfiles = []
    if (Array.isArray(options.candidateProfiles)) {
      candidateProfiles = options.candidateProfiles
    } else {
      const condition = {
        auditStatus: 'approved'
      }
      const fetchRes = await db.collection('staff_profiles').where(condition).limit(100).get().catch(() => ({ data: [] }))
      candidateProfiles = fetchRes.data || []
    }

    if (!candidateProfiles.length) {
      return { status: 'skipped', reason: 'no_approved_sitters', notifiedCount: 0 }
    }

    // 2. 批量评估宠托师符合度
    const eligibleSitters = []
    for (const profile of candidateProfiles) {
      const exceptionsRes = await db.collection('staff_schedule_exceptions').where({ staffOpenid: profile.openid }).get().catch(() => ({ data: [] }))
      const scheduleExceptions = exceptionsRes.data || []

      const checkResult = await checkSitterEligibilityForOrder(profile, order, settings, scheduleExceptions)
      if (checkResult.eligible) {
        eligibleSitters.push({
          profile,
          distanceKm: checkResult.distanceKm
        })
      }
    }

    if (!eligibleSitters.length) {
      return { status: 'skipped', reason: 'no_eligible_sitters_found', notifiedCount: 0 }
    }

    // 3. 按距离由近及远排序
    eligibleSitters.sort((a, b) => a.distanceKm - b.distanceKm)

    // 4. 取就近前 N 位（默认 8 位）
    const maxRecipients = Number(settings.dispatch && settings.dispatch.maxPublicGrabRecipients || 8)
    const targets = eligibleSitters.slice(0, maxRecipients)

    // 5. 计算预计收益
    let earningAmount = 0
    if (typeof calculateStaffEarningForOrder === 'function') {
      try {
        const earning = await calculateStaffEarningForOrder(order)
        earningAmount = Number(earning && earning.earningAmount || 0)
      } catch (e) {
        earningAmount = 0
      }
    }
    if (!earningAmount && order.payAmount) {
      earningAmount = Number(order.payAmount)
    }

    // 6. 下发订阅通知
    const results = []
    for (const sitter of targets) {
      const messageData = buildPublicOrderGrabData(order, { staffEarning: earningAmount, distanceKm: sitter.distanceKm }, { formatDateTime, now })
      const deliveryKey = makeIdempotencyKey('public_grab', order._id, sitter.profile.openid)
      const page = `pages/staff/home/index?orderId=${order._id}&from=grab_notification`

      const sendRes = await sendSubscribeMessage(
        sitter.profile.openid,
        'staffPublicOrderGrab',
        page,
        messageData,
        order._id,
        deliveryKey
      )
      results.push({ openid: sitter.profile.openid, distanceKm: sitter.distanceKm, status: sendRes && sendRes.status })
    }

    return {
      status: 'success',
      orderId: order._id,
      notifiedCount: results.length,
      recipients: results
    }
  }

  return {
    buildPublicOrderGrabData,
    checkSitterEligibilityForOrder,
    isOrderEligibleForGrab,
    notifyEligibleSittersForPublicOrder
  }
}
