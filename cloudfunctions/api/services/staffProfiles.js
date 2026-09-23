module.exports = function createService({
  db,
  formatWeeklyScheduleText,
  hasCoordinate,
  isAdminDeletedOrder,
  normalizeStaffWorkflow,
  normalizeWeeklySchedule,
  safeFileId,
  safeText
}) {
  async function getStaffProfileByOpenid(openid) {
    const res = await db.collection('staff_profiles').where({ openid }).limit(1).get()
    return normalizeStaffWorkflow(res.data[0] || null)
  }

  async function getCompletedStaffOrders(staffOpenid, limit = 0) {
    const list = []
    let offset = 0
    const pageSize = limit > 0 ? Math.min(limit, 100) : 100
    while (true) {
      const res = await db.collection('orders').where({ staffOpenid, status: 'completed' }).orderBy('completedAt', 'desc').orderBy('_id', 'asc').skip(offset).limit(pageSize).get()
      const page = (res.data || []).filter((order) => !isAdminDeletedOrder(order))
      list.push(...page)
      if (limit > 0 && list.length >= limit) return list.slice(0, limit)
      if ((res.data || []).length < pageSize) return list
      offset += pageSize
    }
  }

  function splitServiceAreas(value) {
    return String(value || '')
      .split(/[、,，\s\n]+/)
      .map((item) => item.trim())
      .filter(Boolean)
  }

  function maskStaffName(value) {
    const name = String(value || '').trim()
    if (!name) return '认证宠托师'
    return name.length <= 1 ? `${name}宠托师` : `${name.slice(0, 1)}* 宠托师`
  }

  function sitterDisplayName(profile) {
    const nickname = String(profile.nickname || '').trim()
    return nickname || maskStaffName(profile.realName)
  }

  function maskServiceAddress(value) {
    const text = String(value || '').trim()
    if (!text) return ''
    const pattern = /(\d+[-—_号栋幢弄室单元层楼A-Za-z0-9]+.*$)/
    if (pattern.test(text)) {
      return text.replace(pattern, '***')
    }
    if (text.length > 10) {
      return `${text.slice(0, 6)}***`
    }
    return text
  }

  function resolvePublicAddress(profile) {
    if (!profile) return ''
    const pub = safeText(profile.publicServiceAddress).trim()
    if (pub) return pub
    const raw = safeText(profile.serviceAddress).trim()
    if (raw) return maskServiceAddress(raw)
    const city = safeText(profile.serviceCity).trim()
    const areas = splitServiceAreas(profile.serviceAreas)
    if (city && areas.length) return `${city} ${areas[0]}`
    return city || ''
  }

  function toPublicSitter(profile) {
    const normalized = normalizeStaffWorkflow(profile)
    const isIntern = normalized && normalized.staffLevel === 'intern'
    const staffLevel = (normalized && normalized.staffLevel) || 'certified'
    const staffLevelText = isIntern ? '实习宠托师' : '认证宠托师'
    const areaTags = splitServiceAreas(profile.serviceAreas)
    const radius = Math.max(Number(profile.serviceRadiusKm || 5), 1)
    const hasLoc = hasCoordinate(profile.serviceLatitude, profile.serviceLongitude) && Boolean(profile.serviceAddress)
    const defaultTags = isIntern ? ['实习特惠', '平台审核', '可上门'] : ['已实名', '平台审核', '可上门']
    const publicAddress = resolvePublicAddress(profile)
    return {
      _id: profile._id,
      displayName: sitterDisplayName(profile),
      avatarUrl: safeFileId(profile.avatarUrl) || safeText(profile.avatarUrl),
      serviceCity: profile.serviceCity || '服务城市待完善',
      serviceAreas: profile.serviceAreas || '',
      serviceAddress: publicAddress,
      publicServiceAddress: safeText(profile.publicServiceAddress).trim(),
      serviceRadiusKm: radius,
      hasServiceAddress: hasLoc,
      weeklySchedule: normalizeWeeklySchedule(profile.weeklySchedule),
      weeklyScheduleText: formatWeeklyScheduleText(profile.weeklySchedule),
      areaTags,
      publicTags: defaultTags,
      staffLevel,
      staffLevelText,
      isIntern,
      serviceSummary: areaTags.length ? `可服务：${areaTags.slice(0, 4).join('、')}` : '服务区域待完善',
      ratingAverage: Number(profile.ratingAverage || 0),
      reviewCount: Number(profile.reviewCount || 0),
      ratingUpdatedAt: profile.ratingUpdatedAt || '',
      isFeatured: profile.isFeatured === true,
      featuredAt: profile.featuredAt || '',
      createdAt: profile.createdAt || '',
      updatedAt: profile.updatedAt || profile.createdAt || ''
    }
  }

  async function withSitterUserProfile(profile) {
    const res = await db.collection('users').where({ openid: profile.openid }).limit(1).get()
    const user = res.data[0] || {}
    return {
      ...profile,
      nickname: user.nickname || profile.nickname || '',
      avatarUrl: user.avatarUrl || profile.avatarUrl || ''
    }
  }

  return {
    getStaffProfileByOpenid,
    getCompletedStaffOrders,
    splitServiceAreas,
    maskStaffName,
    maskServiceAddress,
    resolvePublicAddress,
    sitterDisplayName,
    toPublicSitter,
    withSitterUserProfile
  }
}
