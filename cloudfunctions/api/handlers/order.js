const { normalizeStaffGenderRequirement, assertStaffGenderMatches } = require('../utils/staffGender')
const { filterTrackPoints } = require('../utils/trackQuality')

module.exports = function createHandler(context) {
  const {
    ORDER_STATUS,
    addPoints,
    appendOrderClientMessage,
    appendOrderStaffMessage,
    appendOrderTimeline,
    assertOrderTransition,
    attachClientSnapshot,
    attachOrderDisplayData,
    beijingDateKey,
    calcDistanceKm,
    calcOrderPricing,
    canStartOrderSession,
    canTakeOrders,
    checkTextSecurity,
    checkinEventText,
    completeOrderService,
    ensureStaffEarning,
    ensureOrderCompletionRewards,
    createClientSnapshot,
    createOrderWithCouponLock,
    createPetSnapshot,
    createRefundForOrder,
    cancelUnpaidOrder,
    db,
    enrichUserMemberLevel,
    evaluateCheckinCompletion,
    expireDueUnacceptedOrders,
    findActiveStaffService,
    formatDistance,
    formatPetSummary,
    getActiveServiceSession,
    getApprovedEarlyStart,
    getCancelQuoteForOrder,
    getClientPetsByIds,
    getClientRequestId,
    getLatestEarlyStart,
    getMemberLevels,
    getNextPendingServiceSession,
    getOrderForAccess,
    getPendingEarlyStart,
    getRequestedStaff,
    getSystemSettings,
    getTodayServiceSession,
    getUser,
    groupCheckinsByEventType,
    hasCoordinate,
    isActiveCheckin,
    isAdminDeletedOrder,
    isBeforeServiceStart,
    isValidSanitization,
    listServicePrices,
    makeIdempotencyKey,
    markServiceSession,
    maskOrderClientContact,
    maskOrderForStaffPreview,
    normalizeHomeSecurityInput,
    normalizePetIds,
    normalizeServiceSessions,
    notifyOrder,
    now,
    restoreOrderCoupon,
    paginateList,
    processOverdueUnfinishedOrders,
    processOverdueUnstartedOrders,
    readScopedDocuments,
    requireAdmin,
    requireClientOrder,
    requireSanitizationEvidence,
    requireServiceReportAccess,
    requireStaffOrder,
    requiredCheckins,
    requiresSanitization,
    resolveCheckinRequirements,
    safeCollectionData,
    safeText,
    saveUserAddress,
    shouldHidePublicCheckinPhotos,
    toEarlyStartView,
    toHomeOrderActivity,
    toPublicHomeSecuritySnapshot,
    toPublicOrderHomeSecurity,
    toServiceReportOrder,
    toTimeValue,
    updateOrderWhenStatus,
    updateStaffRatingStats,
    validateDirectStaffServiceRange,
    validateOrderTime,
    validateStaffAvailabilityForSessions
  } = context
  function sanitizeOrderSecurityFields(order) {
    if (!order) return order
    const security = order.orderHomeSecurity || order.homeSecuritySnapshot
    const publicSecurity = toPublicOrderHomeSecurity(security)
    return { ...order, orderHomeSecurity: publicSecurity, homeSecuritySnapshot: publicSecurity ? toPublicHomeSecuritySnapshot(publicSecurity) : null }
  }
  return async function order(openid, action, data) {
    if (action === 'listServiceOptions') {
      await getUser(openid)
      return listServicePrices(false)
    }

    if (action === 'quoteOrder') {
      const staffGenderRequirement = normalizeStaffGenderRequirement(data.staffGenderRequirement)
      await getUser(openid)
      let pets = []
      const petIds = normalizePetIds(data)
      if (petIds.length) pets = await getClientPetsByIds(openid, petIds)
      const pricing = await calcOrderPricing(data, pets, { openid })
      if (data.startTime || data.endTime) validateOrderTime({ ...data, durationMinutes: pricing.durationMinutes, endTime: pricing.sessions[pricing.sessions.length - 1].endTime })
      const publishMode = data.publishMode === 'direct' ? 'direct' : 'open'
      const staffProfileId = safeText(data.staffProfileId || data.requestedStaffProfileId).trim()
      if (publishMode === 'direct' && staffProfileId) {
        const staffProfileRes = await db.collection('staff_profiles').doc(staffProfileId).get().catch(() => ({ data: null }))
        const staffProfile = staffProfileRes && staffProfileRes.data
        if (!staffProfile) throw new Error('指定的宠托师不可用')
        assertStaffGenderMatches({ staffGenderRequirement }, staffProfile)
        validateDirectStaffServiceRange(staffProfile, data, { isQuote: true })
        if (data.startTime && data.endTime) {
          await validateStaffAvailabilityForSessions(staffProfile, pricing.sessions)
        }
      }
      return pricing
    }

    if (action === 'createOrder') {
      const user = await getUser(openid)
      const clientRequestId = getClientRequestId(data)
      if (clientRequestId) {
        const existingOrder = (await db.collection('orders').where({ clientOpenid: openid, clientRequestId }).limit(1).get()).data[0]
        if (existingOrder) return { ...sanitizeOrderSecurityFields(existingOrder), savedAddress: null }
      }
      if (!safeText(user.phone).trim()) throw new Error('请先绑定手机号')
      const petIds = normalizePetIds(data)
      if (!petIds.length) throw new Error('请选择宠物')
      if (!data.serviceAddress) throw new Error('请选择服务地址')
      if (!data.addressDetail) throw new Error('请填写详细地址')
      if (!data.doorplate) throw new Error('请填写门牌号或入户说明')
      const pets = await getClientPetsByIds(openid, petIds)
      const pricing = await calcOrderPricing(data, pets, { openid })
      validateOrderTime({ ...data, durationMinutes: pricing.durationMinutes, endTime: pricing.sessions[pricing.sessions.length - 1].endTime })
      const serviceSessions = pricing.sessions
      const primaryPet = pets[0]
      const petSnapshots = pets.map(createPetSnapshot)
      const petNames = pets.map((pet) => pet.name || '宠物')
      const petSummary = formatPetSummary(pets)
      const requestedStaff = await getRequestedStaff(data)
      let directDistanceKm = null
      if (requestedStaff && requestedStaff.requestedStaffProfileId) {
        const staffProfileRes = await db.collection('staff_profiles').doc(requestedStaff.requestedStaffProfileId).get().catch(() => ({ data: null }))
        const staffProfile = staffProfileRes && staffProfileRes.data
        if (!staffProfile) throw new Error('指定的宠托师不可用')
        const rangeCheck = validateDirectStaffServiceRange(staffProfile, data, { isQuote: false })
        directDistanceKm = rangeCheck.dist
        await validateStaffAvailabilityForSessions(staffProfile, serviceSessions)
      }
      const rawOrderLat = data.addressLatitude !== undefined ? data.addressLatitude : data.latitude
      const rawOrderLng = data.addressLongitude !== undefined ? data.addressLongitude : data.longitude
      let addressLatitude = 0
      let addressLongitude = 0
      if (rawOrderLat !== undefined || rawOrderLng !== undefined) {
        const numLat = Number(rawOrderLat || 0)
        const numLng = Number(rawOrderLng || 0)
        if (!Number.isFinite(numLat) || !Number.isFinite(numLng) || numLat < -90 || numLat > 90 || numLng < -180 || numLng > 180) {
          throw new Error('服务地址经纬度坐标无效')
        }
        addressLatitude = numLat
        addressLongitude = numLng
      }
      const time = now()
      const homeSecurity = normalizeHomeSecurityInput({ ...data, startTime: serviceSessions[0].startTime, endTime: serviceSessions[serviceSessions.length - 1].endTime })
      const checkinRequirements = await resolveCheckinRequirements(pricing.serviceTypes)
      const memberLevels = await getMemberLevels()
      const order = { orderNo: `O${Date.now()}${Math.floor(Math.random() * 1000)}`, clientRequestId, idempotencyKey: clientRequestId || '', clientUserId: user._id, clientOpenid: openid, clientSnapshot: createClientSnapshot(user, memberLevels), contactPhone: safeText(user.phone).trim(), staffUserId: '', staffOpenid: '', staffProfileId: '', ...requestedStaff, distanceFromSitterKm: directDistanceKm, assignmentSource: '', sourceOrderId: data.sourceOrderId || '', petId: primaryPet._id || petIds[0], petIds, petName: petSummary, petNames, petSnapshot: petSnapshots[0], petSnapshots, petSummary, serviceType: pricing.primaryServiceType || pricing.businessServiceTypes[0], serviceTypes: pricing.serviceTypes, serviceLabels: pricing.serviceLabels, serviceSummary: pricing.serviceSummary, city: data.city || '', serviceAddress: data.serviceAddress || '', addressDetail: data.addressDetail || '', doorplate: data.doorplate || '', addressLatitude, addressLongitude, orderType: pricing.orderType, serviceStartDate: serviceSessions[0].date, serviceEndDate: serviceSessions[serviceSessions.length - 1].date, sessionCount: serviceSessions.length, serviceSessions, startTime: serviceSessions[0].startTime, endTime: serviceSessions[serviceSessions.length - 1].endTime, durationMinutes: pricing.durationMinutes, petServiceDurations: pricing.petServiceDurations, amount: pricing.amount, discountAmount: pricing.discountAmount || 0, payAmount: pricing.payAmount, couponId: pricing.coupon ? pricing.coupon.couponId : '', couponTemplateId: pricing.coupon ? pricing.coupon.templateId : '', couponName: pricing.coupon ? pricing.coupon.name : '', couponSnapshot: pricing.coupon ? pricing.coupon.snapshot : null, priceSnapshot: pricing.priceSnapshot, paymentStatus: 'unpaid', status: 'pending_pay', isUrgent: false, checkinRequirements, requiredCheckins: checkinRequirements.filter((item) => item.required).map((item) => item.eventType), optionalCheckins: checkinRequirements.filter((item) => !item.required).map((item) => item.eventType), homeSecuritySnapshot: toPublicHomeSecuritySnapshot(homeSecurity), orderHomeSecurity: homeSecurity, lockMethod: homeSecurity.lockMethod, hasDoorLockCode: homeSecurity.hasDoorLockCode, insurancePolicyNo: '', cancelReason: '', refundStatus: '', refundAmount: 0, createdAt: time, updatedAt: time }
      let savedAddress = null
      if (data.saveAddress === true) {
        savedAddress = await saveUserAddress(openid, user, {
          label: data.addressLabel || '预约地址',
          serviceAddress: data.serviceAddress,
          addressDetail: data.addressDetail,
          doorplate: data.doorplate,
          latitude: data.addressLatitude,
          longitude: data.addressLongitude,
          isDefault: true
        })
      }
      const createdOrder = await createOrderWithCouponLock({
        collectionName: 'orders',
        order,
        couponId: order.couponId,
        openid,
        extraDocuments: [
          {
            collection: 'order_home_security',
            data: {
              clientOpenid: openid,
              ...homeSecurity,
              createdAt: time,
              updatedAt: time
            }
          }
        ]
      })
      await appendOrderTimeline(createdOrder._id, 'created', '订单已创建', order.serviceSummary, 'client')
      await appendOrderClientMessage(createdOrder, { eventType: 'created', title: '订单已创建', detail: order.serviceSummary, actorRole: 'client', unreadForClient: false })
      if (order.couponId) {
        await appendOrderTimeline(createdOrder._id, 'coupon_locked', '已使用优惠券', `优惠 ¥${order.discountAmount}`, 'client')
        await appendOrderClientMessage(createdOrder, { eventType: 'coupon_locked', title: '已使用优惠券', detail: `优惠 ¥${order.discountAmount}`, actorRole: 'client', unreadForClient: false })
      }
      return { ...sanitizeOrderSecurityFields(createdOrder), savedAddress }
    }

    async function readAllOrders(where = {}, maxLimit = 2000) {
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

    if (action === 'listOrders') {
      const user = await getUser(openid)
      await expireDueUnacceptedOrders()
      const role = data.role || user.activeRole || 'client'
      const where = role === 'staff' ? { staffOpenid: openid } : { clientOpenid: openid }

      if (data.status && data.status !== 'all') {
        where.status = data.status
      } else if (data.statusGroup === 'waiting_service') {
        where.status = db.command.in(['assigned', 'in_service', 'day_completed'])
      }

      const orderKeyword = safeText(data.orderKeyword || data.keyword || data.orderNo).trim().toLowerCase()
      const startDate = safeText(data.startDate).trim()
      const endDate = safeText(data.endDate).trim()
      const wantsPage = data.page !== undefined || data.pageSize !== undefined

      let pagedOrders = []
      const page = Math.max(1, Number(data.page || 1))
      const pageSize = Math.min(100, Math.max(1, Number(data.pageSize || 10)))
      const offset = (page - 1) * pageSize

      const allCandidates = await readAllOrders(where, 2000)
      let list = allCandidates.filter((order) => !isAdminDeletedOrder(order))
      list.sort((a, b) => toTimeValue(b.createdAt || b.startTime) - toTimeValue(a.createdAt || a.startTime))

      if (orderKeyword) {
        list = list.filter((order) => [
          order._id,
          order.orderNo,
          order.petName,
          order.serviceSummary,
          order.serviceAddress,
          order.staffName,
          order.requestedStaffName
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

      const levels = await getMemberLevels()
      const userCache = new Map()
      const isStaffOnly = role === 'staff' && !user.roles.includes('admin')
      const enrichedList = (await Promise.all(pagedOrders.map((order) => attachOrderDisplayData(order, levels, userCache)))).map(sanitizeOrderSecurityFields)
      const finalEnriched = isStaffOnly ? enrichedList.map(maskOrderClientContact) : enrichedList

      if (wantsPage) {
        return {
          list: finalEnriched,
          total,
          page,
          pageSize,
          hasMore: offset + pagedOrders.length < total
        }
      }
      return finalEnriched
    }

    if (action === 'getOrderDetail') {
      const orderId = data.id || data.orderId
      const { user, order } = await getOrderForAccess(openid, orderId)
      const levels = await getMemberLevels()
      const displayOrder = await attachOrderDisplayData(order, levels)
      const [earlyStart, securityRes, checkinsRes, tracksRes] = await Promise.all([
        getPendingEarlyStart(orderId).then((pending) => pending || getApprovedEarlyStart(orderId) || getLatestEarlyStart(orderId)),
        db.collection('order_home_security').where({ orderId }).limit(1).get(),
        readScopedDocuments('checkin_logs', { orderId }, 'createdAt', 'asc'),
        readScopedDocuments('track_logs', { orderId }, 'recordedAt', 'asc')
      ])
      const activeSession = getActiveServiceSession(order)
      const sessionStartedAt = toTimeValue(order.currentSessionStartedAt || (activeSession && activeSession.startedAt) || order.startedAt)
      const checkinGroups = groupCheckinsByEventType(checkinsRes.filter((item) => {
        if (item.eventType === 'sanitization') return isValidSanitization(item, order, order.currentSessionStartedAt || (activeSession && activeSession.startedAt) || order.startedAt || now())
        if (order.status !== ORDER_STATUS.IN_SERVICE || !sessionStartedAt) return isActiveCheckin(item)
        return isActiveCheckin(item) && toTimeValue(item.recordedAt || item.serverTime || item.createdAt) >= (sessionStartedAt - 60000)
      }))
      const baseCheckinRequirements = Array.isArray(displayOrder.checkinRequirements) && displayOrder.checkinRequirements.length
        ? displayOrder.checkinRequirements
        : (Array.isArray(displayOrder.requiredCheckins) ? displayOrder.requiredCheckins : requiredCheckins(displayOrder.serviceType, displayOrder.serviceTypes)).map((eventType, index) => ({ eventType, label: checkinEventText(eventType), required: true, serviceTypes: displayOrder.serviceTypes || [displayOrder.serviceType], sortOrder: (index + 1) * 10 }))
      const checkinRequirements = baseCheckinRequirements.some((item) => item.eventType === 'pet_beauty_photo')
        ? baseCheckinRequirements
        : baseCheckinRequirements.concat([{ eventType: 'pet_beauty_photo', label: checkinEventText('pet_beauty_photo'), required: false, optional: true, serviceTypes: displayOrder.serviceTypes || [displayOrder.serviceType], sortOrder: 999 }])
      const orderSecurity = securityRes.data[0] || displayOrder.orderHomeSecurity || displayOrder.homeSecuritySnapshot
      const enrichedRequirements = checkinRequirements.map((item) => {
        const group = checkinGroups[item.eventType] || { count: 0, photos: [] }
        return { ...item, completed: group.count > 0, photoCount: group.count, photos: group.photos }
      })
      const publicSecurity = toPublicOrderHomeSecurity(orderSecurity)
      const resultOrder = { ...displayOrder, trackCount: filterTrackPoints(tracksRes).length, checkinPhotoCount: Object.values(checkinGroups).reduce((sum, group) => sum + group.count, 0), checkinRequirements: enrichedRequirements, earlyStartRequest: toEarlyStartView(earlyStart), orderHomeSecurity: publicSecurity, homeSecuritySnapshot: publicSecurity ? toPublicHomeSecuritySnapshot(publicSecurity) : null }
      const requestedRole = safeText(data.role).trim()
      const isStaffView = requestedRole === 'staff' || user.activeRole === 'staff' || (order.clientOpenid !== openid && user.roles.includes('staff'))
      const isPreviousStaff = (Array.isArray(order.previousStaffRecords) && order.previousStaffRecords.some((r) => r.staffOpenid === openid)) || order.originalStaffOpenid === openid
      const isReassignedToOther = Boolean(isPreviousStaff && order.staffOpenid !== openid)
      if (isReassignedToOther) {
        resultOrder.isReassignedToOther = true
        resultOrder.reassignedReason = order.isUrgent ? 'urgent_republish' : 'reassigned'
        resultOrder.reassignNotice = order.isUrgent ? '该订单因超时未履约已被平台转加急派单' : '该订单已被平台改派给其他宠托师'
      }
      const isStaffPreview = isStaffView && (order.status === ORDER_STATUS.PAID || order.staffOpenid !== openid)
      if (isStaffPreview) return maskOrderForStaffPreview(resultOrder)
      if (isStaffView || (!user.roles.includes('admin') && order.clientOpenid !== openid)) return maskOrderClientContact(resultOrder)
      return resultOrder
    }

    if (action === 'prepareRebook') {
      const { order } = await requireClientOrder(openid, data.orderId, '无权再次预约')
      let publishMode = order.publishMode === 'direct' ? 'direct' : 'open'
      let staffProfileId = order.requestedStaffProfileId || order.staffProfileId || ''
      if (publishMode === 'direct' && staffProfileId) {
        try {
          const settings = await getSystemSettings().catch(() => ({}))
          const profileRes = await db.collection('staff_profiles').doc(staffProfileId).get()
          if (!profileRes.data || !canTakeOrders(profileRes.data, settings.staffDeposit)) {
            publishMode = 'open'
            staffProfileId = ''
          }
        } catch (error) {
          publishMode = 'open'
          staffProfileId = ''
        }
      }
      return {
        sourceOrderId: order._id,
        petId: order.petId,
        petIds: Array.isArray(order.petIds) && order.petIds.length ? order.petIds : [order.petId].filter(Boolean),
        serviceType: order.serviceType,
        serviceTypes: order.serviceTypes || [order.serviceType],
        serviceAddress: order.serviceAddress || '',
        addressDetail: order.addressDetail || '',
        doorplate: order.doorplate || '',
        addressLatitude: Number(order.addressLatitude || 0),
        addressLongitude: Number(order.addressLongitude || 0),
        durationMinutes: Number(order.durationMinutes || 60),
        petServiceDurations: Array.isArray(order.petServiceDurations) ? order.petServiceDurations : (order.priceSnapshot && Array.isArray(order.priceSnapshot.petServiceDurations) ? order.priceSnapshot.petServiceDurations : []),
        publishMode,
        staffGenderRequirement: normalizeStaffGenderRequirement(order.staffGenderRequirement),
        staffProfileId
      }
    }

    if (action === 'getOrderTimeline') {
      await getOrderForAccess(openid, data.orderId)
      return readScopedDocuments('order_timeline', { orderId: data.orderId }, 'createdAt', 'asc')
    }

    if (action === 'getOrderReview') {
      await getOrderForAccess(openid, data.orderId)
      const res = await db.collection('service_reviews').where({ orderId: data.orderId, status: 'visible' }).limit(1).get()
      return res.data[0] || null
    }

    if (action === 'createReview') {
      const { user, order } = await requireClientOrder(openid, data.orderId, '仅宠物主可评价')
      if (order.status !== 'completed') throw new Error('订单完成后才可评价')
      if (order.reviewedAt) throw new Error('该订单已评价')
      const existing = await db.collection('service_reviews').where({ orderId: data.orderId }).limit(1).get()
      if (existing.data && existing.data[0]) throw new Error('该订单已评价')
      const rating = Math.min(Math.max(Number(data.rating || 5), 1), 5)
      const tags = Array.isArray(data.tags) ? data.tags.slice(0, 8) : []
      const content = String(data.content || '').trim()
      const reviewText = [content, ...tags].filter(Boolean).join(' ')
      if (reviewText) {
        await checkTextSecurity(openid, reviewText, { scene: 2, label: '评价内容' })
      }
      const time = now()
      const enrichedUser = await enrichUserMemberLevel(user)
      const reviewId = `review_${data.orderId}`
      const review = {
        _id: reviewId,
        orderId: data.orderId,
        clientUserId: user._id,
        clientOpenid: openid,
        clientName: user.nickname || '',
        clientAvatarUrl: user.avatarUrl || '',
        memberLevelName: enrichedUser.memberLevelName || '普通会员',
        badgeTag: enrichedUser.badgeTag || 'V1',
        badgeStyle: enrichedUser.badgeStyle || 'gold',
        nameColor: enrichedUser.nameColor || '',
        nameEffect: enrichedUser.nameEffect || '',
        staffUserId: order.staffUserId || '',
        staffOpenid: order.staffOpenid || '',
        staffProfileId: order.staffProfileId || '',
        rating,
        tags,
        content,
        status: 'visible',
        createdAt: time,
        updatedAt: time
      }
      await db.runTransaction(async (tx) => {
        const currentOrder = (await tx.collection('orders').doc(data.orderId).get().catch(() => ({ data: null }))).data
        if (!currentOrder || currentOrder.clientOpenid !== openid) throw new Error('仅宠物主可评价')
        if (currentOrder.status !== 'completed') throw new Error('订单完成后才可评价')
        if (currentOrder.reviewedAt) throw new Error('该订单已评价')
        let docCheck = null
        try {
          docCheck = (await tx.collection('service_reviews').doc(reviewId).get()).data
        } catch (e) {
          docCheck = null
        }
        const { _id, ...reviewData } = review
        await tx.collection('service_reviews').doc(reviewId).set({ data: reviewData })
        await tx.collection('orders').doc(data.orderId).update({ data: { reviewedAt: time, updatedAt: time } })
      })
      await updateStaffRatingStats(order.staffProfileId, time)
      await appendOrderTimeline(data.orderId, 'reviewed', '宠物主已评价', `${rating}星评价`, 'client')
      await addPoints(openid, user._id, 10, 'order_review', data.orderId, '评价订单 +10 积分', { applyMultiplier: true, baseDelta: 10 })
      return review
    }

    if (action === 'getCancelQuote') {
      const { order } = await requireClientOrder(openid, data.orderId, '无权取消订单')
      return getCancelQuoteForOrder(order)
    }

    if (action === 'cancelOrder') {
      const clientRequestId = getClientRequestId(data)
      const { order } = await requireClientOrder(openid, data.orderId, '无权取消订单')
      if (order.status === 'cancelled') return { orderId: data.orderId, status: 'cancelled', refundStatus: order.refundStatus || '', refundAmount: Number(order.refundAmount || 0), refundNo: order.refundNo || '' }
      if (order.status === 'pending_pay') {
        const cancelled = await cancelUnpaidOrder(order, { reason: data.reason || '宠物主取消', actorRole: 'client' })
        if (!cancelled) throw new Error('支付或订单状态已更新，请刷新后重新取消')
        return { orderId: data.orderId, status: 'cancelled', refundAmount: 0, refundStatus: '', refundNo: '' }
      }
      assertOrderTransition(order.status, ORDER_STATUS.CANCELLED, '订单状态不可取消')
      const quote = getCancelQuoteForOrder(order)
      if (!quote.canCancel) throw new Error(quote.ruleText)
      const time = now()
      const update = { status: 'cancelled', cancelReason: data.reason || '', refundStatus: quote.refundStatus, refundAmount: quote.refundAmount, canceledAt: time, updatedAt: time }
      let refund = null
      if (order.paymentStatus === 'paid' && quote.refundAmount > 0) {
        refund = await createRefundForOrder(order, quote.refundAmount, data.reason || '宠物主取消', 'client_cancel', openid, clientRequestId, { cancelStatus: 'cancelled' })
        update.paymentStatus = 'refunding'
        update.refundNo = refund.refundNo
      }
      if (!refund) await updateOrderWhenStatus(data.orderId, order.status, update, '订单状态不可取消')
      if (order.couponId) {
        if (!refund || quote.refundAmount >= Number(order.payAmount || 0)) {
          if (typeof restoreOrderCoupon === 'function') {
            await restoreOrderCoupon(order.couponId, data.orderId)
          } else {
            const couponRes = await db.collection('user_coupons').doc(order.couponId).get().catch(() => ({ data: null }))
            const coupon = couponRes && couponRes.data
            if (coupon && ['locked', 'used'].includes(coupon.status)) {
              await db.collection('user_coupons').doc(order.couponId).update({
                data: { status: 'available', lockedOrderId: '', lockedAt: null, usedOrderId: '', usedAt: null, updatedAt: time }
              })
            }
          }
        }
      }
      const cancelledOrder = { ...order, _id: data.orderId, ...update }
      await appendOrderTimeline(data.orderId, 'cancelled', '订单已取消', `${quote.ruleText}，预计退款 ¥${quote.refundAmount}`, 'client')
      await appendOrderClientMessage(cancelledOrder, { eventType: 'cancelled', title: '订单已取消', detail: `${quote.ruleText}，预计退款 ¥${quote.refundAmount}`, actorRole: 'client', unreadForClient: false })
      if (refund) await appendOrderTimeline(data.orderId, 'refund_processing', '退款处理中', `退款金额 ¥${quote.refundAmount}`, 'system')
      return { orderId: data.orderId, status: 'cancelled', refundStatus: quote.refundStatus, refundAmount: quote.refundAmount, refundNo: refund ? refund.refundNo : '' }
    }

    if (action === 'requestEarlyStart') {
      const { user, order } = await requireStaffOrder(openid, data.id || data.orderId, '不是该订单员工')
      if (!['assigned', 'in_service', 'day_completed'].includes(order.status)) throw new Error('当前订单不可申请提前开始')
      if (!isBeforeServiceStart(order)) throw new Error('已到预约时间，无需申请提前开始')
      const existing = await getPendingEarlyStart(order._id)
      if (existing) return toEarlyStartView(existing)
      const time = now()
      const request = {
        orderId: order._id,
        orderNo: order.orderNo || '',
        clientOpenid: order.clientOpenid,
        staffOpenid: openid,
        staffUserId: user._id,
        status: 'pending',
        reason: safeText(data.reason).trim() || '宠护师已到达，申请提前开始服务',
        createdAt: time,
        updatedAt: time
      }
      const created = await db.collection('order_early_start_requests').add({ data: request })
      await appendOrderTimeline(order._id, 'early_start_requested', '宠护师申请提前开始', request.reason, 'staff')
      await appendOrderClientMessage(order, { eventType: 'early_start_requested', title: '宠护师申请提前开始', detail: request.reason, actorRole: 'staff' })
      await notifyOrder(order.clientOpenid, 'serviceStart', order, {
        statusText: '待确认提前开始',
        tip: '宠护师已到达，申请提前开始服务，请点击确认'
      }, 'client')
      return toEarlyStartView({ _id: created._id, ...request })
    }

    if (action === 'approveEarlyStart' || action === 'rejectEarlyStart') {
      const { order } = await requireClientOrder(openid, data.id || data.orderId, '仅宠物主可处理提前开始申请')
      const request = await getPendingEarlyStart(order._id)
      if (!request) throw new Error('暂无待处理的提前开始申请')
      const approved = action === 'approveEarlyStart'
      const time = now()
      const update = { status: approved ? 'approved' : 'rejected', clientRemark: safeText(data.remark).trim(), updatedAt: time }
      if (approved) update.approvedAt = time
      else update.rejectedAt = time
      await db.collection('order_early_start_requests').doc(request._id).update({ data: update })
      await appendOrderTimeline(order._id, approved ? 'early_start_approved' : 'early_start_rejected', approved ? '宠物主已同意提前开始' : '宠物主已拒绝提前开始', update.clientRemark, 'client')
      await appendOrderStaffMessage(order, {
        eventType: approved ? 'early_start_approved' : 'early_start_rejected',
        title: approved ? '宠物主已同意提前开始' : '宠物主已拒绝提前开始',
        detail: approved ? '宠物主已同意提前开始服务，现在可以开始服务。' : '宠物主已拒绝提前开始服务，请按预约时间开始。',
        actorRole: 'client',
        idempotencyKey: makeIdempotencyKey('order_staff_message', order._id, approved ? 'early_start_approved' : 'early_start_rejected', request._id)
      })
      await notifyOrder(order.staffOpenid, 'serviceStart', order, {
        statusText: approved ? '已同意提前开始' : '已拒绝提前开始',
        tip: approved ? '宠物主已同意提前开始服务，可以开始服务' : '宠物主已拒绝提前开始服务，请按原约定时间开始'
      }, 'staff')
      return toEarlyStartView({ ...request, ...update })
    }

    if (action === 'getEarlyStartStatus') {
      await getOrderForAccess(openid, data.id || data.orderId)
      const request = await getPendingEarlyStart(data.id || data.orderId) || await getApprovedEarlyStart(data.id || data.orderId) || await getLatestEarlyStart(data.id || data.orderId)
      return toEarlyStartView(request)
    }

    if (action === 'getActiveService') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) return null
      const active = await findActiveStaffService(openid)
      if (!active) return null
      return {
        orderId: active._id,
        orderNo: active.orderNo || '',
        petName: active.petName || '',
        serviceSummary: active.serviceSummary || '',
        currentSessionStartedAt: active.currentSessionStartedAt || active.startedAt || '',
        activeSessionIndex: active.activeSessionIndex || 1,
        sessionCount: active.sessionCount || normalizeServiceSessions(active).length || 1
      }
    }

    if (action === 'checkServiceTimeReadyForCheckin') {
      const { order } = await requireStaffOrder(openid, data.id || data.orderId, '不是该订单员工')
      if (![ORDER_STATUS.ASSIGNED, ORDER_STATUS.DAY_COMPLETED].includes(order.status)) throw new Error('当前订单状态不可进行服务前打卡')
      const time = now()
      const session = getNextPendingServiceSession({ ...order, _id: data.id || data.orderId }, time)
      if (!session) throw new Error('暂无可开始的当天服务任务')
      if (!(await canStartOrderSession({ ...order, _id: data.id || data.orderId }, session, time))) throw new Error('服务时间未到，可申请提前开始')
      return { canStart: true, session }
    }

    if (action === 'checkStartServiceReadiness') {
      const { order } = await requireStaffOrder(openid, data.id, '不是该订单员工')
      const time = now()
      const readiness = {
        canStart: true,
        issues: [],
        order: { id: data.id, status: order.status }
      }

      // 检查订单状态
      if (order.status === 'in_service') {
        readiness.canStart = false
        readiness.issues.push({ type: 'already_started', message: '服务已开始' })
        return readiness
      }

      if (![ORDER_STATUS.ASSIGNED, ORDER_STATUS.DAY_COMPLETED].includes(order.status)) {
        readiness.canStart = false
        readiness.issues.push({ type: 'wrong_status', message: '订单状态不可开始' })
        return readiness
      }

      const activeConflict = await findActiveStaffService(openid, data.id)
      if (activeConflict) {
        readiness.canStart = false
        readiness.issues.push({ type: 'active_service_conflict', message: '当前已有订单正在服务中，请先完成该订单后再开始新的服务', orderId: activeConflict._id, orderNo: activeConflict.orderNo || '', petName: activeConflict.petName || '' })
        return readiness
      }

      const currentSession = getNextPendingServiceSession({ ...order, _id: data.id }, time)
      if (!currentSession) {
        readiness.canStart = false
        readiness.issues.push({ type: 'no_session', message: '暂无可开始的当天服务任务' })
        return readiness
      }

      // 检查服务时间
      if (!(await canStartOrderSession({ ...order, _id: data.id }, currentSession, time))) {
        readiness.canStart = false
        readiness.issues.push({ type: 'time_not_ready', message: '服务时间未到，可申请提前开始' })
      }

      // 检查位置
      const currentLat = Number(data.currentLatitude)
      const currentLng = Number(data.currentLongitude)
      if (!hasCoordinate(currentLat, currentLng)) {
        readiness.canStart = false
        readiness.issues.push({ type: 'no_location', message: '请允许获取当前位置' })
      } else {
        const orderLat = Number(order.serviceLatitude || order.addressLatitude || 0)
        const orderLng = Number(order.serviceLongitude || order.addressLongitude || 0)
        if (hasCoordinate(orderLat, orderLng)) {
          const distanceToService = calcDistanceKm(currentLat, currentLng, orderLat, orderLng)
          const maxStartDistanceKm = 0.5
          if (distanceToService !== null && distanceToService > maxStartDistanceKm) {
            readiness.canStart = false
            readiness.issues.push({
              type: 'too_far',
              message: `请到达服务地址附近再开始服务（当前距离约 ${formatDistance(distanceToService)}）`,
              distance: distanceToService
            })
          }
        }
      }

      // 检查消毒打卡
      if (requiresSanitization(order)) {
        try {
          await requireSanitizationEvidence({ ...order, _id: data.id }, time)
        } catch (error) {
          readiness.canStart = false
          readiness.issues.push({
            type: 'missing_sanitization',
            message: error.message || '请先完成消毒拍照打卡'
          })
        }
      }

      return readiness
    }

    if (action === 'startService') {
      const { order } = await requireStaffOrder(openid, data.id, '不是该订单员工')
      if (order.status === 'in_service') return { id: data.id, status: order.status }
      assertOrderTransition(order.status, ORDER_STATUS.IN_SERVICE, '订单状态不可开始')
      const time = now()
      const activeConflict = await findActiveStaffService(openid, data.id)
      if (activeConflict) throw new Error(`当前已有订单正在服务中，请先完成${activeConflict.petName ? activeConflict.petName + '的' : ''}订单后再开始新的服务`)
      const currentSession = getNextPendingServiceSession({ ...order, _id: data.id }, time)
      if (!currentSession) throw new Error('暂无可开始的当天服务任务')
      if (!(await canStartOrderSession({ ...order, _id: data.id }, currentSession, time))) throw new Error('服务时间未到，可申请提前开始')

      await requireSanitizationEvidence({ ...order, _id: data.id }, time)

      const currentLat = Number(data.currentLatitude)
      const currentLng = Number(data.currentLongitude)
      const orderLat = Number(order.serviceLatitude || order.addressLatitude || 0)
      const orderLng = Number(order.serviceLongitude || order.addressLongitude || 0)
      let distanceToService = 0
      if (hasCoordinate(currentLat, currentLng) && hasCoordinate(orderLat, orderLng)) {
        distanceToService = calcDistanceKm(currentLat, currentLng, orderLat, orderLng)
        const maxStartDistanceKm = 0.5 // 500米
        if (distanceToService !== null && distanceToService > maxStartDistanceKm) {
          throw new Error(`请到达服务地址附近再开始服务（当前距离约 ${formatDistance(distanceToService)}）`)
        }
      }

      const serviceSessions = markServiceSession(normalizeServiceSessions(order), currentSession.index, { status: 'in_service', startedAt: time, finishedAt: '' })
      const startServiceUpdate = {
        status: ORDER_STATUS.IN_SERVICE,
        startedAt: order.startedAt || time,
        currentSessionStartedAt: time,
        activeSessionIndex: currentSession.index,
        activeSessionDate: currentSession.date,
        serviceSessions,
        updatedAt: time
      }
      if (hasCoordinate(currentLat, currentLng)) {
        startServiceUpdate.startLocationLatitude = currentLat
        startServiceUpdate.startLocationLongitude = currentLng
      }
      if (distanceToService !== null && !isNaN(distanceToService)) {
        startServiceUpdate.startDistanceKm = distanceToService
      }

      await updateOrderWhenStatus(data.id, order.status, startServiceUpdate, '订单状态不可开始服务')
      const startedOrder = { ...order, _id: data.id, status: ORDER_STATUS.IN_SERVICE, currentSessionStartedAt: time, serviceSessions, updatedAt: time }
      await appendOrderTimeline(data.id, 'started', currentSession.index > 1 ? `第${currentSession.index}天服务已开始` : '服务已开始', '', 'staff')
      await appendOrderClientMessage(startedOrder, { eventType: 'started', title: currentSession.index > 1 ? `第${currentSession.index}天服务已开始` : '服务已开始', detail: '宠护师已开始服务', actorRole: 'staff' })
      await notifyOrder(order.clientOpenid, 'serviceStart', order, { statusText: '服务中' })
      return { id: data.id, status: ORDER_STATUS.IN_SERVICE, activeSessionIndex: currentSession.index, currentSessionStartedAt: time }
    }

    if (action === 'finishService') {
      const { order } = await requireStaffOrder(openid, data.id, '不是该订单员工')
      if (order.status === 'completed') {
        await ensureStaffEarning(order, order.completedAt || order.updatedAt || now())
        const rewardResult = await ensureOrderCompletionRewards(order, now())
        return { id: data.id, completedOrderCount: rewardResult.completedOrderCount }
      }
      assertOrderTransition(order.status, ORDER_STATUS.COMPLETED, '订单状态不可完成')
      const activeSession = getActiveServiceSession(order) || getTodayServiceSession(order, order.currentSessionStartedAt || order.startedAt || now()) || normalizeServiceSessions(order)[0] || { index: 1, date: beijingDateKey(order.startedAt || now()), startedAt: order.currentSessionStartedAt || order.startedAt || '' }
      const sessionStartedAt = toTimeValue(order.currentSessionStartedAt || (activeSession && activeSession.startedAt) || order.startedAt)
      const checkinResult = await evaluateCheckinCompletion({ ...order, _id: data.id }, sessionStartedAt)
      if (!checkinResult.isComplete) {
        throw new Error(`缺少必打卡照片：${checkinResult.missing.join('、')}`)
      }
      return completeOrderService({ ...order, _id: data.id }, activeSession, now(), { isAuto: false, actor: 'staff' })
    }

    if (action === 'checkOverdueOrders') {
      await requireAdmin(openid)
      const unstarted = await processOverdueUnstartedOrders()
      const unfinished = await processOverdueUnfinishedOrders()
      return { unstartedCount: unstarted.length, unfinishedCount: unfinished.length, unstarted, unfinished }
    }

    if (action === 'getServiceReport') {
      const { order } = await requireServiceReportAccess(openid, data.id)
      const [tracks, checkins] = await Promise.all([
        readScopedDocuments('track_logs', { orderId: data.id }, 'recordedAt', 'asc'),
        readScopedDocuments('checkin_logs', { orderId: data.id }, 'createdAt', 'asc')
      ])
      return { order: toServiceReportOrder(order), tracks: filterTrackPoints(tracks), checkins: checkins.filter(isActiveCheckin) }
    }
    if (action === 'listPublicCompletedOrders') {
      const serviceType = safeText(data.serviceType).trim()
      const wantsPage = data.page !== undefined
      const page = Math.max(Math.floor(Number(data.page) || 1), 1)
      const pageSize = Math.min(Math.max(Math.floor(Number(data.pageSize || 20)), 1), wantsPage ? 100 : 50)
      const start = wantsPage ? (page - 1) * pageSize : 0
      const targetCount = start + pageSize + 1
      const chunkSize = Math.max(pageSize + 1, 50)
      let offset = 0
      let candidates = []
      let hasMoreSource = true
      while (candidates.length < targetCount && hasMoreSource) {
        const batch = (await db.collection('orders').where({ status: ORDER_STATUS.COMPLETED }).orderBy('completedAt', 'desc').skip(offset).limit(chunkSize).get()).data || []
        hasMoreSource = batch.length === chunkSize
        offset += batch.length
        candidates = candidates.concat(batch.filter((order) => !isAdminDeletedOrder(order) && (!serviceType || order.serviceType === serviceType || (Array.isArray(order.serviceTypes) && order.serviceTypes.includes(serviceType)))))
        if (!batch.length) break
      }
      const pageList = candidates.slice(start, start + pageSize)
      const hasMore = candidates.length > start + pageSize || hasMoreSource
      const pageData = wantsPage ? { list: pageList, total: hasMore ? start + pageList.length + 1 : start + pageList.length, page, pageSize, hasMore } : { list: pageList }
      const orderIds = pageData.list.map((order) => order._id).filter(Boolean)
      const staffProfileIds = [...new Set(pageData.list.map((order) => order.staffProfileId || order.requestedStaffProfileId).filter(Boolean))]
      const clientOpenids = [...new Set(pageData.list.map((order) => order.clientOpenid).filter(Boolean))]
      const inCommand = db.command && typeof db.command.in === 'function' ? db.command.in.bind(db.command) : null
      const [reviews, checkins, staffProfiles, users] = await Promise.all([
        orderIds.length ? safeCollectionData('service_reviews', (col) => inCommand ? col.where({ status: 'visible', orderId: inCommand(orderIds) }) : col.where({ status: 'visible' })) : Promise.resolve([]),
        orderIds.length ? safeCollectionData('checkin_logs', (col) => inCommand ? col.where({ orderId: inCommand(orderIds) }) : col) : Promise.resolve([]),
        staffProfileIds.length ? safeCollectionData('staff_profiles', (col) => inCommand ? col.where({ _id: inCommand(staffProfileIds) }) : col) : Promise.resolve([]),
        clientOpenids.length ? safeCollectionData('users', (col) => inCommand ? col.where({ openid: inCommand(clientOpenids) }) : col) : Promise.resolve([])
      ])
      const reviewMap = reviews
        .filter((review) => orderIds.includes(review.orderId))
        .reduce((map, review) => ({ ...map, [review.orderId]: review }), {})
      const checkinMap = checkins
        .filter((checkin) => orderIds.includes(checkin.orderId))
        .reduce((map, checkin) => ({ ...map, [checkin.orderId]: [...(map[checkin.orderId] || []), checkin] }), {})
      const staffProfileMap = staffProfiles.reduce((map, profile) => ({ ...map, [profile._id]: profile }), {})
      const userMap = users.reduce((map, user) => ({ ...map, [user.openid]: user }), {})
      const list = await Promise.all(pageData.list.map(async (order) => {
        const displayOrder = await attachClientSnapshot(order)
        return toHomeOrderActivity(displayOrder, {
          review: reviewMap[order._id] || null,
          checkins: (checkinMap[order._id] || []).filter(isActiveCheckin).sort((a, b) => toTimeValue(a.createdAt || a.recordedAt) - toTimeValue(b.createdAt || b.recordedAt)),
          staffProfile: staffProfileMap[order.staffProfileId || order.requestedStaffProfileId] || {},
          hideCheckinPhotos: shouldHidePublicCheckinPhotos(userMap[order.clientOpenid])
        })
      }))
      return wantsPage ? { ...pageData, list } : list
    }
    if (action === 'getPublicCompletedOrderDetail') {
      const orderId = safeText(data.id || data.orderId).trim()
      if (!orderId) throw new Error('订单不可查看')
      const orderRes = await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))
      const order = orderRes && orderRes.data
      if (!order || order.status !== ORDER_STATUS.COMPLETED) throw new Error('订单不可查看')
      const [reviewRes, checkinsRes, clientRes] = await Promise.all([
        db.collection('service_reviews').where({ orderId, status: 'visible' }).limit(1).get(),
        readScopedDocuments('checkin_logs', { orderId }, 'createdAt', 'asc'),
        order.clientOpenid ? db.collection('users').where({ openid: order.clientOpenid }).limit(1).get() : Promise.resolve({ data: [] })
      ])
      const staffProfileId = order.staffProfileId || order.requestedStaffProfileId || ''
      let staffProfile = {}
      if (staffProfileId) {
        const staffRes = await db.collection('staff_profiles').doc(staffProfileId).get().catch(() => ({ data: null }))
        staffProfile = (staffRes && staffRes.data) || {}
      }
      const displayOrder = await attachClientSnapshot(order)
      return toHomeOrderActivity(displayOrder, {
        review: reviewRes.data[0] || null,
        checkins: checkinsRes.filter(isActiveCheckin),
        staffProfile,
        hideCheckinPhotos: shouldHidePublicCheckinPhotos(clientRes.data[0])
      })
    }
    throw new Error('未知 order 操作')
  }
}
