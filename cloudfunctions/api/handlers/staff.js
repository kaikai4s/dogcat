const { createHash } = require('crypto')
const trainingQuizVersion = training => createHash('sha256').update(JSON.stringify([training.passScore, training.quiz])).digest('hex')
const { requireStaffGender, normalizeStaffGenderRequirement, matchesStaffGender, assertStaffGenderMatches, isStaffProfileLocked } = require('../utils/staffGender')
const { CARD_STYLE_FIELDS, validateCardStyleUpdate } = require('../utils/profileCardStyle')
const { mapRefreshIds, visibleMapRows, mapConcurrent } = require('../utils/mapCards')

module.exports = function createHandler(context) {
  const {
    saveStaffScheduleException,
    requestStaffDepositRefund,
    reserveStaffDepositPayment,
    assertPaymentModeAllowed,
    submitStaffSupplyOnce,
    DEFAULT_STAFF_TRAINING_QUIZ,
    ORDER_STATUS,
    amountYuanToFen,
    appendOrderClientMessage,
    appendOrderTimeline,
    appendPaymentEvent,
    assertOrderTransition,
    assignOrderAtomically,
    assertStaffCanAcceptOrderVaccines,
    autoAcceptDueDirectOrders,
    attachOrderDisplayData,
    buildMiniProgramPayParams,
    buildStaffAvailability,
    calcDistanceKm,
    calculateStaffEarningForOrder,
    canTakeOrders,
    checkAcceptOrderRisk,
    checkImageSecurity,
    checkRateLimit,
    checkTextSecurity,
    createPaymentNo,
    db,
    enabledTrainingVideos,
    expireDueUnacceptedOrders,
    expireUnacceptedOrder,
    findByClientRequestId,
    findStaffOrderConflict,
    formatDistance,
    formatWeeklyScheduleText,
    getClientRequestId,
    getCompletedStaffOrders,
    getOptionalUser,
    getOrderTimeRanges,
    getStaffCancellationQuote,
    cancelStaffAcceptedOrder,
    getStaffProfileByOpenid,
    getSupplyReimbursementQualification,
    getSystemSettings,
    getUser,
    getWechatPayConfig,
    readScopedDocuments,
    hasCoordinate,
    isAdminDeletedOrder,
    isOpenOrder,
    isTrainingComplete,
    makeIdempotencyKey,
    markStaffDepositPaid,
    syncWechatStaffDeposit,
    maskClientName,
    maskOrderForStaffPreview,
    maskStaffName,
    matchText,
    normalizeCityName,
    normalizeScheduleException,
    normalizeStaffDepositConfig,
    normalizeStaffSuppliesConfig,
    normalizeStaffTrainingConfig,
    normalizeStaffZhimaConfig,
    normalizeStaffWorkflow,
    normalizeVideoAuditGuide,
    normalizeWeeklySchedule,
    notifyAdmins,
    notifyOrderAccepted,
    now,
    orderMatchesCity,
    paginateList,
    publicTrainingQuiz,
    requireAdmin,
    safeFileId,
    safeText,
    sanitizeWechatPayload,
    sendUpcomingServiceRemindersToStaff,
    splitServiceAreas,
    staffDepositSatisfied,
    toPublicSitter,
    toPublicSitterDetail,
    toTimeValue,
    updateOrderWhenStatus,
    validateStaffTakeOrderAbility,
    validateStaffScheduleOnly,
    wechatPayRequest,
    withSitterUserProfile,
    batchWithSitterUserProfiles,
    isValidIdCard,
    maskIdCard,
    verifyTelecomThreeElements
  } = context
  function nearbyReference(data, profile) {
    // Explicitly absent reference coordinates must not resurrect an old GPS fix.
    const supplied = data.latitude !== undefined || data.longitude !== undefined
    const latitude = Number(supplied ? data.latitude : profile.currentLatitude)
    const longitude = Number(supplied ? data.longitude : profile.currentLongitude)
    return hasCoordinate(latitude, longitude) ? { latitude, longitude } : { latitude: 0, longitude: 0 }
  }
  async function readAll(collectionName, where = {}, maxLimit = 2000) {
    const rows = []
    let cursor = ''
    while (rows.length < maxLimit) {
      const condition = { ...where }
      if (cursor) condition._id = db.command.gt(cursor)
      const fetchLimit = Math.min(100, maxLimit - rows.length)
      const page = (await db.collection(collectionName).where(condition).orderBy('_id', 'asc').limit(fetchLimit).get()).data || []
      rows.push(...page)
      if (page.length < fetchLimit) return rows
      cursor = page[page.length - 1]._id
    }
    return rows
  }
  async function queryCandidateSitters(whereCondition = {}, maxLimit = 300) {
    const rows = []
    let cursor = ''
    while (rows.length < maxLimit) {
      const condition = { ...whereCondition }
      if (cursor) condition._id = db.command.gt(cursor)
      const fetchLimit = Math.min(100, maxLimit - rows.length)
      const page = (await db.collection('staff_profiles').where(condition).orderBy('_id', 'asc').limit(fetchLimit).get()).data || []
      rows.push(...page)
      if (page.length < fetchLimit) break
      cursor = page[page.length - 1]._id
    }
    return rows
  }
  function isStaffPreviouslyAssignedToOrder(order = {}, staffOpenid = '') {
    if (!order || !staffOpenid) return false
    const target = safeText(staffOpenid).trim()
    if (!target) return false
    if (safeText(order.originalStaffOpenid).trim() === target) return true
    if (Array.isArray(order.previousStaffRecords)) {
      return order.previousStaffRecords.some((r) => safeText(r && r.staffOpenid).trim() === target)
    }
    return false
  }
  const quizSubmitTimestamps = new Map()
  function checkQuizSubmitRateLimit(userOpenid, maxInWindow = 3, windowMs = 10 * 60 * 1000) {
    if (!userOpenid) return
    const nowTs = Date.now()
    const cutoff = nowTs - windowMs
    let userTimestamps = quizSubmitTimestamps.get(userOpenid) || []
    userTimestamps = userTimestamps.filter((t) => t >= cutoff)
    if (userTimestamps.length >= maxInWindow) {
      throw new Error('答题提交过于频繁，请稍后复习培训资料后再试（10分钟内限提交3次）')
    }
    userTimestamps.push(nowTs)
    quizSubmitTimestamps.set(userOpenid, userTimestamps)
  }

  const videoWatchedTimestamps = new Map()
  function checkVideoWatchedRateLimit(userOpenid, maxPerMinute = 10) {
    if (!userOpenid) return
    const nowTs = Date.now()
    const cutoff = nowTs - 60 * 1000
    let userTimestamps = videoWatchedTimestamps.get(userOpenid) || []
    userTimestamps = userTimestamps.filter((t) => t >= cutoff)
    if (userTimestamps.length >= maxPerMinute) {
      throw new Error('培训进度同步过于频繁，请稍后再试')
    }
    userTimestamps.push(nowTs)
    videoWatchedTimestamps.set(userOpenid, userTimestamps)
  }

  return async function staff(openid, action, data, internal = {}) {
    if (action === 'getGrabResult') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅宠托师可查询接单结果')
      await checkRateLimit(openid, 'staff.grabResult', { max: 30 })
      const id = String(data.orderId || '').trim()
      if (!id || id.length > 128) throw new Error('订单编号无效')
      const order = await require('../utils/documentPages').readOptionalDocument(db, 'orders', id)
      if (!order || order.deletedAt || order.adminDeletedAt) return { state: 'unavailable' }
      if (order.staffOpenid === openid && ['assigned', 'on_the_way', 'in_service', 'day_completed', 'completed'].includes(order.status)) return { state: 'assigned', orderId: id }
      return { state: order.status === 'paid' && !order.staffOpenid && (order.publishMode === 'open' || order.requestedStaffOpenid === openid) ? 'available' : 'unavailable' }
    }
    if (action === 'listOrderMap') {
      const refreshIds = mapRefreshIds(data.refreshIds)
      const city = String(data.city || '').trim().slice(0, 40)
      if (!city) throw new Error('请先选择城市')
      await checkRateLimit(openid, 'communityMap.orders', { max: 40 })
      const rows = await context.readMapCommunities(city)
      const orders = await staff(openid, 'listNearbyOrders', { ...data, city }, { map: true, communities: rows })
      const nodes = new Map(rows.map(row => [row._id, { ...context.publicCommunity(row), count: 0, urgentCount: 0 }]))
      const accepted = [], unknown = []
      for (const order of orders) {
        if (data.orderKind === 'urgent' && !order.isUrgent && order.assignmentSource !== 'admin_urgent_republish') continue
        if (data.orderKind === 'normal' && (order.isUrgent || order.assignmentSource === 'admin_urgent_republish')) continue
        const node = nodes.get(order.mapCommunityId)
        if (!node) { unknown.push(order); continue }
        node.count++
        if (order.isUrgent || order.assignmentSource === 'admin_urgent_republish') node.urgentCount++
        if (data.communityId === node._id) accepted.push(order)
      }
      // Map pagination must not inherit listNearbyOrders' private-distance order.
      // Service time and document ID are public-safe and provide a stable cursor.
      const compareMapOrder = (a, b) => toTimeValue(a.startTime) - toTimeValue(b.startTime) || String(a._id).localeCompare(String(b._id))
      accepted.sort(compareMapOrder)
      const page = Math.max(1, Math.floor(Number(data.page) || 1)), size = 10
      const cursor = String(data.cursor || '').slice(0, 256)
      let start = (page - 1) * size
      if (cursor) {
        const separator = cursor.lastIndexOf('|')
        if (separator < 1) throw new Error('分页参数无效，请刷新后重试')
        let cursorTime = ''
        try { cursorTime = decodeURIComponent(cursor.slice(0, separator)) } catch (_) { throw new Error('分页参数无效，请刷新后重试') }
        const cursorOrder = { startTime: cursorTime, _id: cursor.slice(separator + 1) }
        if (!cursorOrder._id) throw new Error('分页参数无效，请刷新后重试')
        start = accepted.findIndex(order => compareMapOrder(order, cursorOrder) > 0)
        if (start < 0) start = accepted.length
      }
      const pageRows = accepted.slice(start, start + size)
      const toMapOrder = order => ({
        _id: order._id, serviceSummary: order.isGroupBuyBundle ? '同小区多户照护' : order.serviceSummary || '', petSummary: order.petSummary || order.petName || '',
        startTime: order.startTime || '', endTime: order.endTime || '', sessionCount: order.sessionCount || 1,
        durationMinutes: order.durationMinutes || 0, isUrgent: !!(order.isUrgent || order.assignmentSource === 'admin_urgent_republish'),
        staffEarningText: `¥${(Number(order.staffEarning) || 0).toFixed(2)}`, isGroupBuyBundle: !!order.isGroupBuyBundle, householdCount: order.householdCount || 1,
        inRange: order.inRange, inTime: order.inTime
      })
      const list = pageRows.map(toMapOrder)
      const hasMore = start + pageRows.length < accepted.length
      const last = pageRows[pageRows.length - 1]
      return { communities: [...nodes.values()].filter(row => row.count), list, page, total: accepted.length,
        hasMore, nextCursor: hasMore && last ? `${encodeURIComponent(last.startTime || '')}|${last._id}` : '',
        unmatchedCount: unknown.length, generatedAt: now(),
        ...(refreshIds ? { visibleList: visibleMapRows(accepted, refreshIds).map(toMapOrder) } : {}) }
    }
    if (action === 'listApprovedSitters') {
      const staffGenderRequirement = normalizeStaffGenderRequirement(data.staffGenderRequirement)
      const keyword = String(data.keyword || '').trim().toLowerCase()
      const serviceCity = String(data.serviceCity || '').trim()
      const serviceArea = String(data.serviceArea || '').trim()
      const sortBy = data.sortBy || 'default'
      const userLat = Number(data.latitude || 0)
      const userLng = Number(data.longitude || 0)
      const userHasLoc = hasCoordinate(userLat, userLng)

      const page = Math.max(Number(data.page || 1), 1)
      const pageSize = Math.min(Math.max(Number(data.pageSize || 20), 1), 50)
      const settings = await getSystemSettings()

      // 1. 数据库条件下推：基础状态下推与城市下推
      const whereCondition = { auditStatus: 'approved' }
      if (staffGenderRequirement !== 'any') whereCondition.gender = staffGenderRequirement
      if (serviceCity) {
        const normFilterCity = normalizeCityName(serviceCity)
        if (normFilterCity) {
          const cityCandidates = [serviceCity, normFilterCity, `${normFilterCity}市`].filter(Boolean)
          whereCondition.serviceCity = db.command.in([...new Set(cityCandidates)])
        }
      }

      // 读取候选集（限制最大候选规模，避免全表无节制扫描）
      let rawCandidates = await queryCandidateSitters(whereCondition, 300)

      // 2. 内存初筛（城市、区域及履约资质过滤）
      rawCandidates = rawCandidates.filter((profile) => {
        if (!canTakeOrders(profile, settings.staffDeposit)) return false
        const areas = splitServiceAreas(profile.serviceAreas)
        if (serviceCity) {
          const normFilterCity = normalizeCityName(serviceCity)
          const normSitterCity = normalizeCityName(profile.serviceCity)
          if (normFilterCity && normSitterCity && normFilterCity !== normSitterCity) return false
        }
        if (serviceArea && !areas.includes(serviceArea)) return false
        return true
      })

      // 3. 关键词匹配优化：
      // 若有关键词，仅对初筛后的候选集批量装配用户信息（1次批量查询），再进行匹配；
      // 若无关键词，此时完全不需要查 users 表，留到分页截断后按需装配！
      let userEnriched = false
      if (keyword) {
        rawCandidates = await batchWithSitterUserProfiles(rawCandidates)
        userEnriched = true
        rawCandidates = rawCandidates.filter((profile) => {
          return matchText(profile.nickname, keyword) ||
                 matchText(profile.realName, keyword) ||
                 matchText(profile.serviceCity, keyword) ||
                 matchText(profile.serviceAreas, keyword)
        })
      }

      // 4. 计算距离与中间元数据
      const candidateList = rawCandidates.map((profile) => {
        const booking = context.getBookingPoint(profile)
        const hasSitterLoc = hasCoordinate(profile.serviceLatitude, profile.serviceLongitude) && Boolean(profile.serviceAddress)
        const radiusKm = Math.max(booking.radiusKm, 1)
        const distanceKm = (userHasLoc && hasSitterLoc)
          ? calcDistanceKm(userLat, userLng, booking.latitude, booking.longitude)
          : null
        const inServiceRange = !userHasLoc || (distanceKm !== null && distanceKm <= radiusKm)
        return {
          profile,
          distanceKm,
          inServiceRange,
          canDirectBook: inServiceRange && profile.acceptDirectOrders !== false && profile.publicBookingNeedsConfirmation !== true
        }
      })

      // 5. 稳定排序（带有 _id 兜底保证确定性无重复跳变）
      const compareRating = (a, b) => Number(b.profile.ratingAverage || 0) - Number(a.profile.ratingAverage || 0) || Number(b.profile.reviewCount || 0) - Number(a.profile.reviewCount || 0) || toTimeValue(b.profile.ratingUpdatedAt || b.profile.updatedAt) - toTimeValue(a.profile.ratingUpdatedAt || a.profile.updatedAt)
      const compareFeatured = (a, b) => {
        const featuredDiff = Number(b.profile.isFeatured === true) - Number(a.profile.isFeatured === true)
        if (featuredDiff) return featuredDiff
        if (a.profile.isFeatured === true && b.profile.isFeatured === true) return toTimeValue(b.profile.featuredAt) - toTimeValue(a.profile.featuredAt)
        return 0
      }
      const compareDefault = (a, b) => compareRating(a, b) || toTimeValue(b.profile.updatedAt) - toTimeValue(a.profile.updatedAt)
      const compareByMode = (a, b) => {
        if (sortBy === 'distance' && userHasLoc) return (context.getBookingPoint(a.profile).isPublic ? a.distanceKm ?? 9999 : 9999) - (context.getBookingPoint(b.profile).isPublic ? b.distanceKm ?? 9999 : 9999) || compareRating(a, b)
        if (sortBy === 'city') return String(a.profile.serviceCity || '').localeCompare(String(b.profile.serviceCity || '')) || String(a.profile.serviceAreas || '').localeCompare(String(b.profile.serviceAreas || '')) || compareRating(a, b)
        if (sortBy === 'latest') return toTimeValue(b.profile.updatedAt || b.profile.createdAt) - toTimeValue(a.profile.updatedAt || a.profile.createdAt) || compareRating(a, b)
        if (sortBy === 'rating') return compareRating(a, b)
        return compareDefault(a, b)
      }
      const compareTieBreaker = (a, b) => String(b.profile._id || '').localeCompare(String(a.profile._id || ''))

      candidateList.sort((a, b) => compareFeatured(a, b) || compareByMode(a, b) || compareTieBreaker(a, b))

      // 6. 分页截断：仅针对当前页
      const total = candidateList.length
      const start = (page - 1) * pageSize
      const pagedCandidates = candidateList.slice(start, start + pageSize)

      // 7. 当前页按需批量补充用户资料（若前面未查过，此时仅对当前页的至多 20 条发 1 次批量查询）
      let pagedProfiles = pagedCandidates.map((c) => c.profile)
      if (!userEnriched) {
        pagedProfiles = await batchWithSitterUserProfiles(pagedProfiles)
      }

      // 8. 构造公开 DTO（确保不泄漏坐标与敏感地址）
      const list = pagedCandidates.map((item, index) => {
        const fullProfile = pagedProfiles[index] || item.profile
        const publicData = toPublicSitter(fullProfile)
        if (!userHasLoc) return { ...publicData, bookingNeedsContext: true, inServiceRange: true, canDirectBook: fullProfile.acceptDirectOrders !== false && fullProfile.publicBookingNeedsConfirmation !== true }
        return {
          ...publicData,
          distanceKm: context.getBookingPoint(fullProfile).isPublic ? item.distanceKm : null,
          distanceText: context.getBookingPoint(fullProfile).isPublic ? `距小区约 ${formatDistance(item.distanceKm)}` : '',
          inServiceRange: item.inServiceRange,
          canDirectBook: item.canDirectBook,
          rangeStatusText: item.inServiceRange ? '服务范围内' : '超出服务范围'
        }
      })

      return {
        list,
        total,
        page,
        pageSize,
        hasMore: start + pageSize < total
      }
    }
    if (action === 'getPublicSitterDetail') {
      const user = await getOptionalUser(openid)
      const settings = await getSystemSettings()
      const staffProfileId = safeText(data.staffProfileId).trim()
      if (!staffProfileId) throw new Error('宠托师不可用')
      const profileRes = await db.collection('staff_profiles').doc(staffProfileId).get().catch(() => ({ data: null }))
      const profile = profileRes && profileRes.data
      if (!profile || !canTakeOrders(profile, settings.staffDeposit)) throw new Error('宠托师不可用')
      const detail = await toPublicSitterDetail(user ? openid : '', await withSitterUserProfile(normalizeStaffWorkflow(profile)))
      const booking = context.getBookingPoint(profile)

      const userLat = Number(data.latitude !== undefined ? data.latitude : (data.addressLatitude || 0))
      const userLng = Number(data.longitude !== undefined ? data.longitude : (data.addressLongitude || 0))
      const userHasLoc = hasCoordinate(userLat, userLng)
      const hasSitterLoc = hasCoordinate(profile.serviceLatitude, profile.serviceLongitude) && Boolean(profile.serviceAddress)
      const radiusKm = Math.max(booking.radiusKm, 1)

      let distanceKm = null
      let inServiceRange = true
      let canDirectBook = true
      let rangeStatusText = ''
      if (userHasLoc) {
        if (hasSitterLoc) {
          distanceKm = calcDistanceKm(userLat, userLng, booking.latitude, booking.longitude)
          inServiceRange = distanceKm !== null && distanceKm <= radiusKm
          canDirectBook = inServiceRange
          rangeStatusText = inServiceRange ? '服务范围内' : '超出服务范围'
        } else {
          inServiceRange = false
          canDirectBook = false
          rangeStatusText = '宠托师未设置有效常驻坐标'
        }
      }

      return {
        ...detail,
        distanceKm: booking.isPublic ? distanceKm : null,
        distanceText: booking.isPublic && distanceKm !== null ? `距小区约 ${formatDistance(distanceKm)}` : '',
        inServiceRange,
        canDirectBook: canDirectBook && profile.acceptDirectOrders !== false && profile.publicBookingNeedsConfirmation !== true,
        rangeStatusText
      }
    }
    if (action === 'checkSitterRange') {
      await getUser(openid)
      await checkRateLimit(openid, 'staff.checkSitterRange', { max: 30 })
      const staffProfileId = safeText(data.staffProfileId).trim()
      if (!staffProfileId) throw new Error('请选择宠托师')
      const profileRes = await db.collection('staff_profiles').doc(staffProfileId).get().catch(() => ({ data: null }))
      const profile = profileRes && profileRes.data
      if (!profile) throw new Error('宠托师档案不存在')
      const booking = context.getBookingPoint(profile)
      if (!canTakeOrders(profile, (await getSystemSettings()).staffDeposit) || profile.acceptDirectOrders === false || profile.publicBookingNeedsConfirmation === true) {
        return { ok: false, inServiceRange: false, canDirectBook: false, message: '该宠托师暂不接受指定预约' }
      }

      const userLat = Number(data.latitude !== undefined ? data.latitude : (data.addressLatitude || 0))
      const userLng = Number(data.longitude !== undefined ? data.longitude : (data.addressLongitude || 0))
      const userHasLoc = hasCoordinate(userLat, userLng)
      const hasSitterLoc = hasCoordinate(profile.serviceLatitude, profile.serviceLongitude) && Boolean(profile.serviceAddress)
      const radiusKm = Math.max(booking.radiusKm, 1)

      if (!hasSitterLoc) {
        return {
          ok: false,
          inServiceRange: false,
          canDirectBook: false,
          serviceRadiusKm: radiusKm,
          distanceKm: null,
          distanceText: '',
          message: '该宠托师尚未设置有效常驻服务地址坐标，无法指定预约'
        }
      }
      if (!userHasLoc) {
        return {
          ok: true,
          inServiceRange: true,
          canDirectBook: true,
          serviceRadiusKm: radiusKm,
          distanceKm: null,
          distanceText: '',
          message: ''
        }
      }

      const dist = calcDistanceKm(userLat, userLng, booking.latitude, booking.longitude)
      const inRange = dist !== null && dist <= radiusKm
      const distText = dist !== null ? formatDistance(dist) : ''
      return {
        ok: inRange,
        inServiceRange: inRange,
        canDirectBook: inRange,
        serviceRadiusKm: radiusKm,
        distanceKm: booking.isPublic ? dist : null,
        distanceText: booking.isPublic ? `距小区约 ${distText}` : '',
        message: inRange ? '' : `服务地址超出其设定的 ${radiusKm}km 接单范围，无法指定预约`
      }
    }
    if (action === 'favoriteSitter') {
      const user = await getUser(openid)
      const settings = await getSystemSettings()
      const staffProfileId = safeText(data.staffProfileId).trim()
      if (!staffProfileId) throw new Error('请选择宠托师')
      const profileRes = await db.collection('staff_profiles').doc(staffProfileId).get().catch(() => ({ data: null }))
      const profile = profileRes && profileRes.data
      if (!profile || !canTakeOrders(profile, settings.staffDeposit)) throw new Error('宠托师不可用')
      const existing = await db.collection('sitter_favorites').where({ openid, staffProfileId }).limit(1).get()
      if (existing.data[0]) return { staffProfileId, favorite: true }
      await db.collection('sitter_favorites').add({ data: { userId: user._id, openid, staffProfileId, createdAt: now() } })
      return { staffProfileId, favorite: true }
    }
    if (action === 'unfavoriteSitter') {
      await getUser(openid)
      const staffProfileId = safeText(data.staffProfileId).trim()
      if (!staffProfileId) return { staffProfileId: '', favorite: false }
      const existing = await db.collection('sitter_favorites').where({ openid, staffProfileId }).limit(1).get()
      if (existing.data[0]) await db.collection('sitter_favorites').doc(existing.data[0]._id).remove()
      return { staffProfileId, favorite: false }
    }
    if (action === 'listFavoriteSitters') {
      await getUser(openid)
      const settings = await getSystemSettings()
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const userLat = Number(data.latitude !== undefined ? data.latitude : (data.addressLatitude || 0))
      const userLng = Number(data.longitude !== undefined ? data.longitude : (data.addressLongitude || 0))
      const userHasLoc = hasCoordinate(userLat, userLng)

      const favorites = await db.collection('sitter_favorites').where({ openid }).orderBy('createdAt', 'desc').get()
      const list = []
      for (let i = 0; i < favorites.data.length; i += 1) {
        try {
          const profileRes = await db.collection('staff_profiles').doc(favorites.data[i].staffProfileId).get()
          if (profileRes.data && canTakeOrders(profileRes.data, settings.staffDeposit)) {
            const rawProfile = profileRes.data
            const booking = context.getBookingPoint(rawProfile)
            const profile = await withSitterUserProfile(normalizeStaffWorkflow(rawProfile))
            const detail = await toPublicSitterDetail(openid, profile)
            let distanceKm = null
            let inServiceRange = true
            if (userHasLoc && hasCoordinate(rawProfile.serviceLatitude, rawProfile.serviceLongitude)) {
              distanceKm = calcDistanceKm(userLat, userLng, booking.latitude, booking.longitude)
              const radiusKm = Math.max(booking.radiusKm, 1)
              inServiceRange = distanceKm !== null && distanceKm <= radiusKm
            }
            list.push({
              ...detail,
              distanceKm: booking.isPublic ? distanceKm : null,
              distanceText: booking.isPublic && distanceKm !== null ? `距小区约 ${formatDistance(distanceKm)}` : '',
              inServiceRange,
              canDirectBook: inServiceRange && rawProfile.acceptDirectOrders !== false && rawProfile.publicBookingNeedsConfirmation !== true,
              favorite: true
            })
          }
        } catch (error) {}
      }
      const filtered = list.filter((item) => !keyword || [item.displayName, item.serviceCity, item.serviceSummary, item.bio].some((value) => safeText(value).toLowerCase().includes(keyword)))
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(filtered, data) : filtered
    }
    if (action === 'getStaffProfile') {
      await getUser(openid)
      const res = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const synced = await syncWechatStaffDeposit(res.data[0] || null)
      const profile = normalizeStaffWorkflow(synced.profile)
      if (!profile) return null
      const settings = await getSystemSettings()
      const depositConfig = settings.staffDeposit || normalizeStaffDepositConfig()
      const zhimaConfig = normalizeStaffZhimaConfig(settings.staffZhima)
      const ability = validateStaffTakeOrderAbility(profile, depositConfig)
      const depositSatisfied = staffDepositSatisfied(profile, depositConfig)
      return {
        ...profile,
        certificationLocked: isStaffProfileLocked(profile),
        depositConfig: {
          enabled: depositConfig.enabled,
          amount: depositConfig.amount
        },
        zhimaConfig,
        canTakeOrders: ability.can,
        cannotTakeOrderReason: ability.can ? '' : ability.reason,
        cannotTakeOrderMessage: ability.can ? '' : ability.message,
        depositNotice: (!depositSatisfied && depositConfig.enabled && depositConfig.amount > 0) ? {
          needDeposit: true,
          isRepay: Boolean(profile.requireDepositRepay === true || profile.depositStatus === 'supplement_required' || profile.depositStatus === 'forfeited'),
          amount: depositConfig.amount,
          title: (profile.requireDepositRepay === true || profile.depositStatus === 'supplement_required' || profile.depositStatus === 'forfeited') ? '要求重新足额缴纳保证金' : '未缴纳履约保证金',
          reason: profile.requireDepositRepayReason || '',
          repayReason: profile.requireDepositRepayReason || '',
          message: (profile.requireDepositRepay === true || profile.depositStatus === 'supplement_required' || profile.depositStatus === 'forfeited')
            ? `平台要求重新足额缴纳履约保证金，足额缴纳后即可恢复接单资格。`
            : `平台已开启宠托师履约保证金，请先完成缴纳后再开始抢单/接单。`
        } : null
      }
    }
    if (action === 'getStaffCertificationConfig') {
      const settings = await getSystemSettings()
      const zhima = normalizeStaffZhimaConfig(settings.staffZhima)
      return {
        zhima
      }
    }
    if (action === 'getTrainingStatus') {
      await getUser(openid)
      const profile = await getStaffProfileByOpenid(openid)
      if (!profile) throw new Error('请先提交宠托师认证')
      const progress = profile.trainingVideoProgress || {}
      const settings = await getSystemSettings()
      const training = settings.staffTraining || normalizeStaffTrainingConfig()
      const completedOrders = await getCompletedStaffOrders(openid, 3)
      const videos = enabledTrainingVideos(training).map((video) => ({ ...video, watched: Boolean(progress[video.key] && progress[video.key].watched === true), watchedAt: progress[video.key] && progress[video.key].watchedAt || '' }))
      return {
        profile,
        quiz: { version: trainingQuizVersion(training), unlocked: profile.auditStatus === 'approved' && videos.every(video => video.watched), questions: profile.auditStatus === 'approved' && videos.every(video => video.watched) ? publicTrainingQuiz(training.quiz) : [], passScore: training.passScore, passed: Boolean(profile.quizPassedAt), score: Number(profile.quizScore || 0), passedAt: profile.quizPassedAt || '' },
        videos,
        videoAuditGuide: normalizeVideoAuditGuide(training.videoAuditGuide),
        supplies: settings.staffSupplies || normalizeStaffSuppliesConfig(),
        completedInternOrders: completedOrders,
        completedInternOrderCount: completedOrders.length,
        canRequestVideoAudit: profile.auditStatus === 'approved' && isTrainingComplete(profile, training) && profile.videoAuditStatus !== 'pending' && profile.videoAuditStatus !== 'approved',
        canSubmitPromotion: profile.staffLevel === 'intern' && profile.promotionStatus !== 'pending' && completedOrders.length >= 3,
        canTakeOrders: canTakeOrders(profile, settings.staffDeposit)
      }
    }
    if (action === 'submitTrainingQuiz') {
      checkQuizSubmitRateLimit(openid, 3, 10 * 60 * 1000)
      if (typeof checkRateLimit === 'function') await checkRateLimit(openid, 'staff.submitTrainingQuiz', { max: 3, windowMs: 10 * 60 * 1000, message: '答题提交过于频繁，请稍后复习培训资料后再试（10分钟内限提交3次）' })
      await getUser(openid)
      const profile = await getStaffProfileByOpenid(openid)
      if (!profile || profile.auditStatus !== 'approved') throw new Error('资料审核通过后方可参加培训答题')
      const settings = await getSystemSettings()
      const training = settings.staffTraining || normalizeStaffTrainingConfig()
      if (!enabledTrainingVideos(training).every(video => profile.trainingVideoProgress && profile.trainingVideoProgress[video.key]?.watched === true)) throw new Error('请先完成全部培训视频观看后再答题')
      const questions = training.quiz || DEFAULT_STAFF_TRAINING_QUIZ
      if (data.quizVersion && data.quizVersion !== trainingQuizVersion(training)) throw new Error('题目配置已更新，请刷新培训页后重新作答')
      const answers = data.answers || {}
      if (questions.some(item => !item.options.some(option => option.value === answers[item.id]))) throw new Error('请完成当前全部题目；如题目已更新，请刷新培训页后重新作答')
      const correct = questions.filter((item) => safeText(answers[item.id]).trim() === item.answer).length
      const score = Math.round((correct / questions.length) * 100)
      const passed = score >= training.passScore
      const time = now()
      const update = { quizScore: score, updatedAt: time }
      if (passed) {
        update.quizPassedAt = time
        update.onboardingStatus = 'quiz_passed'
      }
      await db.collection('staff_profiles').doc(profile._id).update({ data: update })
      return { score, passed, passScore: training.passScore }
    }
    if (action === 'markTrainingVideoWatched') {
      checkVideoWatchedRateLimit(openid, 10)
      if (typeof checkRateLimit === 'function') await checkRateLimit(openid, 'staff.markTrainingVideoWatched', { max: 10, windowMs: 60 * 1000, message: '培训进度同步过于频繁，请稍后再试' })
      await getUser(openid)
      const profile = await getStaffProfileByOpenid(openid)
      if (!profile || profile.auditStatus !== 'approved') throw new Error('资料审核通过后方可观看培训视频')
      const settings = await getSystemSettings()
      const training = settings.staffTraining || normalizeStaffTrainingConfig()
      const videos = enabledTrainingVideos(training)
      const videoKey = safeText(data.videoKey).trim()
      const matchedVideo = videos.find((item) => item.key === videoKey)
      if (!matchedVideo) throw new Error('培训视频不存在')

      // 全程观看防作弊校验：优先使用服务端配置时长，不完全信任前端上报
      const watchedSeconds = Number(data.watchedSeconds)
      const clientDuration = Number(data.duration)
      const serverDuration = matchedVideo.durationSeconds || 0
      const duration = serverDuration > 5 ? serverDuration : (Number.isFinite(clientDuration) ? clientDuration : 0)
      if (duration > 5) {
        if (!Number.isFinite(watchedSeconds) || watchedSeconds < duration * 0.9) {
          throw new Error('培训视频须全程完整观看，当前播放时长未达标')
        }
      }

      const progress = { ...(profile.trainingVideoProgress || {}) }
      const time = now()
      progress[videoKey] = {
        watched: true,
        watchedAt: time,
        watchedSeconds: Number.isFinite(watchedSeconds) ? watchedSeconds : null,
        duration: Number.isFinite(duration) ? duration : null
      }
      const allWatched = videos.every((video) => progress[video.key] && progress[video.key].watched === true)
      const update = { trainingVideoProgress: progress, updatedAt: time }
      if (allWatched) {
        update.trainingVideosCompletedAt = time
        update.onboardingStatus = profile.quizPassedAt ? 'videos_completed' : profile.onboardingStatus
      }
      await db.collection('staff_profiles').doc(profile._id).update({ data: update })
      return { videoKey, allWatched }
    }
    if (action === 'submitVideoAuditRequest') {
      await getUser(openid)
      const profile = await getStaffProfileByOpenid(openid)
      if (!profile || profile.auditStatus !== 'approved') throw new Error('资料审核通过后方可提交视频审核')
      if (profile.videoAuditStatus === 'pending') throw new Error('视频审核正在处理中，请勿重复提交')
      if (profile.videoAuditStatus === 'approved') throw new Error('视频审核已通过，无需重复提交')
      const settings = await getSystemSettings()
      const training = settings.staffTraining || normalizeStaffTrainingConfig()
      if (!isTrainingComplete(profile, training)) throw new Error('请先完成答题和全部培训视频')
      const time = now()
      const update = { videoAuditStatus: 'pending', videoAuditRequestedAt: time, onboardingStatus: 'video_audit_pending', videoAuditRemark: '', updatedAt: time }
      await db.collection('staff_profiles').doc(profile._id).update({ data: update })
      return { ...profile, ...update }
    }
    if (action === 'submitPromotionApplication') {
      const user = await getUser(openid)
      const profile = await getStaffProfileByOpenid(openid)
      if (!profile || profile.staffLevel !== 'intern') throw new Error('仅实习宠托师可申请晋升')
      if (profile.promotionStatus === 'pending') throw new Error('已有待审核晋升申请')
      const completedOrders = await getCompletedStaffOrders(openid, 3)
      if (completedOrders.length < 3) throw new Error('完成 3 单实习服务后才可申请晋升')
      const remark = safeText(data.remark).trim()
      if (remark.length > 500) throw new Error('申请备注不能超过 500 字')
      if (remark && typeof checkTextSecurity === 'function') {
        await checkTextSecurity(openid, remark, { scene: 1, label: '晋升申请备注' })
      }
      const time = now()
      if (typeof db.runTransaction === 'function') {
        return await db.runTransaction(async (tx) => {
          const pDocRes = await tx.collection('staff_profiles').doc(profile._id).get().catch(() => ({ data: null }))
          const pDoc = pDocRes && pDocRes.data
          if (!pDoc || pDoc.staffLevel !== 'intern') throw new Error('仅实习宠托师可申请晋升')
          if (pDoc.promotionStatus === 'pending') throw new Error('已有待审核晋升申请')
          const created = await tx.collection('staff_promotion_applications').add({
            data: {
              staffProfileId: profile._id,
              staffOpenid: openid,
              staffUserId: user._id,
              orderIds: completedOrders.map((order) => order._id),
              status: 'pending',
              staffRemark: remark,
              adminRemark: '',
              createdAt: time,
              updatedAt: time
            }
          })
          await tx.collection('staff_profiles').doc(profile._id).update({
            data: {
              promotionStatus: 'pending',
              promotionApplicationId: created._id,
              promotionAppliedAt: time,
              updatedAt: time
            }
          })
          return { applicationId: created._id, status: 'pending' }
        })
      }
      const created = await db.collection('staff_promotion_applications').add({ data: { staffProfileId: profile._id, staffOpenid: openid, staffUserId: user._id, orderIds: completedOrders.map((order) => order._id), status: 'pending', staffRemark: remark, adminRemark: '', createdAt: time, updatedAt: time } })
      await db.collection('staff_profiles').doc(profile._id).update({ data: { promotionStatus: 'pending', promotionApplicationId: created._id, promotionAppliedAt: time, updatedAt: time } })
      return { applicationId: created._id, status: 'pending' }
    }
    if (action === 'cancelStaffProfileApplication') {
      const existing = await db.collection('staff_profiles').where({ openid }).limit(1).get().catch(() => ({ data: [] }))
      const profile = existing.data[0]
      if (!profile) return { success: true }
      if (!['pending', 'rejected'].includes(profile.auditStatus)) throw new Error('当前状态不可取消申请')
      await db.collection('staff_profiles').doc(profile._id).remove()
      const identityRes = await db.collection('staff_identity_verifications').where({ staffProfileId: profile._id }).limit(20).get().catch(() => ({ data: [] }))
      for (const item of identityRes.data || []) {
        if (item && item._id) await db.collection('staff_identity_verifications').doc(item._id).remove().catch(() => {})
      }
      return { success: true }
    }
    if (action === 'submitStaffProfile') {
      const user = await getUser(openid)
      if (typeof checkRateLimit === 'function') {
        await checkRateLimit(openid, 'staff.submitStaffProfile', {
          max: 5,
          windowMs: 10 * 60 * 1000,
          message: '实名认证提交过于频繁，请核对信息并在10分钟后再试（10分钟内限提交5次）'
        })
      }
      const existing = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const existingProfile = existing.data[0] || null
      const userHasStaffRole = Array.isArray(user.roles) && user.roles.includes('staff')
      const canReapplyAfterRoleRemoval = existingProfile && !userHasStaffRole && existingProfile.auditStatus === 'approved'
      if (isStaffProfileLocked(existingProfile) && !canReapplyAfterRoleRemoval) throw new Error('认证资料已锁定，如需更正请联系平台审核')
      const gender = requireStaffGender(data.gender)
      const realName = safeText(data.realName).trim()
      const phone = safeText(data.phone || user.phone).trim()
      const rawIdCard = safeText(data.idCardNumber || data.idcard || data.idCard).trim().toUpperCase()
      const idCardNumber = rawIdCard || (existingProfile ? existingProfile.idCardNumber : '')
      const serviceCity = safeText(data.serviceCity).trim()
      const serviceAreas = safeText(data.serviceAreas).trim()
      const serviceAddress = safeText(data.serviceAddress).trim()
      const serviceLatitude = Number(data.latitude || data.serviceLatitude || 0)
      const serviceLongitude = Number(data.longitude || data.serviceLongitude || 0)
      const serviceRadiusKm = Math.max(Number(data.serviceRadiusKm || 5), 1)
      const idCardFrontFileId = safeFileId(data.idCardFrontFileId)
      const idCardBackFileId = safeFileId(data.idCardBackFileId)
      const facePhotoFileId = safeFileId(data.facePhotoFileId)

      const settings = await getSystemSettings({ includeSecrets: true })
      const apiKey = settings.juheTelecomKey || process.env.JUHE_TELECOM_KEY || ''
      const isRealProductionMode = Boolean(apiKey && apiKey !== 'MOCK' && apiKey !== 'TEST')

      if (!realName) throw new Error('请输入真实姓名')
      if (!phone) throw new Error('请输入手机号')
      if (!idCardNumber && isRealProductionMode) {
        throw new Error('请输入身份证号码')
      }
      if (idCardNumber && typeof isValidIdCard === 'function' && !isValidIdCard(idCardNumber)) {
        throw new Error('身份证号码格式不正确，请输入有效的18位居民身份证号码')
      }
      if (!serviceAddress || !hasCoordinate(serviceLatitude, serviceLongitude)) {
        throw new Error('宠托师认证必须设置固定服务地址及坐标')
      }
      if (!idCardFrontFileId || !idCardBackFileId) throw new Error('请上传身份证正反面照片')
      if (!facePhotoFileId) throw new Error('请上传自拍/人脸照片')

      const time = now()

      const zhimaConfig = normalizeStaffZhimaConfig(settings.staffZhima)
      const hasZhimaInput = data.zhimaScore !== undefined || data.zhimaScoreFileId !== undefined || data.alipayProfileFileId !== undefined
      let zhimaCredit = null

      if (zhimaConfig.enabled || hasZhimaInput) {
        const rawScore = Number(data.zhimaScore)
        if (!Number.isFinite(rawScore) || rawScore < 350 || rawScore > 950) {
          throw new Error('请输入有效的支付宝芝麻信用分（350-950分）')
        }
        const zhimaScore = Math.round(rawScore)
        if (zhimaConfig.enabled && zhimaScore < zhimaConfig.minScore) {
          throw new Error(`支付宝芝麻信用分未达到平台准入要求（最低需要 ${zhimaConfig.minScore} 分）`)
        }
        const zhimaScoreFileId = safeFileId(data.zhimaScoreFileId)
        if (!zhimaScoreFileId) {
          throw new Error('请上传支付宝芝麻信用分截图')
        }
        const alipayProfileFileId = safeFileId(data.alipayProfileFileId)
        if (!alipayProfileFileId) {
          throw new Error('请上传支付宝个人主页截图')
        }
        zhimaCredit = {
          score: zhimaScore,
          scoreFileId: zhimaScoreFileId,
          profileFileId: alipayProfileFileId,
          minScoreSnapshot: zhimaConfig.minScore,
          submittedAt: time
        }
      }

      // 三要素实名核验（复用已核验成功结果防重复扣费，或发起在线/测试核验）
      let realNameVerifyStatus = 'unverified'
      let realNameVerifiedAt = null
      let realNameVerifyProvider = 'juhe_telecom'
      let realNameVerifyResCode = ''
      let realNameVerifyOrderId = ''

      const isSameIdentity = existingProfile &&
        existingProfile.realNameVerifyStatus === 'verified' &&
        existingProfile.realName === realName &&
        existingProfile.idCardNumber === idCardNumber &&
        existingProfile.phone === phone

      if (isSameIdentity) {
        realNameVerifyStatus = existingProfile.realNameVerifyStatus
        realNameVerifiedAt = existingProfile.realNameVerifiedAt
        realNameVerifyProvider = existingProfile.realNameVerifyProvider || 'juhe_telecom'
        realNameVerifyResCode = existingProfile.realNameVerifyResCode || '11'
        realNameVerifyOrderId = existingProfile.realNameVerifyOrderId || ''
      } else if (idCardNumber && typeof verifyTelecomThreeElements === 'function') {
        const verifyResult = await verifyTelecomThreeElements({
          realname: realName,
          idcard: idCardNumber,
          mobile: phone,
          apiKey
        })
        if (!verifyResult.verified) {
          throw new Error(verifyResult.message || '三要素实名核验未通过，请核对姓名、身份证及手机号开卡实名')
        }
        realNameVerifyStatus = 'verified'
        realNameVerifiedAt = verifyResult.verifiedAt || time
        realNameVerifyResCode = verifyResult.resCode || '11'
        realNameVerifyOrderId = verifyResult.orderId || ''
      }

      const staffText = [realName, serviceCity, serviceAreas, serviceAddress, data.publicServiceAddress, data.bio, data.intro, data.experience].filter(Boolean).join(' ')
      if (staffText) {
        await checkTextSecurity(openid, staffText, { scene: 1, label: '认证资料' })
      }

      const idCardMasked = typeof maskIdCard === 'function' ? maskIdCard(idCardNumber) : idCardNumber

      const identitySummary = {
        idCardNumber,
        idCardMasked,
        realNameVerifyStatus,
        realNameVerifiedAt,
        realNameVerifyProvider,
        realNameVerifyResCode,
        realNameVerifyOrderId,
        idCardFrontFileId,
        idCardBackFileId,
        facePhotoFileId,
        zhimaScore: zhimaCredit ? zhimaCredit.score : (existingProfile ? (existingProfile.zhimaScore ?? null) : null),
        zhimaScoreFileId: zhimaCredit ? zhimaCredit.scoreFileId : (existingProfile ? (existingProfile.zhimaScoreFileId ?? '') : ''),
        alipayProfileFileId: zhimaCredit ? zhimaCredit.profileFileId : (existingProfile ? (existingProfile.alipayProfileFileId ?? '') : ''),
        zhimaCredit: zhimaCredit || (existingProfile ? (existingProfile.zhimaCredit ?? null) : null),
        identityStatus: 'pending',
        faceVerifyStatus: 'manual_pending',
        faceVerifyProvider: '',
        faceVerifyRequestId: ''
      }
      const isReapplicationAfterRemoval = existingProfile && (existingProfile.auditStatus === 'revoked' || canReapplyAfterRoleRemoval)
      const depositReset = isReapplicationAfterRemoval ? {
        depositStatus: 'unpaid',
        depositPaidAt: null,
        depositPaidAmount: 0,
        requireDepositRepay: true,
        requireDepositRepayReason: '重新申请宠托师需重新缴纳履约保证金'
      } : {}

      const profile = {
        userId: user._id,
        openid,
        realName,
        gender,
        phone,
        idCardNumber,
        idCardMasked,
        realNameVerifyStatus,
        realNameVerifiedAt,
        realNameVerifyProvider,
        realNameVerifyResCode,
        realNameVerifyOrderId,
        avatarUrl: user.avatarUrl || data.avatarUrl || '',
        serviceCity,
        serviceAreas,
        serviceAddress,
        publicServiceAddress: safeText(data.publicServiceAddress || '').trim(),
        serviceLatitude,
        serviceLongitude,
        serviceRadiusKm,
        weeklySchedule: normalizeWeeklySchedule(data.weeklySchedule),
        idCardFrontFileId,
        idCardBackFileId,
        facePhotoFileId,
        zhimaScore: identitySummary.zhimaScore,
        zhimaScoreFileId: identitySummary.zhimaScoreFileId,
        alipayProfileFileId: identitySummary.alipayProfileFileId,
        zhimaCredit: identitySummary.zhimaCredit,
        identityStatus: identitySummary.identityStatus,
        faceVerifyStatus: identitySummary.faceVerifyStatus,
        faceVerifyProvider: identitySummary.faceVerifyProvider,
        faceVerifyRequestId: identitySummary.faceVerifyRequestId,
        auditStatus: 'pending',
        auditRemark: '',
        certificationLockedAt: null,
        staffLevel: 'applicant',
        onboardingStatus: 'application_pending',
        videoAuditStatus: 'not_started',
        promotionStatus: 'none',
        quizPassedAt: null,
        quizScore: 0,
        trainingVideoProgress: {},
        trainingVideosCompletedAt: null,
        videoAuditRequestedAt: null,
        videoAuditRemark: '',
        internStartedAt: null,
        internCompletedOrderCount: 0,
        promotionApplicationId: '',
        promotionAppliedAt: null,
        ...depositReset,
        updatedAt: time
      }

      async function notifyStaffApplicationSubmitted(staffProfileId, isUpdate) {
        if (typeof notifyAdmins !== 'function') return
        const title = isUpdate ? '宠托师重新提交入驻申请' : '新的宠托师入驻申请'
        await notifyAdmins({
          type: 'staff_application_submitted',
          title,
          content: `${realName || '用户'} 提交了宠托师入驻申请，请及时审核。`,
          level: 'warning',
          actionUrl: '/pages/admin/staff-audit/list/index',
          extra: { staffProfileId, openid, realName, phone, auditStatus: 'pending' },
          idempotencyKey: `staff_application_submitted:${staffProfileId}:${time}`
        }).catch(() => {})
      }

      if (existing.data[0]) {
        await db.runTransaction(async (tx) => {
          const current = (await tx.collection('staff_profiles').doc(existing.data[0]._id).get()).data
          const canUpdateRemovedStaffProfile = current && !userHasStaffRole && current.auditStatus === 'approved'
          if (isStaffProfileLocked(current) && !canUpdateRemovedStaffProfile) throw new Error('认证资料已锁定，如需更正请联系平台审核')
          await tx.collection('staff_profiles').doc(existing.data[0]._id).update({ data: profile })
        })
        const identityPayload = { staffProfileId: existing.data[0]._id, userId: user._id, openid, realName, gender, phone, idCardNumber, idCardMasked, realNameVerifyStatus, ...identitySummary, auditStatus: 'pending', updatedAt: time }
        const identityRes = await db.collection('staff_identity_verifications').where({ staffProfileId: existing.data[0]._id }).limit(1).get()
        if (identityRes.data[0]) await db.collection('staff_identity_verifications').doc(identityRes.data[0]._id).update({ data: identityPayload })
        else await db.collection('staff_identity_verifications').add({ data: { ...identityPayload, createdAt: time } })
        await notifyStaffApplicationSubmitted(existing.data[0]._id, true)
        return { _id: existing.data[0]._id, ...profile }
      }
      const created = await db.collection('staff_profiles').add({ data: { ...profile, createdAt: time } })
      await db.collection('staff_identity_verifications').add({ data: { staffProfileId: created._id, userId: user._id, openid, realName, gender, phone, idCardNumber, idCardMasked, realNameVerifyStatus, ...identitySummary, auditStatus: 'pending', createdAt: time, updatedAt: time } })
      await notifyStaffApplicationSubmitted(created._id, false)
      return { _id: created._id, ...profile, createdAt: time }
    }
    if (action === 'updateStaffProfileConfig') {
      const protectedFields = ['auditStatus', 'staffLevel', 'quizPassedAt', 'videoAuditStatus', 'verifiedServiceTags', 'verificationItems', 'completedOrderCount', 'internCompletedOrderCount', 'promotionStatus']
      if (protectedFields.some((key) => data[key] !== undefined)) throw new Error('审核、服务记录与转正信息不可自行修改')
      const existing = await db.collection('staff_profiles').where({ openid }).limit(1).get().catch(() => ({ data: [] }))
      const profile = existing && existing.data && existing.data[0]
      if (!profile) throw new Error('请先提交宠托师认证')
      if (profile.auditStatus !== 'approved' && profile.auditStatus !== 'intern' && profile.videoAuditStatus !== 'approved') {
        throw new Error('宠托师认证审核通过后方可设置接单配置')
      }
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅宠托师可更新接单配置')
      const identityFields = ['gender', 'realName', 'phone', 'idCardNumber', 'idCardFrontFileId', 'idCardBackFileId', 'facePhotoFileId', 'serviceCity', 'serviceAreas']
      if (identityFields.some((key) => data[key] !== undefined && data[key] !== profile[key])) {
        throw new Error('认证资料已锁定，如需更正请联系平台审核')
      }

      const time = now()
      const updateData = { updatedAt: time, ...validateCardStyleUpdate(data) }
      if (data.acceptDirectOrders !== undefined) {
        updateData.acceptDirectOrders = Boolean(data.acceptDirectOrders)
      }
      if (data.rejectUnvaccinatedPets !== undefined) {
        updateData.rejectUnvaccinatedPets = Boolean(data.rejectUnvaccinatedPets)
      }
      const hasProfileDisplayUpdate = data.profileBackgroundFileId !== undefined || data.profileIntro !== undefined || data.careProfile !== undefined || CARD_STYLE_FIELDS.some((key) => data[key] !== undefined)

      // 判断是否只更新 weeklySchedule（从排班日历调用）
      const isOnlyWeeklyScheduleUpdate = data.weeklySchedule !== undefined &&
                                          data.serviceAddress === undefined &&
                                          data.serviceLatitude === undefined &&
                                          data.serviceLongitude === undefined &&
                                          data.serviceRadiusKm === undefined &&
                                          data.publicServiceAddress === undefined &&
                                          data.bookableUntilDate === undefined &&
                                          !hasProfileDisplayUpdate

      if (isOnlyWeeklyScheduleUpdate) {
        // 只更新按周服务时间规则
        const weeklySchedule = normalizeWeeklySchedule(data.weeklySchedule)
        updateData.weeklySchedule = weeklySchedule
      } else {
        // 完整更新（从个人中心调用）
        const serviceAddress = safeText(data.serviceAddress !== undefined ? data.serviceAddress : profile.serviceAddress).trim()
        let serviceLatitude = Number(data.serviceLatitude !== undefined ? data.serviceLatitude : (data.latitude !== undefined ? data.latitude : (profile.serviceLatitude || 0)))
        let serviceLongitude = Number(data.serviceLongitude !== undefined ? data.serviceLongitude : (data.longitude !== undefined ? data.longitude : (profile.serviceLongitude || 0)))
        if (!hasCoordinate(serviceLatitude, serviceLongitude) && hasCoordinate(profile.serviceLatitude, profile.serviceLongitude)) {
          serviceLatitude = Number(profile.serviceLatitude)
          serviceLongitude = Number(profile.serviceLongitude)
        }
        const serviceRadiusKm = Math.max(Number(data.serviceRadiusKm !== undefined ? data.serviceRadiusKm : (profile.serviceRadiusKm || 5)), 1)
        const weeklySchedule = data.weeklySchedule !== undefined ? normalizeWeeklySchedule(data.weeklySchedule) : profile.weeklySchedule
        const publicServiceAddress = safeText(data.publicServiceAddress !== undefined ? data.publicServiceAddress : (profile.publicServiceAddress || '')).trim()
        if (publicServiceAddress && publicServiceAddress !== (profile.publicServiceAddress || '') && typeof checkTextSecurity === 'function') {
          await checkTextSecurity(openid, publicServiceAddress, { scene: 1, label: '公开服务地址' })
        }

        if (!serviceAddress || !hasCoordinate(serviceLatitude, serviceLongitude)) {
          throw new Error('请选择有效的固定服务地址及坐标')
        }

        updateData.serviceAddress = serviceAddress
        updateData.publicServiceAddress = publicServiceAddress
        updateData.serviceLatitude = serviceLatitude
        updateData.serviceLongitude = serviceLongitude
        updateData.serviceRadiusKm = serviceRadiusKm
        updateData.weeklySchedule = weeklySchedule
      }

      if (profile.publicBookingPolicyVersion === 1 && ['serviceAddress', 'serviceLatitude', 'serviceLongitude', 'serviceRadiusKm'].some(key => updateData[key] !== undefined && updateData[key] !== profile[key])) {
        updateData.publicMapEnabled = false
        updateData.publicBookingNeedsConfirmation = true
      }

      if (data.bookableUntilDate !== undefined) {
        const untilDate = safeText(data.bookableUntilDate).trim()
        if (untilDate && !/^\d{4}-\d{2}-\d{2}$/.test(untilDate)) {
          throw new Error('请选择有效的截止日期')
        }
        updateData.bookableUntilDate = untilDate
      }

      if (data.profileBackgroundFileId !== undefined) {
        const bgId = safeFileId(data.profileBackgroundFileId)
        if (bgId && bgId !== profile.profileBackgroundFileId && typeof checkImageSecurity === 'function') {
          await checkImageSecurity(openid, bgId, { scene: 1, label: '宠托师主页背景图' })
        }
        updateData.profileBackgroundFileId = bgId
      }
      if (data.profileIntro !== undefined) {
        const profileIntro = safeText(data.profileIntro).trim().slice(0, 60)
        if (profileIntro) await checkTextSecurity(openid, profileIntro, { scene: 1, label: '宠托师主页介绍' })
        updateData.profileIntro = profileIntro
      }
      if (data.careProfile !== undefined) {
        updateData.careProfile = data.careProfile
      }

      await db.collection('staff_profiles').doc(profile._id).update({ data: updateData })
      return { _id: profile._id, ...profile, ...updateData }
    }
    if (action === 'updateCurrentLocation') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可更新定位')
      const latitude = Number(data.latitude || 0)
      const longitude = Number(data.longitude || 0)
      if (!hasCoordinate(latitude, longitude)) throw new Error('定位信息无效')
      const existing = await db.collection('staff_profiles').where({ openid }).limit(1).get().catch(() => ({ data: [] }))
      const profile = existing && existing.data && existing.data[0]
      if (!profile) throw new Error('请先提交员工认证')
      const location = { currentLatitude: latitude, currentLongitude: longitude, locationAccuracy: Number(data.accuracy || 0), locationUpdatedAt: now(), updatedAt: now() }
      await db.collection('staff_profiles').doc(profile._id).update({ data: location })
      return { _id: profile._id, ...location }
    }
    if (action === 'listNearbyOrders' || action === 'listAvailableOrders') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可查看')

      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = normalizeStaffWorkflow(profileRes.data[0] || {})
      const settings = await getSystemSettings()
      const ability = validateStaffTakeOrderAbility(profile, settings.staffDeposit)
      if (!ability.can) throw new Error(ability.message || '完成培训和视频审核成为实习宠托师后方可查看可接订单')
      const { latitude, longitude } = nearbyReference(data, profile)

      const filterCity = data.city ? String(data.city).trim() : ''
      const inServiceRange = Boolean(data.inServiceRange)
      const inServiceTime = Boolean(data.inServiceTime)
      const filterDate = data.filterDate ? String(data.filterDate).trim() : ''
      await expireDueUnacceptedOrders()

      const openWhere = {
        status: 'paid',
        publishMode: 'open'
      }
      if (internal.map) {
        // Map mode shares the same pool/bundle logic for normal and urgent tasks.
      } else if (db.command && typeof db.command.neq === 'function') {
        openWhere.isUrgent = db.command.neq(true)
      } else {
        openWhere.isUrgent = false
      }
      const availableOrders = (await readAll('orders', openWhere, internal.map ? 2001 : 2000)).sort((a, b) => toTimeValue(a.startTime) - toTimeValue(b.startTime))
      if (internal.map && availableOrders.length > 2000) throw new Error('待接任务过多，请使用列表查看；地图未截断统计')
      const radiusKm = Math.max(Number(profile.serviceRadiusKm || 5), 1)

      function isOrderInRange(order) {
        return order.distanceKm !== null && order.distanceKm <= radiusKm
      }

      async function isOrderInTime(order, exceptions) {
        const sessions = getOrderTimeRanges(order)
        if (!sessions.length) return false
        try {
          for (const session of sessions) {
            await validateStaffScheduleOnly(profile, session.startTime, session.endTime, { exceptions })
          }
          return true
        } catch (error) {
          return false
        }
      }

      const groupBuyCounts = new Map()
      for (const order of availableOrders) {
        if (order.groupBuyId && !order.deletedAt && !isAdminDeletedOrder(order) && !order.groupBuyRefundRequired && order.paymentStatus === 'paid') {
          groupBuyCounts.set(order.groupBuyId, (groupBuyCounts.get(order.groupBuyId) || 0) + 1)
        }
      }
      let candidates = availableOrders.filter((order) => (!order.groupBuyId || order.groupBuyStatus === 'formed' && order.paymentStatus === 'paid' && !order.groupBuyRefundRequired) && !order.deletedAt && matchesStaffGender(order, profile) && !isAdminDeletedOrder(order) && isOpenOrder(order) && (internal.map || !order.isUrgent && order.assignmentSource !== 'admin_urgent_republish') && !isStaffPreviouslyAssignedToOrder(order, profile.openid) && !(Array.isArray(order.cancelledStaffOpenids) && order.cancelledStaffOpenids.includes(profile.openid)))
      if (filterDate) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(filterDate)) throw new Error('请选择有效日期')
        const start = toTimeValue(`${filterDate} 00:00`), end = start + 86400000
        // Retain complete bundles; single tasks can be filtered before expensive enrichment.
        candidates = candidates.filter(order => order.groupBuyId || getOrderTimeRanges(order).some(range => toTimeValue(range.startTime) < end && toTimeValue(range.endTime) > start))
      }
      if (filterCity) {
        candidates = candidates.filter((order) => orderMatchesCity(order, filterCity))
      }

      const scheduleExceptions = candidates.length
        ? await readAll('staff_schedule_exceptions', { staffOpenid: openid })
        : []
      const mapCommunities = internal.map ? internal.communities || await context.readMapCommunities(filterCity) : []
      const matchCommunity = internal.map ? context.createCommunityMatcher(mapCommunities).match : null
      const enrichCandidate = async (order) => {
        const enriched = await attachOrderDisplayData(order)
        let distanceKm = null
        if (hasCoordinate(latitude, longitude) && hasCoordinate(enriched.addressLatitude, enriched.addressLongitude)) {
          distanceKm = calcDistanceKm(latitude, longitude, enriched.addressLatitude, enriched.addressLongitude)
        }
        // 【新增】添加收益信息
        const earning = await calculateStaffEarningForOrder(enriched)
        const result = {
          ...enriched,
          distanceKm,
          distanceText: formatDistance(distanceKm),
          staffEarning: earning.earningAmount,
          staffEarningText: `¥${earning.earningAmount.toFixed(2)}`
        }
        if (internal.map) {
          const community = matchCommunity(enriched)
          result.mapCommunityId = community ? community._id : ''
        }
        if (order.groupBuyId) {
          result.isGroupBuy = true
        }
        result.inRange = isOrderInRange(result)
        result.inTime = await isOrderInTime(result, scheduleExceptions)
        return result
      }
      let orders = internal.map ? await mapConcurrent(candidates, enrichCandidate) : await Promise.all(candidates.map(enrichCandidate))

      // 3. 服务范围与时间筛选需在分页前执行，避免当前页被前端过滤后为空
      if (inServiceRange) orders = orders.filter((order) => order.inRange)
      if (inServiceTime) orders = orders.filter((order) => order.inTime)
      if (profile.rejectUnvaccinatedPets === true) orders = orders.filter((order) => !order.hasUnvaccinatedPets)

      // 4. 聚合同小区拼单任务包：严禁将拼单子订单零散独立展示在抢单大厅，统一整合成一个拼单任务包
      const regularOrders = []
      const bundleMap = new Map()
      for (const order of orders) {
        if (order.groupBuyId) {
          if (!bundleMap.has(order.groupBuyId)) {
            bundleMap.set(order.groupBuyId, [])
          }
          bundleMap.get(order.groupBuyId).push(order)
        } else {
          regularOrders.push(order)
        }
      }

      const bundleOrders = []
      for (const [groupBuyId, bundleList] of bundleMap) {
        // Every household must pass the selected filters. A partial package
        // would understate both its service workload and total earnings.
        if (bundleList.length !== groupBuyCounts.get(groupBuyId)) continue
        const primary = bundleList[0]
        const householdCount = bundleList.length
        const totalEarning = bundleList.reduce((sum, item) => sum + (Number(item.staffEarning) || 0), 0)
        const subOrders = bundleList.map((item, idx) => ({
          orderId: item._id,
          householdIndex: idx + 1,
          householdLabel: `住户 ${idx + 1}`,
          petName: item.petName || (item.petSnapshot && item.petSnapshot.name) || '宠物',
          petSummary: item.petSummary || '',
          serviceType: item.serviceType || 'feed',
          serviceSummary: item.serviceSummary || '',
          startTime: item.startTime || '',
          endTime: item.endTime || '',
          staffEarning: Number(item.staffEarning) || 0,
          staffEarningText: `¥${(Number(item.staffEarning) || 0).toFixed(2)}`
        }))
        const allPets = bundleList.map((item) => item.petName || '宠物').filter(Boolean).join('、')
        const aggregated = {
          ...primary,
          ...(internal.map ? { mapCommunityId: bundleList.every(item => item.mapCommunityId === primary.mapCommunityId) ? primary.mapCommunityId : '',
            isUrgent: bundleList.some(item => item.isUrgent || item.assignmentSource === 'admin_urgent_republish') } : {}),
          isGroupBuy: true,
          isGroupBuyBundle: true,
          groupBuyId,
          householdCount,
          subOrders,
          subOrderIds: bundleList.map((item) => item._id),
          groupBuyBadge: `🏡 同小区顺路拼单 (共${householdCount}户)`,
          serviceSummary: `同小区顺路拼单 (共${householdCount}户：${allPets})`,
          petSummary: `共${householdCount}户宠物：${allPets}`,
          staffEarning: totalEarning,
          staffEarningText: `¥${totalEarning.toFixed(2)} (共${householdCount}户合计收益)`,
          inRange: bundleList.every((item) => item.inRange),
          inTime: bundleList.every((item) => item.inTime)
        }
        bundleOrders.push(aggregated)
      }

      let displayedOrders = [...regularOrders, ...bundleOrders]
      if (filterDate) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(filterDate)) throw new Error('请选择有效日期')
        const dayStart = toTimeValue(`${filterDate} 00:00`), dayEnd = dayStart + 86400000
        const matchesDate = order => getOrderTimeRanges(order).some(range => toTimeValue(range.startTime) < dayEnd && toTimeValue(range.endTime) > dayStart)
        displayedOrders = displayedOrders.filter(order => order.isGroupBuyBundle
          ? bundleMap.get(order.groupBuyId).some(matchesDate) : matchesDate(order))
      }
      const sortedOrders = displayedOrders.sort((a, b) => (a.distanceKm === null ? 999999 : a.distanceKm) - (b.distanceKm === null ? 999999 : b.distanceKm))
      const maskedOrders = sortedOrders.map(maskOrderForStaffPreview)
      if (internal.map) return maskedOrders
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(maskedOrders, data) : maskedOrders.slice(0, 20)
    }
    if (action === 'listDirectOrders') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可查看')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = normalizeStaffWorkflow(profileRes.data[0] || {})
      const settings = await getSystemSettings()
      const ability = validateStaffTakeOrderAbility(profile, settings.staffDeposit)
      if (!ability.can) throw new Error(ability.message || '完成培训和视频审核成为实习宠托师后方可查看指定订单')
      const { latitude, longitude } = nearbyReference(data, profile)
      await expireDueUnacceptedOrders()
      if (typeof autoAcceptDueDirectOrders === 'function') await autoAcceptDueDirectOrders()
      const directCandidates = await readAll('orders', { status: 'paid', requestedStaffOpenid: openid })
      const directOrders = await Promise.all(directCandidates
        .sort((a, b) => toTimeValue(a.startTime) - toTimeValue(b.startTime))
        .filter((order) => matchesStaffGender(order, profile) && !isAdminDeletedOrder(order) && order.publishMode === 'direct' && !order.staffOpenid && order.requestedStaffOpenid === openid)
        .map(async (order) => {
          const enriched = await attachOrderDisplayData(order)
          let distanceKm = null
          if (hasCoordinate(latitude, longitude) && hasCoordinate(enriched.addressLatitude, enriched.addressLongitude)) {
            distanceKm = calcDistanceKm(latitude, longitude, enriched.addressLatitude, enriched.addressLongitude)
          }
          return { ...enriched, distanceKm, distanceText: formatDistance(distanceKm) }
        }))
      const visibleDirectOrders = profile.rejectUnvaccinatedPets === true ? directOrders.filter((order) => !order.hasUnvaccinatedPets) : directOrders
      const maskedDirectOrders = visibleDirectOrders.map(maskOrderForStaffPreview)
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(maskedDirectOrders, data) : maskedDirectOrders
    }
    if (action === 'listUrgentOrders') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可查看')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = normalizeStaffWorkflow(profileRes.data[0] || {})
      const settings = await getSystemSettings()
      const ability = validateStaffTakeOrderAbility(profile, settings.staffDeposit)
      if (!ability.can) throw new Error(ability.message || '完成培训和视频审核成为实习宠托师后方可查看加急订单')
      const { latitude, longitude } = nearbyReference(data, profile)
      await expireDueUnacceptedOrders()

      // 仅检索标记为加急或后台转加急重派的待接订单，避免对全平台所有普通 paid 订单做全表扫描
      const [urgentFlaggedOrders, urgentRepublishedOrders] = await Promise.all([
        readAll('orders', { status: 'paid', isUrgent: true }),
        readAll('orders', { status: 'paid', assignmentSource: 'admin_urgent_republish' })
      ])
      const urgentCandidateMap = new Map()
      for (const order of urgentFlaggedOrders) {
        urgentCandidateMap.set(order._id, order)
      }
      for (const order of urgentRepublishedOrders) {
        urgentCandidateMap.set(order._id, order)
      }
      const rawUrgentOrders = Array.from(urgentCandidateMap.values())

      const urgentOrders = await Promise.all(rawUrgentOrders
        .sort((a, b) => toTimeValue(a.startTime) - toTimeValue(b.startTime))
        .filter((order) => matchesStaffGender(order, profile) && !isAdminDeletedOrder(order) && (order.isUrgent === true || order.assignmentSource === 'admin_urgent_republish') && !order.staffOpenid && !isStaffPreviouslyAssignedToOrder(order, profile.openid) && !(Array.isArray(order.cancelledStaffOpenids) && order.cancelledStaffOpenids.includes(profile.openid)))
        .map(async (order) => {
          const enriched = await attachOrderDisplayData(order)
          let distanceKm = null
          if (hasCoordinate(latitude, longitude) && hasCoordinate(enriched.addressLatitude, enriched.addressLongitude)) {
            distanceKm = calcDistanceKm(latitude, longitude, enriched.addressLatitude, enriched.addressLongitude)
          }
          const earning = await calculateStaffEarningForOrder(enriched)
          return {
            ...enriched,
            distanceKm,
            distanceText: formatDistance(distanceKm),
            isUrgent: true,
            urgentStaffReward: order.urgentStaffReward || earning.earningAmount,
            urgentBonus: order.urgentBonus || 0,
            urgentRemark: order.urgentRemark || '',
            staffEarning: earning.earningAmount,
            staffEarningText: `¥${Number(earning.earningAmount).toFixed(2)}`
          }
        }))
      const visibleUrgentOrders = profile.rejectUnvaccinatedPets === true ? urgentOrders.filter((order) => !order.hasUnvaccinatedPets) : urgentOrders
      const sorted = visibleUrgentOrders.sort((a, b) => (a.distanceKm === null ? 999999 : a.distanceKm) - (b.distanceKm === null ? 999999 : b.distanceKm))
      const maskedUrgentOrders = sorted.map(maskOrderForStaffPreview)
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(maskedUrgentOrders, data) : maskedUrgentOrders
    }
    if (action === 'getScheduleCalendar') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可查看')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = profileRes.data[0]
      if (!profile) throw new Error('请先提交宠托师认证')
      const availability = await buildStaffAvailability(profile, data.startDate || data.dateKey || '', data.days || 31)
      return {
        weeklySchedule: normalizeWeeklySchedule(profile.weeklySchedule),
        weeklyScheduleText: formatWeeklyScheduleText(profile.weeklySchedule),
        bookableUntilDate: safeText(profile.bookableUntilDate).trim(),
        availability
      }
    }
    if (action === 'saveScheduleException') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可设置排班')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = profileRes.data[0]
      if (!profile || profile.auditStatus !== 'approved') throw new Error('宠托师认证审核通过后方可设置排班')
      const payload = normalizeScheduleException(data, profile)
      return saveStaffScheduleException(user, payload)
    }
    if (action === 'deleteScheduleException') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可设置排班')
      const dateKey = safeText(data.dateKey).trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error('请选择有效日期')
      return saveStaffScheduleException(user, { dateKey }, true)
    }
    if (action === 'listScheduleAvailability') {
      const profileId = safeText(data.staffProfileId || data.requestedStaffProfileId).trim()
      let profile = null
      if (profileId) {
        const profileRes = await db.collection('staff_profiles').doc(profileId).get().catch(() => ({ data: null }))
        profile = profileRes && profileRes.data
      } else {
        const user = await getUser(openid)
        if (!user.roles.includes('staff')) throw new Error('请选择宠托师')
        profile = (await db.collection('staff_profiles').where({ openid }).limit(1).get()).data[0]
      }
      const settings = await getSystemSettings()
      if (!profile || !canTakeOrders(profile, settings.staffDeposit)) throw new Error('宠托师不可用')
      const calendar = await buildStaffAvailability(profile, data.startDate || data.dateKey || '', data.days || 14)
      if (profile.openid === openid) return calendar
      return calendar.map(day => ({ dateKey: day.dateKey, dayOfWeek: day.dayOfWeek, dayName: day.dayName,
        status: day.status, slots: day.slots, busyOrders: day.busyOrders.map(range => ({ startTime: range.startTime, endTime: range.endTime })), remark: '' }))
    }
    if (action === 'listStaffReviews') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可查看')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = profileRes.data[0]
      if (!profile) throw new Error('请先提交员工认证')
      const where = { staffProfileId: profile._id, status: 'visible' }
      const wantsPage = data && (data.page !== undefined || data.pageSize !== undefined)
      if (wantsPage) {
        const countRes = await db.collection('service_reviews').where(where).count()
        const total = (countRes && countRes.total) || 0
        const page = Math.max(1, Number(data.page || 1))
        const pageSize = Math.min(100, Math.max(1, Number(data.pageSize || 20)))
        const offset = (page - 1) * pageSize
        if (offset >= total) {
          return { list: [], total, page, pageSize, hasMore: false }
        }
        const res = await db.collection('service_reviews')
          .where(where)
          .orderBy('createdAt', 'desc')
          .skip(offset)
          .limit(pageSize)
          .get()
        const list = (res.data || []).map((item) => ({ ...item, clientName: maskClientName(item.clientName) }))
        return {
          list,
          total,
          page,
          pageSize,
          hasMore: offset + list.length < total
        }
      }
      const rows = []
      let cursor = ''
      while (rows.length < 1000) {
        const cond = { ...where }
        if (cursor && db.command && typeof db.command.gt === 'function') cond._id = db.command.gt(cursor)
        const batch = (await db.collection('service_reviews').where(cond).orderBy('_id', 'asc').limit(100).get()).data || []
        rows.push(...batch)
        if (batch.length < 100) break
        cursor = batch[batch.length - 1]._id
      }
      rows.sort((a, b) => toTimeValue(b.createdAt) - toTimeValue(a.createdAt))
      return rows.map((item) => ({ ...item, clientName: maskClientName(item.clientName) }))
    }
    if (action === 'checkUpcomingReminders') {
      await requireAdmin(openid)
      const list = await sendUpcomingServiceRemindersToStaff()
      return { remindedCount: list.length }
    }
    async function readAllStaffOrders(where = {}, maxLimit = 2000) {
      const rows = []
      let cursor = ''
      while (rows.length < maxLimit) {
        const condition = { ...where }
        if (cursor && db.command && typeof db.command.gt === 'function') {
          condition._id = db.command.gt(cursor)
        }
        const page = (await db.collection('orders').where(condition).orderBy('_id', 'asc').limit(100).get()).data || []
        rows.push(...page)
        if (page.length < 100) break
        cursor = page[page.length - 1]._id
      }
      return rows
    }

    if (action === 'listStaffOrders') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可查看')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = profileRes.data[0] || {}
      const latitude = Number(data.latitude || profile.currentLatitude || 0)
      const longitude = Number(data.longitude || profile.currentLongitude || 0)

      const where = { staffOpenid: openid }
      if (data.status && data.status !== 'all') {
        where.status = data.status
      } else if (data.statusGroup === 'waiting_service') {
        where.status = db.command.in(['assigned', 'on_the_way', 'in_service', 'day_completed'])
      }

      const orderKeyword = safeText(data.orderKeyword || data.keyword || data.orderNo).trim().toLowerCase()
      const startDate = safeText(data.startDate).trim()
      const endDate = safeText(data.endDate).trim()
      const wantsPage = data.page !== undefined || data.pageSize !== undefined

      let pagedOrders = []
      const page = Math.max(1, Number(data.page || 1))
      const pageSize = Math.min(100, Math.max(1, Number(data.pageSize || 10)))
      const offset = (page - 1) * pageSize

      const allCandidates = await readAllStaffOrders(where, 2000)
      let list = allCandidates.filter((order) => !isAdminDeletedOrder(order))
      list.sort((a, b) => toTimeValue(b.assignedAt || b.updatedAt || b.createdAt || b.startTime) - toTimeValue(a.assignedAt || a.updatedAt || a.createdAt || a.startTime))

      if (orderKeyword) {
        list = list.filter((order) => [
          order._id,
          order.orderNo,
          order.petName,
          order.serviceSummary,
          order.serviceAddress,
          order.clientSnapshot && order.clientSnapshot.displayName,
          order.clientSnapshot && order.clientSnapshot.nickname
        ].some((val) => safeText(val).toLowerCase().includes(orderKeyword)))
      }

      if (startDate) {
        list = list.filter((order) => {
          const start = String(order.serviceStartDate || order.startTime || order.createdAt || '').slice(0, 10)
          const end = String(order.serviceEndDate || order.endTime || start).slice(0, 10)
          return end >= startDate
        })
      }

      if (endDate) {
        list = list.filter((order) => {
          const start = String(order.serviceStartDate || order.startTime || order.createdAt || '').slice(0, 10)
          return start <= endDate
        })
      }

      const total = list.length
      pagedOrders = wantsPage ? list.slice(offset, offset + pageSize) : list

      const decorate = async (order) => {
        const enriched = await attachOrderDisplayData(order)
        const distanceKm = calcDistanceKm(latitude, longitude, enriched.addressLatitude, enriched.addressLongitude)
        const earning = await calculateStaffEarningForOrder(enriched)
        return {
          ...enriched,
          distanceKm,
          distanceText: formatDistance(distanceKm),
          staffEarning: earning.earningAmount,
          staffEarningText: `¥${earning.earningAmount.toFixed(2)}`
        }
      }

      const decoratedList = await Promise.all(pagedOrders.map(decorate))
      if (wantsPage) {
        return {
          list: decoratedList,
          total,
          page,
          pageSize,
          hasMore: offset + pagedOrders.length < total
        }
      }
      return decoratedList
    }
    if (action === 'checkAcceptOrderRisk') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可接单')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = normalizeStaffWorkflow(profileRes.data[0])
      const settings = await getSystemSettings()
      const ability = validateStaffTakeOrderAbility(profile, settings.staffDeposit)
      if (!ability.can) throw new Error(ability.message || '完成培训和视频审核成为实习宠托师后方可接单')
      if (!hasCoordinate(profile.serviceLatitude, profile.serviceLongitude) || !profile.serviceAddress) {
        throw new Error('请先在个人中心设置固定服务地址与接单范围，方可接单')
      }
      const orderId = safeText(data.orderId).trim()
      if (!orderId) throw new Error('订单不存在')
      const orderRes = await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))
      if (!orderRes || !orderRes.data) throw new Error('订单不存在')
      const order = await expireUnacceptedOrder(orderId, orderRes.data)
      assertStaffGenderMatches(order, profile)
      assertOrderTransition(order.status, ORDER_STATUS.ASSIGNED, '订单状态不可接单')
      if (order.staffOpenid) throw new Error('订单已被分配')
      const publishMode = order.publishMode === 'direct' ? 'direct' : 'open'
      if (publishMode === 'direct' && order.requestedStaffOpenid !== openid) throw new Error('该订单指定了其他宠托师')
      if (publishMode === 'open' && order.requestedStaffOpenid) throw new Error('该订单指定了其他宠托师')
      assertStaffCanAcceptOrderVaccines(profile, await attachOrderDisplayData(order))
      const conflict = await findStaffOrderConflict(profile.openid, order, orderId)
      if (conflict) throw new Error('宠托师该时间段已有订单，无法重复预约')

      const inOp = db.command && typeof db.command.in === 'function' ? db.command.in : (list) => list
      const activeStatuses = ['assigned', 'on_the_way', 'in_service', 'day_completed']
      const activeOrdersRes = await db.collection('orders').where({
        staffOpenid: openid,
        status: inOp(activeStatuses)
      }).count().catch(() => ({ total: 0 }))
      const currentActiveCount = activeOrdersRes.total || 0
      const maxActiveOrders = Number(settings.dispatch && settings.dispatch.maxStaffActiveOrders || 8)
      if (currentActiveCount >= maxActiveOrders) {
        throw new Error(`您当前进行中订单已有 ${currentActiveCount} 笔，已达接单上限（最多 ${maxActiveOrders} 笔），请先履约完成后再接新单`)
      }

      const targetDate = String(order.serviceStartDate || order.startTime || '').slice(0, 10)
      if (targetDate) {
        const dailyOrdersRes = await db.collection('orders').where({
          staffOpenid: openid,
          status: inOp(['assigned', 'on_the_way', 'in_service', 'day_completed', 'completed'])
        }).get().catch(() => ({ data: [] }))
        const sameDayOrders = (dailyOrdersRes.data || []).filter((o) => {
          const oDate = String(o.serviceStartDate || o.startTime || '').slice(0, 10)
          return oDate === targetDate && o._id !== orderId
        })
        const maxDailyOrders = Number(settings.dispatch && settings.dispatch.maxStaffDailyOrders || 6)
        if (sameDayOrders.length >= maxDailyOrders) {
          throw new Error(`您在 ${targetDate} 已接单 ${sameDayOrders.length} 笔，已达单日接单上限（${maxDailyOrders} 笔），请合理规划时间避免服务延误`)
        }
      }

      return checkAcceptOrderRisk(profile, order)
    }
    if (action === 'acceptOrder') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可接单')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = normalizeStaffWorkflow(profileRes.data[0])
      const settings = await getSystemSettings()
      const ability = validateStaffTakeOrderAbility(profile, settings.staffDeposit)
      if (!ability.can) throw new Error(ability.message || '完成培训和视频审核成为实习宠托师后方可接单')
      if (!hasCoordinate(profile.serviceLatitude, profile.serviceLongitude) || !profile.serviceAddress) {
        throw new Error('请先在个人中心设置固定服务地址与接单范围，方可接单')
      }

      const orderId = safeText(data.orderId).trim()
      if (!orderId) throw new Error('订单不存在')
      const orderRes = await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))
      if (!orderRes || !orderRes.data) throw new Error('订单不存在')
      const order = await expireUnacceptedOrder(orderId, orderRes.data)
      if (order.staffOpenid === openid && ['assigned', 'on_the_way', 'in_service', 'day_completed'].includes(order.status)) {
        return { orderId, status: order.status, alreadyAssigned: true, assignmentSource: order.assignmentSource || '' }
      }
      assertStaffGenderMatches(order, profile)
      assertOrderTransition(order.status, ORDER_STATUS.ASSIGNED, '订单状态不可接单')
      if (order.staffOpenid) throw new Error('订单已被分配')
      if (isStaffPreviouslyAssignedToOrder(order, openid)) {
        throw new Error('您是该订单的历史接单宠托师，因超时未按时履约转加急调度，不可重复抢单')
      }
      if (Array.isArray(order.cancelledStaffOpenids) && order.cancelledStaffOpenids.includes(openid)) {
        throw new Error('您此前已取消过该订单，无法再次抢单')
      }
      const publishMode = order.publishMode === 'direct' ? 'direct' : 'open'
      if (publishMode === 'direct' && order.requestedStaffOpenid !== openid) throw new Error('该订单指定了其他宠托师')
      if (publishMode === 'open' && order.requestedStaffOpenid) throw new Error('该订单指定了其他宠托师')
      assertStaffCanAcceptOrderVaccines(profile, await attachOrderDisplayData(order))

      // 校验进行中订单总数上限（防止名下在途订单积压）
      const inOp = db.command && typeof db.command.in === 'function' ? db.command.in : (list) => list
      const activeStatuses = ['assigned', 'on_the_way', 'in_service', 'day_completed']
      const activeOrdersRes = await db.collection('orders').where({
        staffOpenid: openid,
        status: inOp(activeStatuses)
      }).count().catch(() => ({ total: 0 }))
      const currentActiveCount = activeOrdersRes.total || 0
      const maxActiveOrders = Number(settings.dispatch && settings.dispatch.maxStaffActiveOrders || 8)
      if (currentActiveCount >= maxActiveOrders) {
        throw new Error(`您当前进行中订单已有 ${currentActiveCount} 笔，已达接单上限（最多 ${maxActiveOrders} 笔），请先履约完成后再接新单`)
      }

      // 校验目标服务日期的单日接单上限（防止单日接单过多导致疲劳超时违约）
      const targetDate = String(order.serviceStartDate || order.startTime || '').slice(0, 10)
      if (targetDate) {
        const dailyOrdersRes = await db.collection('orders').where({
          staffOpenid: openid,
          status: inOp(['assigned', 'on_the_way', 'in_service', 'day_completed', 'completed'])
        }).get().catch(() => ({ data: [] }))
        const sameDayOrders = (dailyOrdersRes.data || []).filter((o) => {
          const oDate = String(o.serviceStartDate || o.startTime || '').slice(0, 10)
          return oDate === targetDate && o._id !== orderId
        })
        const maxDailyOrders = Number(settings.dispatch && settings.dispatch.maxStaffDailyOrders || 6)
        if (sameDayOrders.length >= maxDailyOrders) {
          throw new Error(`您在 ${targetDate} 已接单 ${sameDayOrders.length} 笔，已达单日接单上限（${maxDailyOrders} 笔），请合理规划时间避免服务延误`)
        }
      }

      // 验证抢单时的实时位置与订单距离
      const currentLat = Number(data.currentLatitude)
      const currentLng = Number(data.currentLongitude)
      const orderLat = Number(order.serviceLatitude || order.addressLatitude || 0)
      const orderLng = Number(order.serviceLongitude || order.addressLongitude || 0)

      if (!hasCoordinate(currentLat, currentLng) || !hasCoordinate(orderLat, orderLng)) throw new Error('缺少有效的实时位置或订单定位，无法接单')

      let distanceFromCurrent = null
      if (hasCoordinate(currentLat, currentLng) && hasCoordinate(orderLat, orderLng)) {
        distanceFromCurrent = calcDistanceKm(currentLat, currentLng, orderLat, orderLng)
        const serviceRadiusKm = Number(profile.serviceRadiusKm || 5)
        if (distanceFromCurrent !== null && distanceFromCurrent > serviceRadiusKm) {
          throw new Error(`订单距离你当前位置约 ${formatDistance(distanceFromCurrent)}，超出 ${serviceRadiusKm}km 服务范围，无法接单`)
        }
      }

      const risk = await checkAcceptOrderRisk(profile, order)
      const conflict = await findStaffOrderConflict(profile.openid, order, data.orderId)
      if (conflict) throw new Error('宠托师该时间段已有订单，无法重复预约')
      if (risk.requiresConfirmation && data.riskConfirmed !== true) throw new Error('请先阅读并确认超出接单设置的履约责任')
      const time = now()
      const isUrgentGrab = Boolean(
        order.isUrgent === true ||
        order.assignmentSource === 'admin_urgent_republish' ||
        (Number(order.urgentBonus || 0) > 0) ||
        (Number(order.urgentStaffReward || 0) > 0)
      )
      const assignmentSource = publishMode === 'direct' ? 'direct_accept' : (isUrgentGrab ? 'urgent_grab' : 'open_grab')

      const assignmentUpdate = {
        staffUserId: user._id,
        staffOpenid: openid,
        staffProfileId: profile._id,
        status: 'assigned',
        assignmentSource,
        assignedAt: time,
        updatedAt: time
      }
      if (isUrgentGrab && order.urgentRepublishedAt) {
        const urgentTime = toTimeValue(order.urgentRepublishedAt)
        if (urgentTime > 0) {
          assignmentUpdate.urgentGrabDurationSeconds = Math.max(0, Math.floor((time.getTime() - urgentTime) / 1000))
        }
      }
      // 【新增】只在有有效值时记录接单位置信息
      if (hasCoordinate(currentLat, currentLng)) {
        assignmentUpdate.acceptLocationLatitude = currentLat
        assignmentUpdate.acceptLocationLongitude = currentLng
      }
      if (distanceFromCurrent !== null && !isNaN(distanceFromCurrent)) {
        assignmentUpdate.acceptDistanceKm = distanceFromCurrent
      }
      if (risk.requiresConfirmation) {
        assignmentUpdate.acceptRiskConfirmedAt = time
        assignmentUpdate.acceptRiskWarnings = risk.warnings
      }
      const assignedOrder = await assignOrderAtomically(data.orderId, order, assignmentUpdate, { depositConfig: settings.staffDeposit, dispatchConfig: settings.dispatch || {}, enforceAcceptLimits: true, riskConfirmed: data.riskConfirmed === true })
      let assignedTitle = publishMode === 'direct' ? '指定宠托师已接单' : (isUrgentGrab ? '加急揭榜抢单' : '宠托师已抢单')
      let timelineDetail = maskStaffName(profile.realName)
      if (isUrgentGrab) {
        const durationMin = assignmentUpdate.urgentGrabDurationSeconds != null
          ? Math.ceil(assignmentUpdate.urgentGrabDurationSeconds / 60)
          : null
        const durationText = durationMin != null ? `（加急响应耗时：${durationMin}分钟）` : ''
        timelineDetail = `宠托师（${maskStaffName(profile.realName)}）已加急揭榜抢单${durationText}，平台加价补贴生效中。`
      }
      // Assignment and its durable notification outbox are already committed.
      await Promise.allSettled([
        appendOrderTimeline(data.orderId, 'assigned', assignedTitle, timelineDetail, 'staff'),
        appendOrderClientMessage(assignedOrder, { eventType: 'assigned', title: assignedTitle, detail: timelineDetail, actorRole: 'staff' })
      ])
      let notifyResult = { status: 'pending', error: '' }
      try { notifyResult = await notifyOrderAccepted(assignedOrder, maskStaffName(profile.realName)) || notifyResult }
      catch (_) { notifyResult = { status: 'pending', error: '通知等待重试' } }
      await db.collection('orders').doc(data.orderId).update({ data: { acceptedNotifyStatus: notifyResult.status, acceptedNotifyError: notifyResult.error || '', updatedAt: time } }).catch(() => {})

      const bundledCount = assignedOrder.bundledCount || 1
      return { orderId: data.orderId, status: 'assigned', assignmentSource, bundledCount, notifyStatus: notifyResult && notifyResult.status || 'skipped', notifyError: notifyResult && notifyResult.error || '' }
    }
    if (action === 'getStaffCancellationQuote') {
      return getStaffCancellationQuote(openid, data)
    }
    if (action === 'cancelStaffAcceptedOrder') {
      return cancelStaffAcceptedOrder(openid, data)
    }
    if (action === 'getDepositStatus') {
      await getUser(openid)
      const synced = await syncWechatStaffDeposit(await getStaffProfileByOpenid(openid))
      const profile = synced.profile
      const settings = await getSystemSettings()
      const config = settings.staffDeposit || normalizeStaffDepositConfig()
      const supplies = settings.staffSupplies || normalizeStaffSuppliesConfig()
      const deposit = synced.deposit ? { ...synced.deposit } : null
      if (deposit) {
        delete deposit.lastForfeitImages
        delete deposit.evidenceImages
        delete deposit.forfeitProofImages
        delete deposit.forfeitImages
      }
      const auditApproved = profile && profile.auditStatus === 'approved'
      const isRefunded = Boolean((profile && profile.depositStatus === 'refunded') || (deposit && deposit.status === 'refunded'))
      const needsRepay = Boolean(profile && (profile.requireDepositRepay === true || profile.depositStatus === 'supplement_required' || profile.depositStatus === 'forfeited' || (deposit && deposit.status === 'forfeited') || isRefunded))
      const canPay = Boolean(config.enabled && config.amount > 0 && auditApproved && (!deposit || deposit.status === 'unpaid' || needsRepay))
      const canRequestRefund = Boolean(deposit && ['paid', 'partially_refunded'].includes(deposit.status) && (deposit.availableRefundAmount || 0) > 0 && deposit.refundStatus !== 'requested')

      const eventsRes = await readScopedDocuments('staff_deposit_events', { staffOpenid: openid }, 'createdAt', 'desc').catch(() => [])
      const eventTypeMap = {
        pay: '充值缴纳',
        forfeit: '违规扣除/没收',
        refund_request: '申请退还',
        refund: '退款到账',
        refund_audit: '退款审核'
      }
      const events = eventsRes.map((e) => ({
        _id: e._id,
        type: e.type,
        typeName: eventTypeMap[e.type] || e.type,
        amount: Number(e.amount || 0),
        amountText: e.type === 'pay' ? `+¥${Number(e.amount || 0).toFixed(2)}` : (e.type === 'forfeit' ? `-¥${Number(e.amount || 0).toFixed(2)}` : `¥${Number(e.amount || 0).toFixed(2)}`),
        reason: e.reason || '',
        operatorRole: e.operatorRole || '',
        createdAt: e.createdAt || ''
      }))

      return {
        config,
        supplies,
        deposit,
        profile,
        canPay,
        canRequestRefund,
        needsRepay,
        paymentSyncPending: synced.paymentSyncPending === true,
        repayReason: profile && profile.requireDepositRepayReason || '',
        events
      }
    }
    if (action === 'createDepositPayment') {
      if (data.agreed !== true) throw new Error('请先阅读并同意保证金缴纳规则')
      const user = await getUser(openid)
      const profile = await getStaffProfileByOpenid(openid)
      if (!profile || profile.auditStatus !== 'approved') throw new Error('资料审核通过后方可缴纳保证金')
      const settings = await getSystemSettings({ includeSecrets: true })
      const config = settings.staffDeposit || normalizeStaffDepositConfig()
      if (!config.enabled || !config.amount || config.amount <= 0) throw new Error('保证金缴纳当前未开放')
      const clientRequestId = getClientRequestId(data)
      const paymentMode = (settings.payment && settings.payment.mode) || 'mock'
      assertPaymentModeAllowed({ ...settings.payment, mode: paymentMode })
      const synced = await syncWechatStaffDeposit(profile)
      if (synced.reconciled && synced.deposit.status === 'paid') return { paid: true, depositId: synced.deposit._id }
      const { deposit, payment: paymentRecord } = await reserveStaffDepositPayment(user, synced.profile, config.amount, paymentMode, clientRequestId)
      const amount = deposit.amount
      if (deposit.status === 'paid') return { paid: true, depositId: deposit._id }
      if (paymentMode === 'mock') {
        await markStaffDepositPaid(deposit._id, { paymentNo: paymentRecord.paymentNo, channel: 'mock' })
        return { paid: true, depositId: deposit._id, isMock: true }
      } else {
        const configWechat = getWechatPayConfig(settings)
        const PREPAY_TTL_MS = 90 * 60 * 1000
        const isPrepayExpired = paymentRecord.updatedAt && (Date.now() - new Date(paymentRecord.updatedAt).getTime() > PREPAY_TTL_MS)
        if (paymentRecord.prepayId && !isPrepayExpired) {
          return {
            paid: false,
            depositId: deposit._id,
            paymentNo: paymentRecord.paymentNo,
            payParams: buildMiniProgramPayParams(paymentRecord.prepayId, configWechat)
          }
        }
        const requestBody = {
          appid: configWechat.appId,
          mchid: configWechat.mchId,
          description: '宠托师入驻保证金',
          out_trade_no: paymentRecord.paymentNo,
          notify_url: configWechat.notifyUrl,
          amount: { total: amountYuanToFen(amount), currency: 'CNY' },
          payer: { openid }
        }
        try {
          const response = await wechatPayRequest('POST', '/v3/pay/transactions/jsapi', requestBody, configWechat)
          if (!response.prepay_id) throw new Error('微信支付未返回 prepay_id')
          await db.collection('payments').doc(paymentRecord._id).update({
            data: {
              prepayId: response.prepay_id,
              rawRequest: sanitizeWechatPayload(requestBody),
              rawResponse: sanitizeWechatPayload(response),
              updatedAt: now()
            }
          })
          return {
            paid: false,
            depositId: deposit._id,
            paymentNo: paymentRecord.paymentNo,
            payParams: buildMiniProgramPayParams(response.prepay_id, configWechat)
          }
        } catch (error) {
          await appendPaymentEvent('prepay_failed', { orderId: deposit._id, paymentNo: paymentRecord.paymentNo, status: 'failed', detail: { message: error.message, targetType: 'staff_deposit' } })
          throw new Error(`微信支付保证金下单失败：${error.message}`)
        }
      }
    }
    if (action === 'requestDepositRefund') {
      const reason = safeText(data.reason).trim()
      if (!reason) throw new Error('请填写自愿退出及退款原因')
      if (typeof checkTextSecurity === 'function') {
        await checkTextSecurity(openid, reason, { scene: 2, label: '保证金退款原因' })
      }
      await getUser(openid)
      const res = await db.collection('staff_deposits').where({ staffOpenid: openid }).orderBy('createdAt', 'desc').get().catch(() => ({ data: [] }))
      const deposits = (res && res.data) || []
      const deposit = deposits.find((d) => Number(d.availableRefundAmount || 0) > 0 && ['paid', 'partially_refunded'].includes(d.status)) || deposits[0]
      if (!deposit) throw new Error('暂无可退还保证金')
      return requestStaffDepositRefund(openid, deposit._id, reason)
    }
    if (action === 'getSupplyReimbursementStatus') {
      const user = await getUser(openid)
      const profile = await getStaffProfileByOpenid(openid)
      const settings = await getSystemSettings()
      const supplies = settings.staffSupplies || normalizeStaffSuppliesConfig()
      const res = await db.collection('staff_supply_reimbursements').where({ staffOpenid: openid }).orderBy('createdAt', 'desc').limit(1).get()
      const application = res.data && res.data[0] || null
      const isCertified = Boolean(profile && profile.auditStatus === 'approved' && profile.staffLevel === 'certified')
      const completedOrders = await readScopedDocuments('orders', { staffOpenid: openid, status: 'completed' })
      const completedOrderCount = completedOrders.filter((order) => order.status === 'completed').length
      const inviteRows = await readScopedDocuments('user_invites', { inviterOpenid: openid, eligibleForSupplyReimbursement: true })
      const qualification = getSupplyReimbursementQualification(supplies, completedOrderCount, inviteRows.filter((row) => row.eligibleForSupplyReimbursement === true).length)
      const mallOrders = await readScopedDocuments('mall_orders', { clientOpenid: openid })
      const eligibleMallOrders = mallOrders.filter((order) => ['paid', 'pending_ship', 'shipped', 'completed', 'received'].includes(order.status))
      const purchaseMet = supplies.purchaseRequired === false || eligibleMallOrders.length > 0
      const canApply = Boolean(!application && isCertified && supplies.reimbursementEnabled !== false && qualification.qualificationMet && purchaseMet)
      return {
        application,
        canApply,
        supplies,
        qualification,
        eligibleMallOrders: eligibleMallOrders.map((order) => ({ _id: order._id, orderNo: order.orderNo || '', status: order.status, items: order.items || [], createdAt: order.createdAt || '' })),
        purchaseMet
      }
    }
    if (action === 'submitSupplyReimbursement') {
      const clientRequestId = getClientRequestId(data)
      if (clientRequestId) {
        const existingReq = await findByClientRequestId('staff_supply_reimbursements', { staffOpenid: openid, clientRequestId })
        if (existingReq) return existingReq
      }
      const user = await getUser(openid)
      const profile = await getStaffProfileByOpenid(openid)
      if (!profile || profile.auditStatus !== 'approved' || profile.staffLevel !== 'certified') {
        throw new Error('仅正式认证宠托师可申请首次用品报销，实习人员不具备报销资格')
      }
      const settings = await getSystemSettings()
      const supplies = settings.staffSupplies || normalizeStaffSuppliesConfig()
      if (supplies.reimbursementEnabled === false) throw new Error('用品报销申请暂未开放')
      const completedOrders = await readScopedDocuments('orders', { staffOpenid: openid, status: 'completed' })
      const inviteRows = await readScopedDocuments('user_invites', { inviterOpenid: openid, eligibleForSupplyReimbursement: true })
      const qualification = getSupplyReimbursementQualification(supplies, completedOrders.filter((order) => order.status === 'completed').length, inviteRows.filter((row) => row.eligibleForSupplyReimbursement === true).length)
      if (!qualification.qualificationMet) {
        const remaining = qualification.conditions.map(condition => condition.mode === 'invite_count'
          ? `邀请 ${condition.requiredCount - condition.progressCount} 人绑定邀请码`
          : `完成 ${condition.requiredCount - condition.progressCount} 笔订单`)
        throw new Error(`还需${remaining.join('，或')}${remaining.length > 1 ? '，满足任一条件后即可申请报销' : '后才能申请报销'}`)
      }
      const existing = await db.collection('staff_supply_reimbursements').where({ staffOpenid: openid }).limit(1).get()
      if (existing.data && existing.data.length > 0) {
        throw new Error('每位宠托师仅限申请一次首次宠物用品报销，后续服务用品须自备自费')
      }
      const mediaFileIds = Array.isArray(data.mediaFileIds) ? data.mediaFileIds.filter(Boolean) : []
      if (mediaFileIds.length > 9) throw new Error('凭证截图最多上传 9 张')
      if (mediaFileIds.length && typeof checkImageSecurity === 'function') {
        await Promise.all(mediaFileIds.map((fileId) => checkImageSecurity(openid, fileId, { scene: 1, label: '用品报销凭证' })))
      }
      const mallOrderId = safeText(data.mallOrderId).trim()
      if (mallOrderId) {
        const mallOrder = (await db.collection('mall_orders').doc(mallOrderId).get().catch(() => ({ data: null }))).data
        if (!mallOrder || mallOrder.clientOpenid !== openid || !['paid', 'pending_ship', 'shipped', 'completed', 'received'].includes(mallOrder.status)) throw new Error('请选择本人已支付的线上用品订单')
      }
      if (supplies.purchaseRequired !== false && !mallOrderId) throw new Error('请先在平台线上店铺购买一次性用品，并选择对应订单')
      const fixedAmount = Number(supplies.reimbursementAmount || supplies.maxReimbursementAmount || 200)
      // Keep legacy callers working during rollout; the new app flow omits amount and
      // always uses the backend-configured fixed amount.
      const amount = data.amount !== undefined && !mallOrderId ? Number(data.amount) : fixedAmount
      if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) throw new Error('后台报销金额配置不正确')
      if (data.amount !== undefined && !mallOrderId && amount > Number(supplies.maxReimbursementAmount || 200)) throw new Error(`首次用品报销金额不能超过上限 ¥${supplies.maxReimbursementAmount || 200}`)
      const remark = safeText(data.remark).trim()
      if (remark.length > 500) throw new Error('报销备注不能超过 500 字')
      if (remark && typeof checkTextSecurity === 'function') {
        await checkTextSecurity(openid, remark, { scene: 1, label: '用品报销备注' })
      }
      const time = now()
      const record = {
        staffOpenid: openid,
        staffUserId: user._id,
        staffProfileId: profile._id,
        mediaFileIds,
        mallOrderId,
        purchaseVerified: Boolean(mallOrderId),
        amountSource: mallOrderId || data.amount === undefined ? 'config' : 'legacy',
        amount,
        approvedAmount: null,
        remark,
        clientRequestId,
        status: 'pending',
        statusText: '待审核',
        transferStatus: '',
        createdAt: time,
        updatedAt: time
      }
      return submitStaffSupplyOnce(record)
    }
    if (action === 'querySupplyReimbursement') {
      await getUser(openid)
      const res = await db.collection('staff_supply_reimbursements').where({ staffOpenid: openid }).orderBy('createdAt', 'desc').limit(1).get()
      return res.data && res.data[0] || null
    }
    if (action === 'getSupplyTransferConfirmation') {
      await getUser(openid)
      const res = await db.collection('staff_supply_reimbursements').where({ staffOpenid: openid }).orderBy('createdAt', 'desc').limit(1).get()
      const app = res.data && res.data[0]
      if (!app) throw new Error('暂无报销申请')
      const settings = await getSystemSettings()
      const mchId = (settings.payment && settings.payment.mchId) || ''
      const appId = (settings.payment && settings.payment.appId) || ''
      return {
        status: app.transferStatus || app.status,
        mchId,
        appId,
        packageInfo: app.transferPackageInfo || ''
      }
    }
    throw new Error('未知 staff 操作')
  }
}
