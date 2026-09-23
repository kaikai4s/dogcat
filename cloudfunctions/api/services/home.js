module.exports = function createService({
  VISIT_FEE_SERVICE_KEY,
  attachClientSnapshot,
  calcDistanceKm,
  canTakeOrders,
  checkinEventText,
  db,
  formatDistance,
  formatHomeCount,
  formatHomeCoupon,
  getOptionalUser,
  getSystemSettings,
  hasCoordinate,
  listServicePrices,
  maskClientName,
  orderStatusText,
  publicOrderNo,
  safeCollectionCount,
  safeCollectionData,
  safeFileId,
  safeText,
  serviceIcons,
  sitterDisplayName,
  toPublicSitter,
  toTimeValue,
  withSitterUserProfile
}) {
  function shouldHidePublicCheckinPhotos(user = {}) {
    return user.hidePublicCheckinPhotos === true || (user.privacySettings && user.privacySettings.hidePublicCheckinPhotos === true)
  }

  function toHomeOrderActivity(order = {}, context = {}) {
    const review = context.review || null
    const checkins = Array.isArray(context.checkins) ? context.checkins : []
    const hideCheckinPhotos = context.hideCheckinPhotos === true
    const staffProfile = context.staffProfile || {}
    const clientSnapshot = order.clientSnapshot || {}
    // 1. 过滤并格式化所有有效打卡照片
    const validCheckinItems = hideCheckinPhotos ? [] : checkins
      .map((item, index) => {
        const mediaFileId = safeFileId(item.watermarkedMediaFileId || item.mediaFileId) || safeText(item.watermarkedMediaFileId || item.mediaFileId)
        if (!mediaFileId) return null
        const eventType = item.eventType || 'checkin'
        const eventText = checkinEventText(eventType) || '服务打卡'
        const rawTime = item.recordedAt || item.createdAt || ''
        let timeText = ''
        if (rawTime) {
          const parts = String(rawTime).split(' ')
          timeText = parts[1] ? parts[1].slice(0, 5) : String(rawTime).slice(-5)
        }
        return {
          _id: item._id || `${order._id}_${eventType}_${index}`,
          eventType,
          eventText,
          mediaFileId,
          timeText,
          remark: safeText(item.remark || item.note).trim(),
          createdAt: item.createdAt || item.recordedAt || ''
        }
      })
      .filter(Boolean)

    // 2. 按项目分组（保持打卡记录原有顺序）
    const sectionMap = new Map()
    for (const item of validCheckinItems) {
      if (!sectionMap.has(item.eventType)) {
        sectionMap.set(item.eventType, {
          eventType: item.eventType,
          eventText: item.eventText,
          photos: []
        })
      }
      sectionMap.get(item.eventType).photos.push(item)
    }

    const checkinSections = Array.from(sectionMap.values()).map((sec) => ({
      ...sec,
      photoCount: sec.photos.length,
      firstPhoto: sec.photos[0]
    }))

    // 3. 列表预览照片：提取每个项目打卡的第一张组合起来
    const checkinPhotos = checkinSections.map((sec) => sec.firstPhoto).filter(Boolean)

    const checkinCount = checkinSections.length || checkins.length
    const checkinSummary = checkinSections.map((item) => item.eventText).join(' · ') || checkins.slice(0, 4).map((item) => checkinEventText(item.eventType)).join(' · ')

    return {
      _id: order._id || '',
      orderTitle: publicOrderNo(order),
      serviceSummary: order.serviceSummary || order.serviceType || '上门宠护',
      petName: order.petName || '宠物',
      clientName: clientSnapshot.displayName || maskClientName(order.clientName || ''),
      staffName: sitterDisplayName(staffProfile) || order.staffName || '平台宠托师',
      staffProfileId: order.staffProfileId || order.requestedStaffProfileId || '',
      status: order.status || '',
      statusText: orderStatusText(order.status),
      startTime: order.startTime || '',
      completedAt: order.completedAt || order.updatedAt || order.createdAt || '',
      review: review ? {
        rating: Number(review.rating || 0),
        ratingText: `${Number(review.rating || 0)}.0`,
        content: safeText(review.content).trim(),
        tags: Array.isArray(review.tags) ? review.tags.slice(0, 4) : [],
        createdAt: review.createdAt || ''
      } : null,
      checkinCount,
      totalPhotoCount: validCheckinItems.length,
      checkinSummary,
      checkinPhotos,
      checkinSections,
      allCheckinPhotos: validCheckinItems,
      checkinPhotosHidden: hideCheckinPhotos
    }
  }

  function buildInOrEq(field, values) {
    if (!Array.isArray(values) || !values.length) return null
    if (values.length === 1) return { [field]: values[0] }
    const inVal = db && db.command && typeof db.command.in === 'function'
      ? db.command.in(values)
      : { $in: values }
    return { [field]: inVal }
  }

  async function getHomePageData(openid, data = {}) {
    const settings = await getSystemSettings()
    const loc = {
      latitude: Number(data.latitude || 0),
      longitude: Number(data.longitude || 0)
    }
    const hasLoc = hasCoordinate(loc.latitude, loc.longitude)

    // 第一批并发查询：条件与数量精准下推至数据库，杜绝全表扫描与内存 OOM
    const [
      servicePrices,
      staffProfiles,
      couponTemplates,
      optionalUser,
      userCoupons,
      completedOrdersRaw,
      completedCount,
      userOrders
    ] = await Promise.all([
      listServicePrices(false),
      safeCollectionData('staff_profiles', (col) => col.where({ auditStatus: 'approved' }).orderBy('updatedAt', 'desc')),
      safeCollectionData('coupon_templates', (col) => col.where({ enabled: true }).orderBy('sortOrder', 'asc')),
      getOptionalUser(openid).catch(() => null),
      openid ? safeCollectionData('user_coupons', (col) => col.where({ openid })) : Promise.resolve([]),
      // 条件与条数下推：仅查询最近完成的 6 笔订单，避免全量拉取全表
      safeCollectionData('orders', (col) => col.where({ status: 'completed' }).orderBy('createdAt', 'desc').limit(6)),
      // 数量统计下推：直接使用 count()，避免传输全量订单文档
      safeCollectionCount('orders', { status: 'completed' }),
      // 精确查询当前用户的最近订单（仅需前几条用于 repeatOrder 与 isNewUser 判断）
      openid
        ? safeCollectionData('orders', (col) => col.where({ clientOpenid: openid }).orderBy('createdAt', 'desc').limit(5))
        : Promise.resolve([])
    ])

    const sittersWithUser = await Promise.all(staffProfiles.filter((item) => canTakeOrders(item, settings.staffDeposit)).slice(0, 30).map(withSitterUserProfile))
    let featuredSitters = sittersWithUser.map((profile) => {
      const item = toPublicSitter(profile)
      if (hasLoc && hasCoordinate(profile.serviceLatitude, profile.serviceLongitude)) {
        const distanceKm = calcDistanceKm(loc.latitude, loc.longitude, profile.serviceLatitude, profile.serviceLongitude)
        return { ...item, distanceKm, distanceText: formatDistance(distanceKm) }
      }
      return item
    })
    featuredSitters.sort((a, b) => {
      const featuredDiff = Number(b.isFeatured === true) - Number(a.isFeatured === true)
      if (featuredDiff) return featuredDiff
      if (hasLoc) return (a.distanceKm ?? 9999) - (b.distanceKm ?? 9999) || Number(b.ratingAverage || 0) - Number(a.ratingAverage || 0)
      return Number(b.ratingAverage || 0) - Number(a.ratingAverage || 0) || Number(b.reviewCount || 0) - Number(a.reviewCount || 0)
    })
    featuredSitters = featuredSitters.slice(0, 6)

    const repeatOrder = (userOrders || []).find((order) => ['paid', 'assigned', 'in_service', 'completed'].includes(order.status)) || null
    const completedOrders = completedOrdersRaw
      .slice()
      .sort((a, b) => toTimeValue(b.completedAt || b.updatedAt || b.createdAt) - toTimeValue(a.completedAt || a.updatedAt || a.createdAt))
      .slice(0, 6)
    const recentOrderIds = completedOrders.map((order) => order._id).filter(Boolean)
    const recentClientOpenids = Array.from(new Set(completedOrders.map((order) => order.clientOpenid).filter(Boolean)))

    const orderIdCondition = buildInOrEq('orderId', recentOrderIds)
    const openidCondition = buildInOrEq('openid', recentClientOpenids)

    // 第二批并发查询：精准按这 6 笔完单关联查询，杜绝全表扫描打卡、评价与用户
    const [homeReviews, homeCheckins, recentUsers] = await Promise.all([
      orderIdCondition
        ? safeCollectionData('service_reviews', (col) => col.where({ status: 'visible', ...orderIdCondition }))
        : Promise.resolve([]),
      orderIdCondition
        ? safeCollectionData('checkin_logs', (col) => col.where(orderIdCondition))
        : Promise.resolve([]),
      openidCondition
        ? safeCollectionData('users', (col) => col.where(openidCondition))
        : Promise.resolve([])
    ])
    const reviewMap = homeReviews.reduce((map, review) => ({ ...map, [review.orderId]: review }), {})
    const checkinMap = homeCheckins.reduce((map, checkin) => ({
      ...map,
      [checkin.orderId]: [...(map[checkin.orderId] || []), checkin]
    }), {})
    const staffProfileMap = staffProfiles.reduce((map, profile) => ({ ...map, [profile._id]: profile }), {})
    const userMap = recentUsers.reduce((map, user) => ({ ...map, [user.openid]: user }), {})
    const recentOrders = (await Promise.all(completedOrders.map(attachClientSnapshot)))
      .map((order) => toHomeOrderActivity(order, {
        review: reviewMap[order._id],
        checkins: (checkinMap[order._id] || []).sort((a, b) => toTimeValue(a.createdAt || a.recordedAt) - toTimeValue(b.createdAt || b.recordedAt)),
        staffProfile: staffProfileMap[order.staffProfileId || order.requestedStaffProfileId] || {},
        hideCheckinPhotos: shouldHidePublicCheckinPhotos(userMap[order.clientOpenid])
      }))

    const reviewCount = await safeCollectionCount('service_reviews', { status: 'visible' })
    const newbieTemplates = couponTemplates.filter((coupon) => coupon.newbieOnly !== false)
    const newbieTemplateIds = new Set(newbieTemplates.map((coupon) => coupon._id).filter(Boolean))
    const claimedNewbieTemplateIds = new Set((userCoupons || [])
      .filter((coupon) => coupon.status !== 'void')
      .map((coupon) => coupon.templateId || (coupon.templateSnapshot && coupon.templateSnapshot.templateId))
      .filter(Boolean))
    const hasClaimedNewbieCoupon = Array.from(claimedNewbieTemplateIds).some((templateId) => newbieTemplateIds.has(templateId))
    const isNewUser = Boolean(optionalUser) && (userOrders || []).length === 0
    const newbieCoupons = isNewUser && !hasClaimedNewbieCoupon ? newbieTemplates : []

    return {
      settings: {
        homeHeroCarousel: settings.homeHeroCarousel,
        homePage: settings.homePage
      },
      servicePrices: servicePrices.filter((item) => item.key !== VISIT_FEE_SERVICE_KEY && item.enabled !== false && item.showOnHome === true).slice(0, 6).map((item) => ({
        ...item,
        icon: serviceIcons[item.key] || '🐾',
        priceText: `¥${item.price}起`
      })),
      featuredSitters,
      coupons: newbieCoupons.slice(0, 3).map(formatHomeCoupon),
      repeatOrder: repeatOrder ? {
        _id: repeatOrder._id,
        serviceSummary: repeatOrder.serviceSummary || '上门宠护',
        petName: repeatOrder.petName || '宠物',
        startTime: repeatOrder.startTime || '',
        staffProfileId: repeatOrder.staffProfileId || repeatOrder.requestedStaffProfileId || ''
      } : null,
      recentOrders,
      statsData: {
        completedCount: formatHomeCount(completedCount),
        sitterCount: formatHomeCount(staffProfiles.length),
        ratingCount: formatHomeCount(reviewCount)
      },
      assuranceItems: [
        { title: '实名认证', desc: '宠托师资料审核后上岗', icon: '✅' },
        { title: '轨迹打卡', desc: '服务过程位置和照片可追踪', icon: '📍' },
        { title: '售后保障', desc: '异常投诉有平台工单跟进', icon: '🛡️' }
      ]
    }
  }

  return {
    shouldHidePublicCheckinPhotos,
    toHomeOrderActivity,
    getHomePageData
  }
}
