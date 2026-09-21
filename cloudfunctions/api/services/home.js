module.exports = function createService({
  VISIT_FEE_SERVICE_KEY,
  attachClientSnapshot,
  calcDistanceKm,
  canTakeOrders,
  checkinEventText,
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
    const checkinPhotos = hideCheckinPhotos ? [] : checkins
      .map((item) => ({
        _id: item._id || `${order._id}_${item.eventType || 'checkin'}`,
        eventType: item.eventType || '',
        eventText: checkinEventText(item.eventType),
        mediaFileId: safeFileId(item.watermarkedMediaFileId || item.mediaFileId) || safeText(item.watermarkedMediaFileId || item.mediaFileId),
        createdAt: item.createdAt || item.recordedAt || ''
      }))
      .filter((item) => item.mediaFileId)
      .slice(0, 3)

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
      checkinCount: checkins.length,
      checkinSummary: checkins.slice(0, 4).map((item) => checkinEventText(item.eventType)).join(' · '),
      checkinPhotos,
      checkinPhotosHidden: hideCheckinPhotos
    }
  }

  async function getHomePageData(openid, data = {}) {
    const settings = await getSystemSettings()
    const loc = {
      latitude: Number(data.latitude || 0),
      longitude: Number(data.longitude || 0)
    }
    const hasLoc = hasCoordinate(loc.latitude, loc.longitude)
    const [servicePrices, staffProfiles, couponTemplates, orders, optionalUser, userCoupons, users] = await Promise.all([
      listServicePrices(false),
      safeCollectionData('staff_profiles', (col) => col.where({ auditStatus: 'approved' }).orderBy('updatedAt', 'desc')),
      safeCollectionData('coupon_templates', (col) => col.where({ enabled: true }).orderBy('sortOrder', 'asc')),
      safeCollectionData('orders', (col) => col.orderBy('createdAt', 'desc')),
      getOptionalUser(openid).catch(() => null),
      openid ? safeCollectionData('user_coupons', (col) => col.where({ openid })) : Promise.resolve([]),
      safeCollectionData('users')
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

    const userOrders = optionalUser ? orders.filter((order) => order.clientOpenid === openid) : []
    const repeatOrder = userOrders.find((order) => ['paid', 'assigned', 'in_service', 'completed'].includes(order.status)) || null
    const completedOrders = orders
      .filter((order) => order.status === 'completed')
      .sort((a, b) => toTimeValue(b.completedAt || b.updatedAt || b.createdAt) - toTimeValue(a.completedAt || a.updatedAt || a.createdAt))
      .slice(0, 6)
    const recentOrderIds = completedOrders.map((order) => order._id).filter(Boolean)
    const [homeReviews, homeCheckins] = await Promise.all([
      recentOrderIds.length ? safeCollectionData('service_reviews', (col) => col.where({ status: 'visible' })) : Promise.resolve([]),
      recentOrderIds.length ? safeCollectionData('checkin_logs') : Promise.resolve([])
    ])
    const reviewMap = homeReviews
      .filter((review) => recentOrderIds.includes(review.orderId))
      .reduce((map, review) => ({ ...map, [review.orderId]: review }), {})
    const checkinMap = homeCheckins
      .filter((checkin) => recentOrderIds.includes(checkin.orderId))
      .reduce((map, checkin) => ({ ...map, [checkin.orderId]: [...(map[checkin.orderId] || []), checkin] }), {})
    const staffProfileMap = staffProfiles.reduce((map, profile) => ({ ...map, [profile._id]: profile }), {})
    const userMap = users.reduce((map, user) => ({ ...map, [user.openid]: user }), {})
    const recentOrders = (await Promise.all(completedOrders.map(attachClientSnapshot)))
      .map((order) => toHomeOrderActivity(order, {
        review: reviewMap[order._id],
        checkins: (checkinMap[order._id] || []).sort((a, b) => toTimeValue(a.createdAt || a.recordedAt) - toTimeValue(b.createdAt || b.recordedAt)),
        staffProfile: staffProfileMap[order.staffProfileId || order.requestedStaffProfileId] || {},
        hideCheckinPhotos: shouldHidePublicCheckinPhotos(userMap[order.clientOpenid])
      }))

    const completedCount = orders.filter((order) => order.status === 'completed').length
    const reviewCount = await safeCollectionCount('service_reviews', { status: 'visible' })
    const newbieTemplates = couponTemplates.filter((coupon) => coupon.newbieOnly !== false)
    const newbieTemplateIds = new Set(newbieTemplates.map((coupon) => coupon._id).filter(Boolean))
    const claimedNewbieTemplateIds = new Set((userCoupons || [])
      .filter((coupon) => coupon.status !== 'void')
      .map((coupon) => coupon.templateId || (coupon.templateSnapshot && coupon.templateSnapshot.templateId))
      .filter(Boolean))
    const hasClaimedNewbieCoupon = Array.from(claimedNewbieTemplateIds).some((templateId) => newbieTemplateIds.has(templateId))
    const isNewUser = Boolean(optionalUser) && userOrders.length === 0
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
