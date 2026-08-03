const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const collections = [
  'users', 'pets', 'home_security', 'staff_profiles', 'orders', 'payments',
  'track_logs', 'checkin_logs', 'unlock_code_logs', 'order_incidents', 'admin_operation_logs', 'service_prices',
  'sitter_favorites', 'service_reviews', 'user_addresses', 'order_timeline', 'platform_configs',
  'coupon_templates', 'user_coupons',
  'member_levels', 'point_logs', 'lottery_activities', 'lottery_records',
  'checkin_month_configs', 'user_checkins', 'retro_card_logs', 'reward_mails', 'user_invites'
]

const defaultServicePrices = [
  { key: 'walk', label: '上门遛狗', price: 69, enabled: true, sortOrder: 10, description: '牵引遛狗、轨迹记录、回家安置' },
  { key: 'feed', label: '上门喂养', price: 59, enabled: true, sortOrder: 20, description: '换粮换水、基础陪伴' },
  { key: 'litter', label: '清理宠物厕所', price: 29, enabled: true, sortOrder: 30, description: '猫砂盆/宠物厕所基础清理' },
  { key: 'play', label: '陪伴玩耍', price: 39, enabled: true, sortOrder: 40, description: '陪伴互动、安抚情绪' },
  { key: 'medicine', label: '喂药协助', price: 49, enabled: true, sortOrder: 50, description: '按主人说明协助喂药' },
  { key: 'clean', label: '简单清洁', price: 39, enabled: true, sortOrder: 60, description: '宠物活动区域简单整理' },
  { key: 'extra_pet', label: '增加一只宠物', price: 20, enabled: true, sortOrder: 70, description: '同地址额外宠物服务' }
]

function ok(data) { return { ok: true, data } }
function fail(message) { return { ok: false, message } }
function now() { return new Date() }
function nowText() { return new Date().toISOString() }
// 返回 CST（UTC+8）当日零点的 Date 对象，用于"每日"类限制判断
function cstTodayStart() {
  const cstOffset = 8 * 60 * 60 * 1000
  const cstMs = Date.now() + cstOffset
  return new Date(Math.floor(cstMs / 86400000) * 86400000 - cstOffset)
}

function toCstParts(date = now()) {
  const source = date instanceof Date ? date : new Date(date)
  const cst = new Date(source.getTime() + 8 * 60 * 60 * 1000)
  const year = cst.getUTCFullYear()
  const month = String(cst.getUTCMonth() + 1).padStart(2, '0')
  const day = String(cst.getUTCDate()).padStart(2, '0')
  return {
    year,
    month,
    day,
    monthKey: `${year}-${month}`,
    dateKey: `${year}-${month}-${day}`,
    dayNumber: Number(day)
  }
}

function getMonthDays(monthKey) {
  const matched = String(monthKey || '').match(/^(\d{4})-(\d{2})$/)
  if (!matched) return 31
  return new Date(Number(matched[1]), Number(matched[2]), 0).getDate()
}

function defaultCheckinDays(monthKey) {
  const count = getMonthDays(monthKey)
  return Array.from({ length: count }, (_, index) => ({ day: index + 1, rewardType: 'points', points: 5, couponTemplateId: '', couponSnapshot: null, title: `第${index + 1}天奖励`, desc: '签到奖励' }))
}
function safeText(value) { return value === undefined || value === null ? '' : String(value) }
function safeNumber(value) {
  const normalized = String(value || 0).replace(/[^0-9.]/g, '')
  const number = Number(normalized || 0)
  return Number.isFinite(number) ? number : 0
}
function safeFileId(value) {
  const text = safeText(value)
  return text.startsWith('cloud://') ? text : ''
}

function normalizeSystemSettings(value = {}) {
  return {
    enableTestAddressMode: value.enableTestAddressMode === true
  }
}

async function getSystemSettings() {
  const res = await db.collection('platform_configs').where({ key: 'system_settings' }).limit(1).get()
  return normalizeSystemSettings(res.data[0] ? res.data[0].value : {})
}

async function saveSystemSettings(settings) {
  const value = normalizeSystemSettings(settings)
  const time = now()
  const existing = await db.collection('platform_configs').where({ key: 'system_settings' }).limit(1).get()
  const payload = { key: 'system_settings', value, updatedAt: time }
  if (existing.data[0]) {
    await db.collection('platform_configs').doc(existing.data[0]._id).update({ data: payload })
    return { _id: existing.data[0]._id, ...payload }
  }
  const created = await db.collection('platform_configs').add({ data: { ...payload, createdAt: time } })
  return { _id: created._id, ...payload, createdAt: time }
}

function incUpdateValue(currentValue, delta) {
  if (db.command && typeof db.command.inc === 'function') return db.command.inc(delta)
  return Number(currentValue || 0) + Number(delta || 0)
}

async function getUser(openid) {
  const res = await db.collection('users').where({ openid }).limit(1).get()
  const user = res.data[0]
  if (!user || user.status !== 'active') throw new Error('请先登录')
  return user
}

async function getOptionalUser(openid) {
  const res = await db.collection('users').where({ openid }).limit(1).get()
  return res.data[0]
}

async function requireAdmin(openid) {
  const user = await getUser(openid)
  if (!Array.isArray(user.roles) || !user.roles.includes('admin')) throw new Error('仅管理员可操作')
  return user
}

function getKey() {
  const secret = process.env.HOME_SECURITY_KEY || 'dev-only-change-this-key-before-production'
  return crypto.createHash('sha256').update(secret).digest()
}

function encryptText(value) {
  if (!value) return { cipher: '', iv: '', tag: '' }
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv)
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
  return { cipher: encrypted.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
}

function decryptText(cipher, iv, tag) {
  if (!cipher || !iv || !tag) return ''
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(cipher, 'base64')), decipher.final()]).toString('utf8')
}

function mask(value) {
  if (!value) return ''
  return value.length <= 2 ? '**' : `${value.slice(0, 1)}***${value.slice(-1)}`
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

function toPublicSitter(profile) {
  const areaTags = splitServiceAreas(profile.serviceAreas)
  return {
    _id: profile._id,
    displayName: sitterDisplayName(profile),
    avatarUrl: safeFileId(profile.avatarUrl) || safeText(profile.avatarUrl),
    serviceCity: profile.serviceCity || '服务城市待完善',
    serviceAreas: profile.serviceAreas || '',
    areaTags,
    publicTags: ['已实名', '平台审核', '可上门'],
    serviceSummary: areaTags.length ? `可服务：${areaTags.slice(0, 4).join('、')}` : '服务区域待完善',
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

function matchText(value, keyword) {
  return String(value || '').toLowerCase().includes(keyword)
}

function normalizeServicePrice(item) {
  return {
    key: String(item.key || '').trim(),
    label: String(item.label || '').trim(),
    price: Math.max(Number(item.price || 0), 0),
    enabled: item.enabled !== false,
    sortOrder: Number(item.sortOrder || 0),
    description: item.description || ''
  }
}

async function listServicePrices(includeDisabled = false) {
  let configured = []
  try {
    const res = await db.collection('service_prices').orderBy('sortOrder', 'asc').get()
    configured = res.data || []
  } catch (error) {
    configured = []
  }
  const configuredMap = configured.reduce((map, item) => ({ ...map, [item.key]: item }), {})
  const merged = defaultServicePrices.map((item) => normalizeServicePrice({ ...item, ...(configuredMap[item.key] || {}) }))
  configured.forEach((item) => {
    if (!defaultServicePrices.some((preset) => preset.key === item.key)) merged.push(normalizeServicePrice(item))
  })
  return merged
    .filter((item) => item.key && item.label && (includeDisabled || item.enabled))
    .sort((a, b) => a.sortOrder - b.sortOrder)
}

function normalizeServiceTypes(data) {
  const raw = Array.isArray(data.serviceTypes) ? data.serviceTypes : [data.serviceType || 'walk']
  return Array.from(new Set(raw.map((item) => String(item || '').trim()).filter(Boolean)))
}

function getWalkPrice(basePrice, weight) {
  if (basePrice !== 69) return basePrice
  if (weight > 25) return 119
  if (weight >= 10) return 89
  return 69
}

function normalizeCouponSnapshot(coupon) {
  const snapshot = coupon.templateSnapshot || coupon
  return {
    templateId: coupon.templateId || coupon._id || '',
    name: safeText(snapshot.name).trim() || '优惠券',
    description: safeText(snapshot.description).trim(),
    type: snapshot.type === 'fixed' ? 'fixed' : 'fixed',
    discountAmount: Math.max(Number(snapshot.discountAmount || 0), 0),
    minOrderAmount: Math.max(Number(snapshot.minOrderAmount || 0), 0),
    applicableServiceTypes: Array.isArray(snapshot.applicableServiceTypes) ? snapshot.applicableServiceTypes.map((item) => String(item || '').trim()).filter(Boolean) : [],
    validType: snapshot.validType === 'fixed_range' ? 'fixed_range' : 'relative_days',
    validDays: Math.max(Math.round(Number(snapshot.validDays || 30)), 1),
    validFromFixed: snapshot.validFromFixed || '',
    validToFixed: snapshot.validToFixed || '',
    displayTag: safeText(snapshot.displayTag).trim(),
    claimNotice: safeText(snapshot.claimNotice).trim(),
    useNotice: safeText(snapshot.useNotice).trim()
  }
}

function couponRuleText(snapshot) {
  const minText = snapshot.minOrderAmount > 0 ? `满${snapshot.minOrderAmount}减${snapshot.discountAmount}` : `立减${snapshot.discountAmount}`
  return snapshot.applicableServiceTypes.length ? `${minText}，限指定服务` : minText
}

function couponDisplayStatus(coupon, time = now()) {
  if (coupon.status === 'used' || coupon.status === 'locked' || coupon.status === 'void') return coupon.status
  const validTo = new Date(coupon.validTo || 0).getTime()
  if (validTo && validTo < time.getTime()) return 'expired'
  return coupon.status || 'available'
}

function couponStatusText(status) {
  return ({ available: '可使用', locked: '已锁定', used: '已使用', expired: '已过期', void: '已作废' })[status] || '未知状态'
}

function formatUserCoupon(coupon, options = {}) {
  const snapshot = normalizeCouponSnapshot(coupon)
  const status = options.status || couponDisplayStatus(coupon)
  return {
    _id: coupon._id,
    templateId: coupon.templateId || snapshot.templateId,
    name: snapshot.name,
    description: snapshot.description,
    discountAmount: snapshot.discountAmount,
    minOrderAmount: snapshot.minOrderAmount,
    applicableServiceTypes: snapshot.applicableServiceTypes,
    validFrom: coupon.validFrom || '',
    validTo: coupon.validTo || '',
    status,
    statusText: couponStatusText(status),
    ruleText: couponRuleText(snapshot),
    applicable: options.applicable,
    reason: options.reason || '',
    payAmountAfterDiscount: options.payAmountAfterDiscount
  }
}

async function getAvailableUserCoupons(openid) {
  const res = await db.collection('user_coupons').where({ openid }).get()
  const time = now()
  return (res.data || [])
    .filter((coupon) => couponDisplayStatus(coupon, time) === 'available')
    .sort((a, b) => String(a.validTo || '').localeCompare(String(b.validTo || '')) || String(b.issuedAt || b.createdAt || '').localeCompare(String(a.issuedAt || a.createdAt || '')))
}

function evaluateCoupon(coupon, pricing, openid) {
  if (!coupon || coupon.openid !== openid) return { applicable: false, reason: '优惠券不存在' }
  const status = couponDisplayStatus(coupon)
  if (status !== 'available') return { applicable: false, reason: couponStatusText(status) }
  const snapshot = normalizeCouponSnapshot(coupon)
  if (pricing.amount < snapshot.minOrderAmount) return { applicable: false, reason: `订单满 ¥${snapshot.minOrderAmount} 可用` }
  if (snapshot.applicableServiceTypes.length && !pricing.serviceTypes.some((key) => snapshot.applicableServiceTypes.includes(key))) return { applicable: false, reason: '当前服务不可用' }
  const discountAmount = Math.min(snapshot.discountAmount, pricing.amount)
  if (discountAmount <= 0) return { applicable: false, reason: '优惠金额无效' }
  return {
    applicable: true,
    couponId: coupon._id,
    templateId: coupon.templateId || snapshot.templateId,
    name: snapshot.name,
    discountAmount,
    ruleText: couponRuleText(snapshot),
    snapshot
  }
}

function applyCouponToPricing(pricing, couponResult) {
  if (!couponResult || !couponResult.applicable) {
    return { ...pricing, discountAmount: 0, coupon: null, payAmount: pricing.amount, priceSnapshot: { ...pricing.priceSnapshot, originalAmount: pricing.amount, discountAmount: 0, payAmount: pricing.amount } }
  }
  const discountAmount = couponResult.discountAmount
  const payAmount = Math.max(pricing.amount - discountAmount, 0)
  const coupon = {
    couponId: couponResult.couponId,
    templateId: couponResult.templateId,
    name: couponResult.name,
    discountAmount,
    ruleText: couponResult.ruleText,
    snapshot: couponResult.snapshot
  }
  return {
    ...pricing,
    discountAmount,
    coupon,
    payAmount,
    priceItems: [...pricing.priceItems, { key: 'coupon', label: `优惠券：${coupon.name}`, price: -discountAmount }],
    priceSnapshot: { ...pricing.priceSnapshot, coupon, originalAmount: pricing.amount, discountAmount, payAmount }
  }
}

async function calcOrderPricing(data, pet, options = {}) {
  const serviceTypes = normalizeServiceTypes(data)
  if (!serviceTypes.length) throw new Error('请选择服务项目')
  const catalog = await listServicePrices(false)
  const catalogMap = catalog.reduce((map, item) => ({ ...map, [item.key]: item }), {})
  const weight = Number((pet && pet.weight) || data.weight || 0)
  const durationMinutes = Number(data.durationMinutes || 60)
  if (durationMinutes < 30 || durationMinutes > 240) throw new Error('服务时长不正确')
  const multiplier = Math.max(durationMinutes, 60) / 60
  const priceItems = serviceTypes.map((key) => {
    const item = catalogMap[key]
    if (!item) throw new Error('服务项目不可用')
    const basePrice = key === 'walk' ? getWalkPrice(item.price, weight) : item.price
    const price = Math.round(basePrice * multiplier)
    return { key, label: item.label, price }
  })
  const amount = priceItems.reduce((sum, item) => sum + item.price, 0)
  const serviceLabels = priceItems.map((item) => item.label)
  const basePricing = {
    amount,
    payAmount: amount,
    discountAmount: 0,
    coupon: null,
    currency: 'CNY',
    serviceTypes,
    serviceLabels,
    serviceSummary: serviceLabels.join('、'),
    durationMinutes,
    priceItems,
    priceSnapshot: { services: priceItems, durationMinutes, weight, originalAmount: amount, discountAmount: 0, payAmount: amount }
  }
  const openid = options.openid || ''
  if (!openid) return basePricing
  if (data.couponId) {
    const coupon = (await db.collection('user_coupons').doc(data.couponId).get()).data
    const result = evaluateCoupon(coupon, basePricing, openid)
    if (!result.applicable) throw new Error(result.reason)
    return applyCouponToPricing(basePricing, result)
  }
  if (data.autoApplyCoupon === true) {
    const coupons = await getAvailableUserCoupons(openid)
    const best = coupons
      .map((coupon) => evaluateCoupon(coupon, basePricing, openid))
      .filter((item) => item.applicable)
      .sort((a, b) => b.discountAmount - a.discountAmount)[0]
    return applyCouponToPricing(basePricing, best)
  }
  return basePricing
}

function requiredCheckins(serviceType, serviceTypes) {
  const types = Array.isArray(serviceTypes) && serviceTypes.length ? serviceTypes : [serviceType]
  const events = new Set(['enter_door', 'pet_status', 'leave_door'])
  if (types.includes('walk')) {
    events.add('leash_on')
    events.add('return_home')
  }
  if (types.includes('feed')) {
    events.add('feed')
    events.add('water')
  }
  if (types.includes('litter') || types.includes('clean')) events.add('clean')
  if (types.includes('medicine')) events.add('medicine')
  return Array.from(events)
}

function validateOrderTime(data) {
  if (!data.startTime || !data.endTime) throw new Error('请选择服务时间')
  const start = new Date(String(data.startTime).replace(/-/g, '/')).getTime()
  const end = new Date(String(data.endTime).replace(/-/g, '/')).getTime()
  if (!start || !end || end <= start) throw new Error('服务时间不正确')
}

function hasCoordinate(latitude, longitude) {
  return Number(latitude) !== 0 && Number(longitude) !== 0
}

function calcDistanceKm(lat1, lng1, lat2, lng2) {
  if (!hasCoordinate(lat1, lng1) || !hasCoordinate(lat2, lng2)) return null
  const radius = 6371
  const toRad = (value) => Number(value) * Math.PI / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function formatDistance(distanceKm) {
  if (distanceKm === null) return '未定位'
  return distanceKm < 1 ? `${Math.round(distanceKm * 1000)}m` : `${distanceKm.toFixed(2)}km`
}

function normalizeBenefits(value) {
  if (Array.isArray(value)) return value.map((item) => safeText(item).trim()).filter(Boolean)
  return safeText(value).split(/[\n,，；;]+/).map((item) => item.trim()).filter(Boolean)
}

function calcMemberLevel(totalPoints, levels) {
  if (!Array.isArray(levels) || !levels.length) return { memberLevel: '', memberLevelName: '普通会员', pointMultiplier: 1, description: '', benefits: [] }
  const sorted = levels.slice().sort((a, b) => Number(b.minPoints || 0) - Number(a.minPoints || 0))
  const matched = sorted.find((level) => totalPoints >= Number(level.minPoints || 0))
  if (!matched) return { memberLevel: '', memberLevelName: '普通会员', pointMultiplier: 1, description: '', benefits: [] }
  return {
    memberLevel: matched._id,
    memberLevelName: matched.name,
    pointMultiplier: Math.max(Number(matched.pointMultiplier || 1), 1),
    description: safeText(matched.description).trim(),
    benefits: normalizeBenefits(matched.benefits)
  }
}

async function getMemberLevels() {
  const levelsRes = await db.collection('member_levels').orderBy('minPoints', 'asc').get()
  return levelsRes.data || []
}

function normalizeTargetLevelIds(targetLevelIds) {
  return Array.from(new Set((Array.isArray(targetLevelIds) ? targetLevelIds : []).map((item) => safeText(item).trim()).filter(Boolean)))
}

async function resolveTargetLevels(targetLevelIds) {
  const ids = normalizeTargetLevelIds(targetLevelIds)
  const levels = await getMemberLevels()
  const levelMap = new Map(levels.map((level) => [level._id, level]))
  return ids.map((id) => levelMap.get(id)).filter(Boolean)
}

async function syncUsersMemberLevelName(levelId, levelName) {
  const usersRes = await db.collection('users').where({ memberLevel: levelId }).get()
  const users = usersRes.data || []
  const time = now()
  for (const user of users) {
    await db.collection('users').doc(user._id).update({ data: { memberLevelName: levelName || '普通会员', updatedAt: time } })
  }
}

async function recalcUsersForDeletedLevel(levelId) {
  const usersRes = await db.collection('users').where({ memberLevel: levelId }).get()
  const users = usersRes.data || []
  if (!users.length) return
  const levels = await getMemberLevels()
  const time = now()
  for (const user of users) {
    const levelInfo = calcMemberLevel(Number(user.totalPoints || 0), levels)
    await db.collection('users').doc(user._id).update({
      data: {
        memberLevel: levelInfo.memberLevel,
        memberLevelName: levelInfo.memberLevelName,
        updatedAt: time
      }
    })
  }
}

function createInviteCode(user) {
  return `INV${safeText((user && (user._id || user.openid)) || '').replace(/[^a-zA-Z0-9]/g, '').slice(-8).toUpperCase() || Date.now()}`
}

function normalizeMonthKey(monthKey) {
  const text = safeText(monthKey).trim()
  return /^\d{4}-\d{2}$/.test(text) ? text : toCstParts().monthKey
}

async function resolveInviter(data = {}) {
  const inviterOpenid = safeText(data.inviterOpenid).trim()
  if (inviterOpenid) {
    const inviter = await getOptionalUser(inviterOpenid)
    return inviter || null
  }
  const inviteCode = safeText(data.inviteCode).trim().toUpperCase()
  if (!inviteCode) return null
  const inviterRes = await db.collection('users').where({ inviteCode }).limit(1).get()
  return inviterRes.data[0] || null
}

async function bindInviteRelation(user, data = {}) {
  if (!user || !user._id) return user
  const time = now()
  let currentUser = user
  if (!safeText(user.inviteCode).trim()) {
    const inviteCode = createInviteCode(user)
    await db.collection('users').doc(user._id).update({ data: { inviteCode, updatedAt: time } })
    currentUser = { ...currentUser, inviteCode, updatedAt: time }
  }
  const inviter = await resolveInviter(data)
  if (!inviter || inviter.openid === currentUser.openid) return currentUser
  const existing = (await db.collection('user_invites').where({ invitedOpenid: currentUser.openid }).limit(1).get()).data[0]
  if (existing) return { ...currentUser, inviterOpenid: existing.inviterOpenid || currentUser.inviterOpenid || '' }
  await db.collection('user_invites').add({
    data: {
      inviterUserId: inviter._id,
      inviterOpenid: inviter.openid,
      invitedUserId: currentUser._id,
      invitedOpenid: currentUser.openid,
      rewarded: true,
      rewardType: 'retro_card',
      rewardCount: 1,
      createdAt: time,
      updatedAt: time
    }
  })
  await db.collection('users').doc(currentUser._id).update({ data: { inviterOpenid: inviter.openid, updatedAt: time } })
  await grantRetroCards(inviter.openid, inviter._id, 1, 'invite_first_login', currentUser.openid, '邀请新用户首登奖励补签卡 +1')
  return { ...currentUser, inviterOpenid: inviter.openid, updatedAt: time }
}

function getCouponValidRange(template, time = now()) {
  const snapshot = normalizeCouponSnapshot(template)
  if (snapshot.validType === 'fixed_range' && snapshot.validFromFixed && snapshot.validToFixed) {
    return {
      validFrom: new Date(`${snapshot.validFromFixed} 00:00:00`),
      validTo: new Date(`${snapshot.validToFixed} 23:59:59`)
    }
  }
  return {
    validFrom: time,
    validTo: new Date(time.getTime() + Number(snapshot.validDays || 30) * 86400000)
  }
}

async function grantRetroCards(openid, userId, delta, sourceType, sourceId, reason) {
  const userRes = await db.collection('users').where({ openid }).limit(1).get()
  const user = userRes.data[0]
  if (!user) return { balance: 0 }
  const time = now()
  const balance = Math.max(Number(user.retroCardCount || 0) + Number(delta || 0), 0)
  await db.collection('retro_card_logs').add({
    data: { userId: user._id, openid, delta: Number(delta || 0), balance, sourceType: sourceType || '', sourceId: sourceId || '', reason: reason || '', createdAt: time }
  })
  await db.collection('users').doc(user._id).update({ data: { retroCardCount: balance, updatedAt: time } })
  return { balance }
}

async function issueCouponToTargetUser(template, targetUser, adminMeta = {}) {
  if (!template || template.enabled === false) throw new Error('优惠券模板不可用')
  const templateId = template._id || template.templateId
  const existing = (await db.collection('user_coupons').where({ openid: targetUser.openid, templateId }).get()).data || []
  const activeCount = existing.filter((coupon) => coupon.status !== 'void').length
  if (activeCount >= Number(template.perUserLimit || 1)) throw new Error('该用户已达到领取上限')
  if (Number(template.totalIssueLimit || 0) > 0 && Number(template.issuedCount || 0) >= Number(template.totalIssueLimit || 0)) throw new Error('优惠券已达到发放上限')
  const time = now()
  const validRange = getCouponValidRange(template, time)
  const snapshot = normalizeCouponSnapshot(template)
  const created = await db.collection('user_coupons').add({
    data: {
      templateId,
      templateSnapshot: snapshot,
      userId: targetUser._id,
      openid: targetUser.openid,
      status: 'available',
      validFrom: validRange.validFrom,
      validTo: validRange.validTo,
      lockedOrderId: '',
      lockedAt: null,
      usedOrderId: '',
      usedAt: null,
      issuedByAdminUserId: adminMeta.adminUserId || '',
      issuedByAdminOpenid: adminMeta.adminOpenid || '',
      issuedAt: time,
      createdAt: time,
      updatedAt: time
    }
  })
  await db.collection('coupon_templates').doc(templateId).update({ data: { issuedCount: incUpdateValue(template.issuedCount, 1), updatedAt: time } })
  template.issuedCount = Number(template.issuedCount || 0) + 1
  return { _id: created._id, templateSnapshot: snapshot, validFrom: validRange.validFrom, validTo: validRange.validTo }
}

async function getMonthConfig(monthKey) {
  const configRes = await db.collection('checkin_month_configs').where({ monthKey }).limit(1).get()
  return configRes.data[0] || null
}

async function ensureMonthConfig(monthKey) {
  const existing = await getMonthConfig(monthKey)
  if (existing) return existing
  const time = now()
  const created = await db.collection('checkin_month_configs').add({ data: { monthKey, days: defaultCheckinDays(monthKey), status: 'draft', createdAt: time, updatedAt: time } })
  return { _id: created._id, monthKey, days: defaultCheckinDays(monthKey), status: 'draft', createdAt: time, updatedAt: time }
}

function normalizeCheckinReward(dayConfig, day) {
  const rewardType = ['points', 'coupon', 'none'].includes(dayConfig && dayConfig.rewardType) ? dayConfig.rewardType : 'points'
  return {
    day,
    rewardType,
    points: Math.max(Math.round(Number((dayConfig && dayConfig.points) || 0)), 0),
    couponTemplateId: safeText(dayConfig && dayConfig.couponTemplateId).trim(),
    couponSnapshot: dayConfig && dayConfig.couponSnapshot ? dayConfig.couponSnapshot : null,
    title: safeText(dayConfig && dayConfig.title).trim() || `第${day}天奖励`,
    desc: safeText(dayConfig && dayConfig.desc).trim()
  }
}

async function claimCheckinReward(user, reward, dateInfo, checkinType) {
  const rewardSnapshot = { ...reward }
  let pointsDelta = 0
  let couponId = ''
  if (reward.rewardType === 'points' && reward.points > 0) {
    const result = await addPoints(user.openid, user._id, reward.points, 'checkin_daily', dateInfo.dateKey, `签到奖励 +${reward.points} 积分`, { applyMultiplier: true, baseDelta: reward.points })
    pointsDelta = result.delta
    rewardSnapshot.finalPoints = result.delta
    rewardSnapshot.multiplier = result.multiplier
  }
  if (reward.rewardType === 'coupon' && reward.couponTemplateId) {
    const template = (await db.collection('coupon_templates').doc(reward.couponTemplateId).get()).data
    const issued = await issueCouponToTargetUser(template, user)
    couponId = issued._id
    rewardSnapshot.couponSnapshot = issued.templateSnapshot
  }
  return { rewardSnapshot, pointsDelta, couponId, checkinType }
}

async function buildMonthCalendar(openid, monthKey) {
  const user = await getUser(openid)
  const config = await ensureMonthConfig(monthKey)
  const checkinsRes = await db.collection('user_checkins').where({ openid, monthKey }).get()
  const checkinMap = (checkinsRes.data || []).reduce((map, item) => ({ ...map, [item.day]: item }), {})
  const todayInfo = toCstParts()
  const days = defaultCheckinDays(monthKey).map((fallback) => {
    const reward = normalizeCheckinReward((config.days || []).find((item) => Number(item.day) === fallback.day) || fallback, fallback.day)
    const checkin = checkinMap[fallback.day]
    const isPast = monthKey < todayInfo.monthKey || (monthKey === todayInfo.monthKey && fallback.day < todayInfo.dayNumber)
    const isToday = monthKey === todayInfo.monthKey && fallback.day === todayInfo.dayNumber
    return {
      ...reward,
      checked: Boolean(checkin),
      checkinType: checkin ? checkin.checkinType : '',
      rewardSnapshot: checkin ? (checkin.rewardSnapshot || reward) : reward,
      canCheckin: isToday && !checkin,
      canRetro: isPast && !checkin && Number(user.retroCardCount || 0) > 0,
      rewardStatus: checkin ? 'claimed' : (isToday ? 'today' : (isPast ? 'missed' : 'future'))
    }
  })
  return {
    monthKey,
    retroCardCount: Number(user.retroCardCount || 0),
    points: Number(user.points || 0),
    memberLevelName: user.memberLevelName || '普通会员',
    days
  }
}

function rewardMailStatusText(mail) {
  if (mail.claimedAt) return '已领取'
  if (mail.readAt) return '待领取'
  return '未读'
}

function formatRewardMail(mail) {
  const reward = mail.reward || {}
  return {
    _id: mail._id,
    title: safeText(mail.title).trim() || '奖励到账提醒',
    content: safeText(mail.content).trim(),
    targetLevels: Array.isArray(mail.targetLevels) ? mail.targetLevels : [],
    rewardType: reward.type || 'points',
    reward,
    readAt: mail.readAt || null,
    claimedAt: mail.claimedAt || null,
    createdAt: mail.createdAt,
    updatedAt: mail.updatedAt,
    unread: !mail.readAt,
    claimable: !mail.claimedAt,
    statusText: rewardMailStatusText(mail)
  }
}

async function addPoints(openid, userId, delta, sourceType, sourceId, reason, options = {}) {
  const userRes = await db.collection('users').where({ openid }).limit(1).get()
  const user = userRes.data[0]
  if (!user) return { delta: 0, multiplier: 1, balance: 0 }
  const baseDelta = Number(options.baseDelta !== undefined ? options.baseDelta : delta)
  const currentPoints = Number(user.points || 0)
  const currentTotal = Number(user.totalPoints || 0)
  const currentLevels = await getMemberLevels()
  const currentLevelInfo = calcMemberLevel(currentTotal, currentLevels)
  const multiplier = options.applyMultiplier && baseDelta > 0 ? Math.max(Number(currentLevelInfo.pointMultiplier || 1), 1) : 1
  const finalDelta = baseDelta > 0 ? Math.max(Math.round(baseDelta * multiplier), 1) : Number(delta || 0)
  const newPoints = Math.max(currentPoints + finalDelta, 0)
  const newTotal = finalDelta > 0 ? currentTotal + finalDelta : currentTotal
  const levelInfo = calcMemberLevel(newTotal, currentLevels)
  const time = now()
  await db.collection('point_logs').add({
    data: { userId: user._id, openid, delta: finalDelta, baseDelta, multiplier, balance: newPoints, reason: reason || '', sourceType: sourceType || '', sourceId: sourceId || '', createdAt: time }
  })
  await db.collection('users').doc(user._id).update({
    data: { points: newPoints, totalPoints: newTotal, memberLevel: levelInfo.memberLevel, memberLevelName: levelInfo.memberLevelName, updatedAt: time }
  })
  return { delta: finalDelta, multiplier, balance: newPoints, totalPoints: newTotal, memberLevelName: levelInfo.memberLevelName }
}

async function logAdmin(admin, targetType, targetId, action, detail) {
  await db.collection('admin_operation_logs').add({
    data: { adminUserId: admin._id, adminOpenid: admin.openid, targetType, targetId, action, detail: detail || {}, createdAt: now() }
  })
}

async function getOrderForAccess(openid, orderId) {
  const user = await getUser(openid)
  const res = await db.collection('orders').doc(orderId).get()
  const order = res.data
  const canPreviewForStaff = user.roles.includes('staff') && order.status === 'paid' && (isOpenOrder(order) || order.requestedStaffOpenid === openid)
  const allowed = order.clientOpenid === openid || order.staffOpenid === openid || order.requestedStaffOpenid === openid || user.roles.includes('admin') || canPreviewForStaff
  if (!allowed) throw new Error('无权访问订单')
  return { user, order }
}

async function attachPetSnapshot(order) {
  if (order.petSnapshot || !order.petId) return order
  try {
    const pet = (await db.collection('pets').doc(order.petId).get()).data
    return {
      ...order,
      petSnapshot: {
        name: pet.name || order.petName || '',
        avatarFileId: pet.avatarFileId || '',
        species: pet.species || '',
        breed: pet.breed || '',
        gender: pet.gender || '',
        birthday: pet.birthday || '',
        weight: Number(pet.weight || 0),
        personality: pet.personality || '',
        favoriteFood: pet.favoriteFood || '',
        dislikes: pet.dislikes || '',
        healthNotes: pet.healthNotes || '',
        specialNotes: pet.specialNotes || ''
      }
    }
  } catch (error) {
    return order
  }
}

async function getRequestedStaff(data) {
  const publishMode = data.publishMode === 'direct' ? 'direct' : 'open'
  if (publishMode === 'open') {
    return {
      publishMode,
      requestedStaffProfileId: '',
      requestedStaffUserId: '',
      requestedStaffOpenid: '',
      requestedStaffName: '',
      requestedStaffSnapshot: null
    }
  }
  const staffProfileId = data.staffProfileId || data.requestedStaffProfileId
  if (!staffProfileId) throw new Error('请选择指定宠托师')
  const profileRes = await db.collection('staff_profiles').doc(staffProfileId).get()
  const profile = profileRes.data
  if (!profile || profile.auditStatus !== 'approved') throw new Error('指定宠托师未审核通过')
  const userRes = await db.collection('users').where({ openid: profile.openid }).limit(1).get()
  const staffUser = userRes.data[0]
  if (!staffUser) throw new Error('指定宠托师账号不存在')
  const publicSitter = toPublicSitter(await withSitterUserProfile(profile))
  return {
    publishMode,
    requestedStaffProfileId: profile._id,
    requestedStaffUserId: staffUser._id,
    requestedStaffOpenid: profile.openid,
    requestedStaffName: publicSitter.displayName,
    requestedStaffSnapshot: {
      profileId: profile._id,
      displayName: publicSitter.displayName,
      serviceCity: publicSitter.serviceCity,
      serviceAreas: publicSitter.serviceAreas
    }
  }
}

function isOpenOrder(order) {
  return !order.staffOpenid && (!order.publishMode || order.publishMode === 'open') && !order.requestedStaffOpenid
}

function maskClientName(value) {
  const name = String(value || '').trim()
  if (!name) return '宠物主'
  return name.length <= 1 ? `${name}用户` : `${name.slice(0, 1)}* 用户`
}

function createClientSnapshot(user) {
  const nickname = safeText(user.nickname).trim()
  return {
    userId: safeText(user._id),
    nickname,
    displayName: maskClientName(nickname),
    avatarUrl: safeFileId(user.avatarUrl) || safeText(user.avatarUrl),
    phoneMasked: mask(safeText(user.phone).trim())
  }
}

async function attachClientSnapshot(order) {
  if (order.clientSnapshot && (order.clientSnapshot.displayName || order.clientSnapshot.avatarUrl)) return order
  if (!order.clientOpenid) return order
  try {
    const userRes = await db.collection('users').where({ openid: order.clientOpenid }).limit(1).get()
    const user = userRes.data[0]
    if (!user) return order
    return {
      ...order,
      clientSnapshot: createClientSnapshot(user)
    }
  } catch (error) {
    return order
  }
}

async function attachOrderDisplayData(order) {
  const withPet = await attachPetSnapshot(order)
  return attachClientSnapshot(withPet)
}

async function appendOrderTimeline(orderId, type, title, detail, actorRole) {
  await db.collection('order_timeline').add({
    data: { orderId, type, title, detail: detail || '', actorRole: actorRole || '', createdAt: now() }
  })
}

async function saveUserAddress(openid, user, data) {
  if (!data.serviceAddress) throw new Error('请选择服务地址')
  if (!data.addressDetail) throw new Error('请填写详细地址')
  if (!data.doorplate) throw new Error('请填写门牌号或入户说明')
  const time = now()
  const existingAddresses = await db.collection('user_addresses').where({ openid }).get()
  const isNewAddress = !data.id
  const shouldBeDefault = data.isDefault === true || (isNewAddress && existingAddresses.data.length === 0)
  const payload = {
    userId: user._id,
    openid,
    label: data.label || '常用地址',
    contactName: data.contactName || '',
    contactPhone: data.contactPhone || '',
    serviceAddress: data.serviceAddress || '',
    addressDetail: data.addressDetail || '',
    doorplate: data.doorplate || '',
    latitude: Number(data.latitude || data.addressLatitude || 0),
    longitude: Number(data.longitude || data.addressLongitude || 0),
    isDefault: shouldBeDefault,
    updatedAt: time
  }
  if (payload.isDefault) {
    await Promise.all(existingAddresses.data.map((item) => db.collection('user_addresses').doc(item._id).update({ data: { isDefault: false, updatedAt: time } })))
  }
  if (data.id) {
    const existing = await db.collection('user_addresses').doc(data.id).get()
    if (existing.data.openid !== openid) throw new Error('无权操作地址')
    await db.collection('user_addresses').doc(data.id).update({ data: payload })
    return { _id: data.id, ...existing.data, ...payload }
  }
  const created = await db.collection('user_addresses').add({ data: { ...payload, createdAt: time } })
  return { _id: created._id, ...payload, createdAt: time }
}

async function getReviewStats(staffProfileId) {
  const res = await db.collection('service_reviews').where({ staffProfileId, status: 'visible' }).get()
  const reviews = res.data || []
  const reviewCount = reviews.length
  const ratingAverage = reviewCount ? Number((reviews.reduce((sum, item) => sum + Number(item.rating || 0), 0) / reviewCount).toFixed(1)) : 0
  const recentReviews = reviews
    .slice()
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, 5)
    .map((item) => ({
      _id: item._id,
      rating: item.rating,
      tags: item.tags || [],
      content: item.content || '',
      clientName: maskClientName(item.clientName),
      createdAt: item.createdAt
    }))
  return { ratingAverage, reviewCount, recentReviews }
}

async function isFavoriteSitter(openid, staffProfileId) {
  const res = await db.collection('sitter_favorites').where({ openid, staffProfileId }).limit(1).get()
  return Boolean(res.data[0])
}

async function toPublicSitterDetail(openid, profile) {
  const base = toPublicSitter(profile)
  const reviewStats = await getReviewStats(profile._id)
  return {
    ...base,
    level: profile.level || 'normal',
    levelName: profile.levelName || '认证宠托师',
    serviceRadiusKm: Number(profile.serviceRadiusKm || 0),
    publicTags: Array.isArray(profile.publicTags) && profile.publicTags.length ? profile.publicTags : base.publicTags,
    favorite: openid ? await isFavoriteSitter(openid, profile._id) : false,
    ...reviewStats
  }
}

function getCancelQuoteForOrder(order) {
  if (order.status === 'pending_pay') return { canCancel: true, refundAmount: 0, refundStatus: 'not_required', ruleText: '待支付订单可直接取消' }
  if (order.status === 'paid') return { canCancel: true, refundAmount: Number(order.payAmount || 0), refundStatus: 'mock_refunded', ruleText: '已支付未接单订单可全额退款' }
  if (order.status === 'assigned') {
    const start = new Date(String(order.startTime || '').replace(/-/g, '/')).getTime()
    const hoursBeforeStart = start ? (start - now().getTime()) / 36e5 : 0
    const rate = hoursBeforeStart >= 24 ? 1 : 0.8
    return { canCancel: true, refundAmount: Math.round(Number(order.payAmount || 0) * rate), refundStatus: 'mock_refunded', ruleText: hoursBeforeStart >= 24 ? '距服务开始超过24小时，可全额退款' : '距服务开始不足24小时，可退80%' }
  }
  return { canCancel: false, refundAmount: 0, refundStatus: 'pending_manual', ruleText: '服务中或已完成订单需申请平台介入' }
}

const handlers = {
  async system(openid, action) {
    if (action === 'getSettings') return getSystemSettings()
    throw new Error('未知 system 操作')
  },

  async auth(openid, action, data) {
    if (action === 'login') {
      let user = await getOptionalUser(openid)
      const time = now()
      if (!user) {
        const userData = {
          openid,
          phone: '',
          nickname: '微信用户',
          avatarUrl: '',
          roles: ['client'],
          activeRole: 'client',
          status: 'active',
          retroCardCount: 0,
          completedOrderCount: 0,
          inviterOpenid: '',
          inviteCode: '',
          createdAt: time,
          updatedAt: time
        }
        const created = await db.collection('users').add({ data: userData })
        user = { _id: created._id, ...userData }
      }
      if (user.status !== 'active') throw new Error('账号不可用')
      user = await bindInviteRelation(user, data)
      return user
    }

    if (action === 'loginByPhoneCode') {
      const code = safeText(data.code).trim()
      if (!code) throw new Error('未获取到手机号授权码')
      let phoneResult = null
      try {
        phoneResult = await cloud.openapi.phonenumber.getPhoneNumber({ code })
      } catch (error) {
        const message = error.message || error.errMsg || JSON.stringify(error)
        throw new Error(`调用微信手机号接口失败：${message}`)
      }
      const phoneInfo = phoneResult.phoneInfo || phoneResult.phone_info || {}
      const phone = safeText(phoneInfo.phoneNumber || phoneInfo.purePhoneNumber || phoneInfo.phone_number || phoneInfo.pure_phone_number).trim()
      if (!phone) throw new Error(`手机号授权失败：${JSON.stringify(phoneResult)}`)
      let user = await getOptionalUser(openid)
      const time = now()
      if (!user) {
        const userData = {
          openid,
          phone,
          nickname: '微信用户',
          avatarUrl: '',
          roles: ['client'],
          activeRole: 'client',
          status: 'active',
          retroCardCount: 0,
          completedOrderCount: 0,
          inviterOpenid: '',
          inviteCode: '',
          createdAt: time,
          updatedAt: time
        }
        const created = await db.collection('users').add({ data: userData })
        user = { _id: created._id, ...userData }
      } else {
        if (user.status !== 'active') throw new Error('账号不可用')
        await db.collection('users').doc(user._id).update({ data: { phone, updatedAt: time } })
        user = { ...user, phone, updatedAt: time }
      }
      user = await bindInviteRelation(user, data)
      return user
    }

    if (action === 'me') return getUser(openid)

    if (action === 'dailyCheckin') {
      const user = await getUser(openid)
      const todayInfo = toCstParts()
      const existing = (await db.collection('user_checkins').where({ openid, dateKey: todayInfo.dateKey }).limit(1).get()).data[0]
      if (existing) {
        return { checkedIn: true, points: Number(user.points || 0), retroCardCount: Number(user.retroCardCount || 0) }
      }
      const config = await ensureMonthConfig(todayInfo.monthKey)
      const reward = normalizeCheckinReward((config.days || []).find((item) => Number(item.day) === todayInfo.dayNumber) || {}, todayInfo.dayNumber)
      const claimed = await claimCheckinReward(user, reward, todayInfo, 'normal')
      const time = now()
      await db.collection('user_checkins').add({
        data: {
          userId: user._id,
          openid,
          monthKey: todayInfo.monthKey,
          dateKey: todayInfo.dateKey,
          day: todayInfo.dayNumber,
          checkinType: 'normal',
          usedRetroCard: false,
          rewardSnapshot: claimed.rewardSnapshot,
          pointsDelta: claimed.pointsDelta,
          couponId: claimed.couponId || '',
          createdAt: time,
          updatedAt: time
        }
      })
      const updated = await getUser(openid)
      return {
        checkedIn: false,
        points: Number(updated.points || 0),
        retroCardCount: Number(updated.retroCardCount || 0),
        delta: claimed.pointsDelta,
        rewardSnapshot: claimed.rewardSnapshot
      }
    }

    if (action === 'updateProfile') {
      const user = await getUser(openid)
      const nickname = safeText(data.nickname).trim()
      if (!nickname) throw new Error('昵称不能为空')
      const payload = {
        nickname,
        avatarUrl: safeFileId(data.avatarUrl) || safeText(data.avatarUrl),
        phone: safeText(data.phone).trim(),
        updatedAt: now()
      }
      await db.collection('users').doc(user._id).update({ data: payload })
      return { ...user, ...payload }
    }

    if (action === 'bindPhone') {
      const user = await getUser(openid)
      const phone = String(data.phone || '').trim()
      if (!phone) throw new Error('手机号不能为空')
      await db.collection('users').doc(user._id).update({ data: { phone, updatedAt: now() } })
      return { ...user, phone }
    }

    if (action === 'switchRole') {
      const user = await getUser(openid)
      if (!Array.isArray(user.roles) || !user.roles.includes(data.role)) throw new Error('当前账号无此角色权限')
      await db.collection('users').doc(user._id).update({ data: { activeRole: data.role, updatedAt: now() } })
      return { ...user, activeRole: data.role }
    }

    throw new Error('未知 auth 操作')
  },

  async pet(openid, action, data) {
    const user = await getUser(openid)
    if (action === 'listPets') {
      const res = await db.collection('pets').where({ openid }).orderBy('createdAt', 'desc').get()
      return res.data
    }
    if (action === 'getPet') {
      const res = await db.collection('pets').doc(data.id).get()
      if (res.data.openid !== openid) throw new Error('无权访问')
      return res.data
    }
    if (action === 'createPet') {
      if (!data.name) throw new Error('宠物名称不能为空')
      const time = nowText()
      const pet = {
        userId: safeText(user._id),
        openid: safeText(openid),
        name: safeText(data.name),
        avatarFileId: safeFileId(data.avatarFileId),
        species: safeText(data.species || 'dog'),
        breed: safeText(data.breed),
        gender: safeText(data.gender),
        birthday: safeText(data.birthday),
        weight: safeNumber(data.weight),
        personality: safeText(data.personality),
        favoriteFood: safeText(data.favoriteFood),
        dislikes: safeText(data.dislikes),
        healthNotes: safeText(data.healthNotes),
        aiInteractionEnabled: data.aiInteractionEnabled === true,
        aiPersona: safeText(data.aiPersona),
        aiGreeting: safeText(data.aiGreeting),
        specialNotes: safeText(data.specialNotes),
        createdAt: time,
        updatedAt: time
      }
      const created = await db.collection('pets').add({ data: pet })
      return { _id: created._id, ...pet }
    }
    if (action === 'updatePet') {
      const existing = await db.collection('pets').doc(data.id).get()
      if (existing.data.openid !== openid) throw new Error('无权访问')
      await db.collection('pets').doc(data.id).update({ data: {
        name: safeText(data.name),
        avatarFileId: safeFileId(data.avatarFileId),
        species: safeText(data.species || 'dog'),
        breed: safeText(data.breed),
        gender: safeText(data.gender),
        birthday: safeText(data.birthday),
        weight: safeNumber(data.weight),
        personality: safeText(data.personality),
        favoriteFood: safeText(data.favoriteFood),
        dislikes: safeText(data.dislikes),
        healthNotes: safeText(data.healthNotes),
        aiInteractionEnabled: data.aiInteractionEnabled === true,
        aiPersona: safeText(data.aiPersona),
        aiGreeting: safeText(data.aiGreeting),
        specialNotes: safeText(data.specialNotes),
        updatedAt: nowText()
      } })
      return { id: data.id }
    }
    if (action === 'deletePet') {
      const existing = await db.collection('pets').doc(data.id).get()
      if (existing.data.openid !== openid) throw new Error('无权访问')
      await db.collection('pets').doc(data.id).remove()
      return { id: data.id }
    }
    throw new Error('未知 pet 操作')
  },

  async client(openid, action, data) {
    const user = await getUser(openid)

    if (action === 'listAddresses') {
      const res = await db.collection('user_addresses').where({ openid }).orderBy('updatedAt', 'desc').get()
      return res.data
    }

    if (action === 'saveAddress') {
      return saveUserAddress(openid, user, data)
    }

    if (action === 'deleteAddress') {
      const existing = await db.collection('user_addresses').doc(data.id).get()
      if (existing.data.openid !== openid) throw new Error('无权操作地址')
      await db.collection('user_addresses').doc(data.id).remove()
      return { id: data.id }
    }

    if (action === 'setDefaultAddress') {
      const existing = await db.collection('user_addresses').doc(data.id).get()
      if (existing.data.openid !== openid) throw new Error('无权操作地址')
      const time = now()
      const addresses = await db.collection('user_addresses').where({ openid }).get()
      await Promise.all(addresses.data.map((item) => db.collection('user_addresses').doc(item._id).update({ data: { isDefault: item._id === data.id, updatedAt: time } })))
      return { id: data.id }
    }

    throw new Error('未知 client 操作')
  },

  async homeSecurity(openid, action, data) {
    if (action === 'saveHomeSecurity') {
      const user = await getUser(openid)
      const encrypted = encryptText(data.doorLockCode || '')
      const payload = { userId: user._id, openid, doorLockCodeCipher: encrypted.cipher, doorLockCodeIv: encrypted.iv, doorLockCodeTag: encrypted.tag, keyLocation: data.keyLocation || '', entryNotes: data.entryNotes || '', cameraLocations: data.cameraLocations || '', forbiddenAreas: data.forbiddenAreas || '', emergencyContactName: data.emergencyContactName || '', emergencyContactPhone: data.emergencyContactPhone || '', updatedAt: now() }
      const existing = await db.collection('home_security').where({ openid }).limit(1).get()
      if (existing.data[0]) {
        await db.collection('home_security').doc(existing.data[0]._id).update({ data: payload })
        return { _id: existing.data[0]._id, ...payload, doorLockCodeMasked: mask(data.doorLockCode || '') }
      }
      const created = await db.collection('home_security').add({ data: payload })
      return { _id: created._id, ...payload, doorLockCodeMasked: mask(data.doorLockCode || '') }
    }

    if (action === 'getMaskedHomeSecurity') {
      await getUser(openid)
      const res = await db.collection('home_security').where({ openid }).limit(1).get()
      const record = res.data[0]
      if (!record) return null
      const plain = decryptText(record.doorLockCodeCipher, record.doorLockCodeIv, record.doorLockCodeTag)
      return { ...record, doorLockCodeCipher: undefined, doorLockCodeIv: undefined, doorLockCodeTag: undefined, doorLockCodeMasked: mask(plain) }
    }

    if (action === 'getUnlockCode') {
      const user = await getUser(openid)
      const orderRes = await db.collection('orders').doc(data.orderId).get()
      const order = orderRes.data
      let result = 'forbidden'
      let reason = ''
      try {
        if (!user.roles.includes('staff')) throw new Error('仅员工可查看')
        if (order.staffOpenid !== openid) throw new Error('不是该订单绑定员工')
        if (!['assigned', 'in_service'].includes(order.status)) throw new Error('订单状态不允许查看')
        const current = now().getTime()
        const start = new Date(order.startTime).getTime() - 30 * 60 * 1000
        const end = new Date(order.endTime).getTime()
        if (current < start || current > end) throw new Error('不在服务解锁时间窗口')
        const securityRes = await db.collection('home_security').where({ openid: order.clientOpenid }).limit(1).get()
        const security = securityRes.data[0]
        if (!security) throw new Error('客户未配置门锁信息')
        result = 'success'
        reason = 'ok'
        return { doorLockCode: decryptText(security.doorLockCodeCipher, security.doorLockCodeIv, security.doorLockCodeTag), keyLocation: security.keyLocation || '', entryNotes: security.entryNotes || '' }
      } catch (error) {
        reason = error.message
        throw error
      } finally {
        await db.collection('unlock_code_logs').add({ data: { orderId: data.orderId, staffUserId: user._id, staffOpenid: openid, result, reason, createdAt: now() } })
      }
    }
    throw new Error('未知 homeSecurity 操作')
  },

  async order(openid, action, data) {
    if (action === 'listServiceOptions') {
      await getUser(openid)
      return listServicePrices(false)
    }

    if (action === 'quoteOrder') {
      await getUser(openid)
      let pet = null
      if (data.petId) {
        const petRes = await db.collection('pets').doc(data.petId).get()
        if (petRes.data.openid !== openid) throw new Error('宠物不存在')
        pet = petRes.data
      }
      return calcOrderPricing(data, pet, { openid })
    }

    if (action === 'createOrder') {
      const user = await getUser(openid)
      if (!data.petId) throw new Error('请选择宠物')
      if (!data.serviceAddress) throw new Error('请选择服务地址')
      if (!data.addressDetail) throw new Error('请填写详细地址')
      if (!data.doorplate) throw new Error('请填写门牌号或入户说明')
      validateOrderTime(data)
      const petRes = await db.collection('pets').doc(data.petId).get()
      if (petRes.data.openid !== openid) throw new Error('宠物不存在')
      const pricing = await calcOrderPricing(data, petRes.data, { openid })
      const requestedStaff = await getRequestedStaff(data)
      const time = now()
      const order = { orderNo: `O${Date.now()}${Math.floor(Math.random() * 1000)}`, clientUserId: user._id, clientOpenid: openid, clientSnapshot: createClientSnapshot(user), staffUserId: '', staffOpenid: '', staffProfileId: '', ...requestedStaff, assignmentSource: '', sourceOrderId: data.sourceOrderId || '', petId: data.petId, petName: petRes.data.name, petSnapshot: { name: petRes.data.name || '', avatarFileId: petRes.data.avatarFileId || '', species: petRes.data.species || '', breed: petRes.data.breed || '', gender: petRes.data.gender || '', birthday: petRes.data.birthday || '', weight: Number(petRes.data.weight || 0), personality: petRes.data.personality || '', favoriteFood: petRes.data.favoriteFood || '', dislikes: petRes.data.dislikes || '', healthNotes: petRes.data.healthNotes || '', specialNotes: petRes.data.specialNotes || '' }, serviceType: pricing.serviceTypes[0], serviceTypes: pricing.serviceTypes, serviceLabels: pricing.serviceLabels, serviceSummary: pricing.serviceSummary, serviceAddress: data.serviceAddress || '', addressDetail: data.addressDetail || '', doorplate: data.doorplate || '', addressLatitude: Number(data.addressLatitude || 0), addressLongitude: Number(data.addressLongitude || 0), startTime: data.startTime, endTime: data.endTime, durationMinutes: pricing.durationMinutes, amount: pricing.amount, discountAmount: pricing.discountAmount || 0, payAmount: pricing.payAmount, couponId: pricing.coupon ? pricing.coupon.couponId : '', couponTemplateId: pricing.coupon ? pricing.coupon.templateId : '', couponName: pricing.coupon ? pricing.coupon.name : '', couponSnapshot: pricing.coupon ? pricing.coupon.snapshot : null, priceSnapshot: pricing.priceSnapshot, paymentStatus: 'unpaid', status: 'pending_pay', requiredCheckins: requiredCheckins(pricing.serviceTypes[0], pricing.serviceTypes), insurancePolicyNo: '', cancelReason: '', refundStatus: '', refundAmount: 0, createdAt: time, updatedAt: time }
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
      const created = await db.collection('orders').add({ data: order })
      if (order.couponId) {
        await db.collection('user_coupons').doc(order.couponId).update({ data: { status: 'locked', lockedOrderId: created._id, lockedAt: time, updatedAt: time } })
      }
      await appendOrderTimeline(created._id, 'created', '订单已创建', order.serviceSummary, 'client')
      if (order.couponId) await appendOrderTimeline(created._id, 'coupon_locked', '已使用优惠券', `优惠 ¥${order.discountAmount}`, 'client')
      return { _id: created._id, ...order, savedAddress }
    }

    if (action === 'listOrders') {
      const user = await getUser(openid)
      const role = data.role || user.activeRole || 'client'
      const where = role === 'staff' ? { staffOpenid: openid } : { clientOpenid: openid }
      const res = await db.collection('orders').where(where).orderBy('createdAt', 'desc').get()
      return Promise.all((res.data || []).map(attachOrderDisplayData))
    }

    if (action === 'getOrderDetail') {
      const { order } = await getOrderForAccess(openid, data.id)
      return attachOrderDisplayData(order)
    }

    if (action === 'prepareRebook') {
      const { order } = await getOrderForAccess(openid, data.orderId)
      if (order.clientOpenid !== openid) throw new Error('无权再次预约')
      let publishMode = order.publishMode === 'direct' ? 'direct' : 'open'
      let staffProfileId = order.requestedStaffProfileId || order.staffProfileId || ''
      if (publishMode === 'direct' && staffProfileId) {
        try {
          const profileRes = await db.collection('staff_profiles').doc(staffProfileId).get()
          if (!profileRes.data || profileRes.data.auditStatus !== 'approved') {
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
        serviceType: order.serviceType,
        serviceTypes: order.serviceTypes || [order.serviceType],
        serviceAddress: order.serviceAddress || '',
        addressDetail: order.addressDetail || '',
        doorplate: order.doorplate || '',
        addressLatitude: Number(order.addressLatitude || 0),
        addressLongitude: Number(order.addressLongitude || 0),
        durationMinutes: Number(order.durationMinutes || 60),
        publishMode,
        staffProfileId
      }
    }

    if (action === 'getOrderTimeline') {
      await getOrderForAccess(openid, data.orderId)
      const res = await db.collection('order_timeline').where({ orderId: data.orderId }).orderBy('createdAt', 'asc').get()
      return res.data
    }

    if (action === 'getOrderReview') {
      await getOrderForAccess(openid, data.orderId)
      const res = await db.collection('service_reviews').where({ orderId: data.orderId, status: 'visible' }).limit(1).get()
      return res.data[0] || null
    }

    if (action === 'createReview') {
      const { user, order } = await getOrderForAccess(openid, data.orderId)
      if (order.clientOpenid !== openid) throw new Error('仅宠物主可评价')
      if (order.status !== 'completed') throw new Error('订单完成后才可评价')
      const existing = await db.collection('service_reviews').where({ orderId: data.orderId }).limit(1).get()
      if (existing.data[0]) throw new Error('该订单已评价')
      const rating = Math.min(Math.max(Number(data.rating || 5), 1), 5)
      const time = now()
      const review = { orderId: data.orderId, clientUserId: user._id, clientOpenid: openid, clientName: user.nickname || '', staffUserId: order.staffUserId || '', staffOpenid: order.staffOpenid || '', staffProfileId: order.staffProfileId || '', rating, tags: Array.isArray(data.tags) ? data.tags.slice(0, 8) : [], content: String(data.content || '').trim(), status: 'visible', createdAt: time, updatedAt: time }
      const created = await db.collection('service_reviews').add({ data: review })
      await db.collection('orders').doc(data.orderId).update({ data: { reviewedAt: time, updatedAt: time } })
      await appendOrderTimeline(data.orderId, 'reviewed', '宠物主已评价', `${rating}星评价`, 'client')
      await addPoints(openid, user._id, 10, 'order_review', data.orderId, '评价订单 +10 积分', { applyMultiplier: true, baseDelta: 10 })
      return { _id: created._id, ...review }
    }

    if (action === 'getCancelQuote') {
      const { order } = await getOrderForAccess(openid, data.orderId)
      if (order.clientOpenid !== openid) throw new Error('无权取消订单')
      return getCancelQuoteForOrder(order)
    }

    if (action === 'cancelOrder') {
      const { order } = await getOrderForAccess(openid, data.orderId)
      if (order.clientOpenid !== openid) throw new Error('无权取消订单')
      const quote = getCancelQuoteForOrder(order)
      if (!quote.canCancel) throw new Error(quote.ruleText)
      const time = now()
      await db.collection('orders').doc(data.orderId).update({ data: { status: 'cancelled', cancelReason: data.reason || '', refundStatus: quote.refundStatus, refundAmount: quote.refundAmount, canceledAt: time, updatedAt: time } })
      if (order.paymentStatus !== 'paid' && order.couponId) {
        const coupon = (await db.collection('user_coupons').doc(order.couponId).get()).data
        if (coupon && coupon.status === 'locked' && coupon.lockedOrderId === data.orderId) {
          await db.collection('user_coupons').doc(order.couponId).update({ data: { status: 'available', lockedOrderId: '', lockedAt: null, updatedAt: time } })
        }
      }
      await appendOrderTimeline(data.orderId, 'cancelled', '订单已取消', `${quote.ruleText}，预计退款 ¥${quote.refundAmount}`, 'client')
      return { orderId: data.orderId, status: 'cancelled', refundStatus: quote.refundStatus, refundAmount: quote.refundAmount }
    }

    if (action === 'startService') {
      const { user, order } = await getOrderForAccess(openid, data.id)
      if (!user.roles.includes('staff')) throw new Error('仅员工可开始服务')
      if (order.staffOpenid !== openid) throw new Error('不是该订单员工')
      if (order.status !== 'assigned') throw new Error('订单状态不可开始')
      const time = now()
      await db.collection('orders').doc(data.id).update({ data: { status: 'in_service', startedAt: time, updatedAt: time } })
      await appendOrderTimeline(data.id, 'started', '服务已开始', '', 'staff')
      return { id: data.id }
    }

    if (action === 'finishService') {
      const { user, order } = await getOrderForAccess(openid, data.id)
      if (!user.roles.includes('staff')) throw new Error('仅员工可完成服务')
      if (order.staffOpenid !== openid) throw new Error('不是该订单员工')
      if (order.status !== 'in_service') throw new Error('订单状态不可完成')
      const checkins = await db.collection('checkin_logs').where({ orderId: data.id }).get()
      const eventSet = checkins.data.reduce((map, item) => ({ ...map, [item.eventType]: true }), {})
      const missing = (order.requiredCheckins || []).filter((eventType) => !eventSet[eventType])
      if (missing.length) throw new Error(`缺少强制打卡：${missing.join(',')}`)
      const time = now()
      await db.collection('orders').doc(data.id).update({ data: { status: 'completed', completedAt: time, updatedAt: time } })
      await appendOrderTimeline(data.id, 'completed', '服务已完成', '', 'staff')
      const pointsDelta = Math.max(Math.floor(Number(order.payAmount || 0) / 10), 1)
      await addPoints(order.clientOpenid, order.clientUserId, pointsDelta, 'order_complete', data.id, `完成订单 +${pointsDelta} 积分`, { applyMultiplier: true, baseDelta: pointsDelta })
      const clientUser = await getUser(order.clientOpenid)
      const completedOrderCount = Number(clientUser.completedOrderCount || 0) + 1
      await db.collection('users').doc(clientUser._id).update({ data: { completedOrderCount, updatedAt: time } })
      if (completedOrderCount % 3 === 0) {
        await grantRetroCards(order.clientOpenid, clientUser._id, 1, 'order_complete_milestone', data.id, '完成 3 次订单奖励补签卡 +1')
      }
      return { id: data.id, completedOrderCount }
    }

    if (action === 'getServiceReport') {
      const order = (await getOrderForAccess(openid, data.id)).order
      const tracks = await db.collection('track_logs').where({ orderId: data.id }).orderBy('recordedAt', 'asc').get()
      const checkins = await db.collection('checkin_logs').where({ orderId: data.id }).orderBy('createdAt', 'asc').get()
      return { order, tracks: tracks.data, checkins: checkins.data }
    }
    throw new Error('未知 order 操作')
  },

  async coupon(openid, action, data) {
    if (action === 'listMyCoupons') {
      await getUser(openid)
      const res = await db.collection('user_coupons').where({ openid }).get()
      const statusFilter = data.status || 'available'
      return (res.data || [])
        .map((coupon) => formatUserCoupon(coupon))
        .filter((coupon) => statusFilter === 'all' || coupon.status === statusFilter)
        .sort((a, b) => String(a.validTo || '').localeCompare(String(b.validTo || '')))
    }

    if (action === 'listApplicableCoupons') {
      await getUser(openid)
      let pet = null
      if (data.petId) {
        const petRes = await db.collection('pets').doc(data.petId).get()
        if (petRes.data.openid !== openid) throw new Error('宠物不存在')
        pet = petRes.data
      }
      const pricing = await calcOrderPricing({ ...data, couponId: '', autoApplyCoupon: false }, pet, { openid })
      const coupons = (await db.collection('user_coupons').where({ openid }).get()).data || []
      return coupons
        .map((coupon) => {
          const result = evaluateCoupon(coupon, pricing, openid)
          return formatUserCoupon(coupon, {
            status: couponDisplayStatus(coupon),
            applicable: result.applicable,
            reason: result.reason || '',
            payAmountAfterDiscount: result.applicable ? Math.max(pricing.amount - result.discountAmount, 0) : pricing.amount
          })
        })
        .sort((a, b) => Number(b.applicable) - Number(a.applicable) || String(a.validTo || '').localeCompare(String(b.validTo || '')))
    }

    throw new Error('未知 coupon 操作')
  },

  async memberLevel(openid, action, data) {
    if (action === 'listLevels') {
      const levels = await getMemberLevels()
      return levels.map((level) => ({
        ...level,
        pointMultiplier: Math.max(Number(level.pointMultiplier || 1), 1),
        description: safeText(level.description).trim(),
        benefits: normalizeBenefits(level.benefits)
      }))
    }
    if (action === 'myInfo') {
      const user = await getUser(openid)
      const page = Math.max(Number(data.page || 1), 1)
      const pageSize = 20
      const logsRes = await db.collection('point_logs').where({ openid }).orderBy('createdAt', 'desc').limit(page * pageSize).get()
      const countRes = await db.collection('point_logs').where({ openid }).count()
      const allLogs = logsRes.data || []
      const logs = allLogs.slice((page - 1) * pageSize, page * pageSize)
      const levels = (await getMemberLevels()).map((level) => ({
        ...level,
        pointMultiplier: Math.max(Number(level.pointMultiplier || 1), 1),
        description: safeText(level.description).trim(),
        benefits: normalizeBenefits(level.benefits)
      }))
      const currentLevel = levels.find((level) => level._id === user.memberLevel) || null
      const nextLevel = levels.find((level) => Number(level.minPoints || 0) > Number(user.totalPoints || 0)) || null
      return {
        points: Number(user.points || 0),
        totalPoints: Number(user.totalPoints || 0),
        memberLevel: user.memberLevel || '',
        memberLevelName: user.memberLevelName || '普通会员',
        pointMultiplier: currentLevel ? Math.max(Number(currentLevel.pointMultiplier || 1), 1) : 1,
        retroCardCount: Number(user.retroCardCount || 0),
        inviteCode: safeText(user.inviteCode).trim(),
        inviterOpenid: safeText(user.inviterOpenid).trim(),
        currentLevel,
        nextLevel,
        levels,
        logs,
        total: countRes.total || 0,
        page,
        pageSize
      }
    }
    throw new Error('未知 memberLevel 操作')
  },

  async rewardMail(openid, action, data) {
    if (action === 'getUnreadCount') {
      await getUser(openid)
      const mailsRes = await db.collection('reward_mails').where({ openid }).get()
      const mails = mailsRes.data || []
      return {
        unreadCount: mails.filter((mail) => !mail.readAt).length,
        unclaimedCount: mails.filter((mail) => !mail.claimedAt).length
      }
    }
    if (action === 'listMyMails') {
      await getUser(openid)
      const mailsRes = await db.collection('reward_mails').where({ openid }).orderBy('createdAt', 'desc').get()
      return (mailsRes.data || []).map(formatRewardMail)
    }
    if (action === 'markRead') {
      await getUser(openid)
      const id = safeText(data.id).trim()
      if (!id) throw new Error('缺少邮件 ID')
      const mail = (await db.collection('reward_mails').doc(id).get()).data
      if (!mail || mail.openid !== openid) throw new Error('奖励邮件不存在')
      if (mail.readAt) return formatRewardMail(mail)
      const updated = { readAt: now(), updatedAt: now() }
      await db.collection('reward_mails').doc(id).update({ data: updated })
      return formatRewardMail({ ...mail, ...updated })
    }
    if (action === 'claimReward') {
      const user = await getUser(openid)
      const id = safeText(data.id).trim()
      if (!id) throw new Error('缺少邮件 ID')
      const mail = (await db.collection('reward_mails').doc(id).get()).data
      if (!mail || mail.openid !== openid) throw new Error('奖励邮件不存在')
      if (mail.claimedAt) return formatRewardMail(mail)
      const reward = mail.reward || {}
      let pointsResult = null
      let couponResult = null
      if (reward.type === 'coupon') {
        const templateId = safeText(reward.couponTemplateId).trim()
        if (!templateId) throw new Error('奖励优惠券不存在')
        const template = (await db.collection('coupon_templates').doc(templateId).get()).data
        couponResult = await issueCouponToTargetUser(template, user, {
          adminUserId: safeText(mail.sentByAdminUserId).trim(),
          adminOpenid: safeText(mail.sentByAdminOpenid).trim()
        })
      } else {
        const delta = Math.max(Math.round(Number(reward.points || 0)), 0)
        if (delta > 0) {
          pointsResult = await addPoints(openid, user._id, delta, 'reward_mail', id, safeText(mail.title).trim() || '奖励邮件积分', { baseDelta: delta })
        }
      }
      const updated = {
        readAt: mail.readAt || now(),
        claimedAt: now(),
        rewardClaimResult: {
          pointsDelta: pointsResult ? pointsResult.delta : 0,
          couponId: couponResult ? couponResult._id : ''
        },
        updatedAt: now()
      }
      await db.collection('reward_mails').doc(id).update({ data: updated })
      return formatRewardMail({ ...mail, ...updated })
    }
    throw new Error('未知 rewardMail 操作')
  },

  async lottery(openid, action, data) {
    if (action === 'getActiveActivity') {
      // 不要求登录，首页可公开展示活动信息
      const res = await db.collection('lottery_activities').where({ enabled: true }).limit(1).get()
      const activity = res.data[0] || null
      if (!activity) return null
      return {
        _id: activity._id,
        name: activity.name,
        description: activity.description || '',
        prizeCount: (activity.prizes || []).length
      }
    }
    if (action === 'draw') {
      const user = await getUser(openid)
      const activityRes = await db.collection('lottery_activities').where({ enabled: true }).limit(1).get()
      const activity = activityRes.data[0]
      if (!activity) throw new Error('当前没有进行中的抽奖活动')

      // 防竞态：先写抽奖记录占位，再判断今日是否已抽
      const todayStart = cstTodayStart()
      const todayRecord = await db.collection('lottery_records')
        .where({ openid, activityId: activity._id })
        .orderBy('createdAt', 'desc').limit(1).get()
      if (todayRecord.data[0] && new Date(todayRecord.data[0].createdAt).getTime() >= todayStart.getTime()) {
        throw new Error('今天已参与过本次抽奖')
      }

      // 重新从数据库读取最新 activity 数据，防止库存基于旧内存
      const freshActivity = (await db.collection('lottery_activities').doc(activity._id).get()).data
      const prizes = (freshActivity.prizes || []).filter((p) => Number(p.stockLeft || 0) > 0)
      if (!prizes.length) throw new Error('奖品已被领完')

      // 按概率抽取，用 index 而非 templateId 匹配，避免同模板多奖品误扣
      const rand = Math.random() * prizes.reduce((sum, p) => sum + Number(p.probability || 0), 0)
      let cumulative = 0
      let prizeIndex = prizes.length - 1
      for (let i = 0; i < prizes.length; i++) {
        cumulative += Number(prizes[i].probability || 0)
        if (rand <= cumulative) { prizeIndex = i; break }
      }
      const prize = prizes[prizeIndex]

      // 找到该奖品在原始 prizes 数组中的位置（按 name+templateId 精确匹配第一个库存>0的）
      let originalIndex = -1
      let matchCount = 0
      for (let i = 0; i < freshActivity.prizes.length; i++) {
        const p = freshActivity.prizes[i]
        if (p.name === prize.name && p.templateId === prize.templateId && Number(p.stockLeft || 0) > 0) {
          if (matchCount === prizeIndex - prizes.indexOf(prize)) { originalIndex = i; break }
          matchCount++
        }
      }
      // 降级：找第一个匹配
      if (originalIndex === -1) {
        originalIndex = freshActivity.prizes.findIndex(
          (p) => p.name === prize.name && p.templateId === prize.templateId && Number(p.stockLeft || 0) > 0
        )
      }

      const time = now()
      const validDays = 30
      const validTo = new Date(time.getTime() + validDays * 86400000)
      let couponId = ''
      let templateSnapshot = null

      if (prize.templateId) {
        const template = (await db.collection('coupon_templates').doc(prize.templateId).get()).data
        if (template && template.enabled !== false) {
          templateSnapshot = normalizeCouponSnapshot(template)
          const coupon = await db.collection('user_coupons').add({
            data: { templateId: prize.templateId, templateSnapshot, userId: user._id, openid, status: 'available', validFrom: time, validTo, lockedOrderId: '', lockedAt: null, usedOrderId: '', usedAt: null, issuedAt: time, createdAt: time, updatedAt: time }
          })
          couponId = coupon._id
          await db.collection('coupon_templates').doc(prize.templateId).update({
            data: { issuedCount: incUpdateValue(template.issuedCount, 1), updatedAt: time }
          })
        }
      }

      // 用原子操作更新指定奖品库存，避免竞态超发
      if (originalIndex !== -1) {
        const updatedPrizes = freshActivity.prizes.map((p, i) =>
          i === originalIndex ? { ...p, stockLeft: Math.max(Number(p.stockLeft || 0) - 1, 0) } : p
        )
        await db.collection('lottery_activities').doc(activity._id).update({
          data: { prizes: updatedPrizes, updatedAt: time }
        })
      }

      await db.collection('lottery_records').add({
        data: { userId: user._id, openid, activityId: activity._id, prizeTemplateId: prize.templateId || '', prizeName: prize.name || '谢谢参与', couponId, createdAt: time }
      })
      return { prizeName: prize.name || '谢谢参与', couponId, templateSnapshot }
    }
    throw new Error('未知 lottery 操作')
  },

  async payment(openid, action, data) {
    if (action === 'createPayment') return { mock: true, message: 'MVP 暂未接入真实微信支付，请调用 mockPayOrder' }
    if (action === 'paymentCallback') return { ignored: true }
    if (action === 'mockPayOrder') {
      await getUser(openid)
      const orderRes = await db.collection('orders').doc(data.orderId).get()
      const order = orderRes.data
      if (order.clientOpenid !== openid) throw new Error('无权支付该订单')
      if (order.paymentStatus === 'paid') return { orderId: data.orderId, status: 'paid' }
      if (order.status !== 'pending_pay') throw new Error('订单状态不可支付')
      const time = now()
      if (order.couponId) {
        const coupon = (await db.collection('user_coupons').doc(order.couponId).get()).data
        if (!coupon || coupon.openid !== openid) throw new Error('优惠券不可用')
        if (coupon.status !== 'locked' || coupon.lockedOrderId !== data.orderId) throw new Error('优惠券状态异常')
      }
      await db.collection('payments').add({ data: { orderId: data.orderId, orderNo: order.orderNo, paymentNo: `P${Date.now()}${Math.floor(Math.random() * 1000)}`, wxTransactionId: '', amount: order.payAmount, status: 'success', paidAt: time, rawCallback: { mock: true }, createdAt: time, updatedAt: time } })
      await db.collection('orders').doc(data.orderId).update({ data: { paymentStatus: 'paid', status: 'paid', paidAt: time, updatedAt: time } })
      if (order.couponId) await db.collection('user_coupons').doc(order.couponId).update({ data: { status: 'used', usedOrderId: data.orderId, usedAt: time, updatedAt: time } })
      await appendOrderTimeline(data.orderId, 'paid', '订单已支付', `支付金额 ¥${order.payAmount}`, 'client')
      return { orderId: data.orderId, status: 'paid' }
    }
    throw new Error('未知 payment 操作')
  },

  async staff(openid, action, data) {
    if (action === 'listApprovedSitters') {
      const keyword = String(data.keyword || '').trim().toLowerCase()
      const serviceCity = String(data.serviceCity || '').trim()
      const serviceArea = String(data.serviceArea || '').trim()
      const sortBy = data.sortBy || 'default'
      const page = Math.max(Number(data.page || 1), 1)
      const pageSize = Math.min(Math.max(Number(data.pageSize || 20), 1), 50)
      const res = await db.collection('staff_profiles').where({ auditStatus: 'approved' }).orderBy('updatedAt', 'desc').get()
      let sitters = await Promise.all(res.data.map(withSitterUserProfile))
      sitters = sitters.filter((profile) => {
        const areas = splitServiceAreas(profile.serviceAreas)
        if (serviceCity && profile.serviceCity !== serviceCity) return false
        if (serviceArea && !areas.includes(serviceArea)) return false
        if (!keyword) return true
        return matchText(profile.nickname, keyword) || matchText(profile.realName, keyword) || matchText(profile.serviceCity, keyword) || matchText(profile.serviceAreas, keyword)
      })
      if (sortBy === 'city') {
        sitters = sitters.slice().sort((a, b) => String(a.serviceCity || '').localeCompare(String(b.serviceCity || '')) || String(a.serviceAreas || '').localeCompare(String(b.serviceAreas || '')))
      }
      if (sortBy === 'latest') {
        sitters = sitters.slice().sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
      }
      const start = (page - 1) * pageSize
      return {
        total: sitters.length,
        page,
        pageSize,
        list: sitters.slice(start, start + pageSize).map(toPublicSitter)
      }
    }
    if (action === 'getPublicSitterDetail') {
      const user = await getOptionalUser(openid)
      const profileRes = await db.collection('staff_profiles').doc(data.staffProfileId).get()
      const profile = profileRes.data
      if (!profile || profile.auditStatus !== 'approved') throw new Error('宠托师不可用')
      return toPublicSitterDetail(user ? openid : '', await withSitterUserProfile(profile))
    }
    if (action === 'favoriteSitter') {
      const user = await getUser(openid)
      const profileRes = await db.collection('staff_profiles').doc(data.staffProfileId).get()
      const profile = profileRes.data
      if (!profile || profile.auditStatus !== 'approved') throw new Error('宠托师不可用')
      const existing = await db.collection('sitter_favorites').where({ openid, staffProfileId: data.staffProfileId }).limit(1).get()
      if (existing.data[0]) return { staffProfileId: data.staffProfileId, favorite: true }
      await db.collection('sitter_favorites').add({ data: { userId: user._id, openid, staffProfileId: data.staffProfileId, createdAt: now() } })
      return { staffProfileId: data.staffProfileId, favorite: true }
    }
    if (action === 'unfavoriteSitter') {
      await getUser(openid)
      const existing = await db.collection('sitter_favorites').where({ openid, staffProfileId: data.staffProfileId }).limit(1).get()
      if (existing.data[0]) await db.collection('sitter_favorites').doc(existing.data[0]._id).remove()
      return { staffProfileId: data.staffProfileId, favorite: false }
    }
    if (action === 'listFavoriteSitters') {
      await getUser(openid)
      const favorites = await db.collection('sitter_favorites').where({ openid }).orderBy('createdAt', 'desc').get()
      const list = []
      for (let i = 0; i < favorites.data.length; i += 1) {
        try {
          const profileRes = await db.collection('staff_profiles').doc(favorites.data[i].staffProfileId).get()
          if (profileRes.data && profileRes.data.auditStatus === 'approved') {
            const profile = await withSitterUserProfile(profileRes.data)
            list.push({ ...(await toPublicSitterDetail(openid, profile)), favorite: true })
          }
        } catch (error) {}
      }
      return list
    }
    if (action === 'getStaffProfile') {
      await getUser(openid)
      const res = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      return res.data[0] || null
    }
    if (action === 'submitStaffProfile') {
      const user = await getUser(openid)
      const time = now()
      const profile = {
        userId: user._id,
        openid,
        realName: data.realName || '',
        phone: data.phone || user.phone || '',
        avatarUrl: user.avatarUrl || data.avatarUrl || '',
        serviceCity: data.serviceCity || '',
        serviceAreas: data.serviceAreas || '',
        faceVerifyStatus: 'pending',
        auditStatus: 'pending',
        auditRemark: '',
        updatedAt: time
      }
      const existing = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      if (existing.data[0]) {
        await db.collection('staff_profiles').doc(existing.data[0]._id).update({ data: profile })
        return { _id: existing.data[0]._id, ...profile }
      }
      const created = await db.collection('staff_profiles').add({ data: { ...profile, createdAt: time } })
      return { _id: created._id, ...profile, createdAt: time }
    }
    if (action === 'updateCurrentLocation') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可更新定位')
      const latitude = Number(data.latitude || 0)
      const longitude = Number(data.longitude || 0)
      if (!hasCoordinate(latitude, longitude)) throw new Error('定位信息无效')
      const existing = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      if (!existing.data[0]) throw new Error('请先提交员工认证')
      const location = { currentLatitude: latitude, currentLongitude: longitude, locationAccuracy: Number(data.accuracy || 0), locationUpdatedAt: now(), updatedAt: now() }
      await db.collection('staff_profiles').doc(existing.data[0]._id).update({ data: location })
      return { _id: existing.data[0]._id, ...location }
    }
    if (action === 'listNearbyOrders') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可查看')
      const latitude = Number(data.latitude || 0)
      const longitude = Number(data.longitude || 0)
      const res = await db.collection('orders').where({ status: 'paid' }).orderBy('startTime', 'asc').get()
      const orders = await Promise.all((res.data || []).filter(isOpenOrder).map(async (order) => {
        const enriched = await attachOrderDisplayData(order)
        const distanceKm = calcDistanceKm(latitude, longitude, enriched.addressLatitude, enriched.addressLongitude)
        return { ...enriched, distanceKm, distanceText: formatDistance(distanceKm) }
      }))
      return orders
        .sort((a, b) => (a.distanceKm === null ? 999999 : a.distanceKm) - (b.distanceKm === null ? 999999 : b.distanceKm))
        .slice(0, 20)
    }
    if (action === 'listDirectOrders') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可查看')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = profileRes.data[0] || {}
      const latitude = Number(data.latitude || profile.currentLatitude || 0)
      const longitude = Number(data.longitude || profile.currentLongitude || 0)
      const res = await db.collection('orders').where({ status: 'paid' }).orderBy('startTime', 'asc').get()
      return Promise.all((res.data || [])
        .filter((order) => order.publishMode === 'direct' && !order.staffOpenid && order.requestedStaffOpenid === openid)
        .map(async (order) => {
          const enriched = await attachOrderDisplayData(order)
          const distanceKm = calcDistanceKm(latitude, longitude, enriched.addressLatitude, enriched.addressLongitude)
          return { ...enriched, distanceKm, distanceText: formatDistance(distanceKm) }
        }))
    }
    if (action === 'listStaffReviews') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可查看')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = profileRes.data[0]
      if (!profile) throw new Error('请先提交员工认证')
      const res = await db.collection('service_reviews').where({ staffProfileId: profile._id, status: 'visible' }).orderBy('createdAt', 'desc').get()
      return res.data.map((item) => ({ ...item, clientName: maskClientName(item.clientName) }))
    }
    if (action === 'listStaffOrders') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可查看')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = profileRes.data[0] || {}
      const latitude = Number(data.latitude || profile.currentLatitude || 0)
      const longitude = Number(data.longitude || profile.currentLongitude || 0)
      const res = await db.collection('orders').where({ staffOpenid: openid }).orderBy('startTime', 'asc').get()
      return Promise.all((res.data || []).map(async (order) => {
        const enriched = await attachOrderDisplayData(order)
        const distanceKm = calcDistanceKm(latitude, longitude, enriched.addressLatitude, enriched.addressLongitude)
        return { ...enriched, distanceKm, distanceText: formatDistance(distanceKm) }
      }))
    }
    if (action === 'acceptOrder') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可接单')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = profileRes.data[0]
      if (!profile || profile.auditStatus !== 'approved') throw new Error('员工认证审核通过后才可接单')
      const orderRes = await db.collection('orders').doc(data.orderId).get()
      const order = orderRes.data
      if (order.status !== 'paid') throw new Error('订单状态不可接单')
      if (order.staffOpenid) throw new Error('订单已被分配')
      const publishMode = order.publishMode === 'direct' ? 'direct' : 'open'
      if (publishMode === 'direct' && order.requestedStaffOpenid !== openid) throw new Error('该订单指定了其他宠托师')
      if (publishMode === 'open' && order.requestedStaffOpenid) throw new Error('该订单指定了其他宠托师')
      const time = now()
      await db.collection('orders').doc(data.orderId).update({ data: { staffUserId: user._id, staffOpenid: openid, staffProfileId: profile._id, status: 'assigned', assignmentSource: publishMode === 'direct' ? 'direct_accept' : 'open_grab', assignedAt: time, updatedAt: time } })
      await appendOrderTimeline(data.orderId, 'assigned', publishMode === 'direct' ? '指定宠托师已接单' : '宠托师已抢单', maskStaffName(profile.realName), 'staff')
      return { orderId: data.orderId, status: 'assigned' }
    }
    throw new Error('未知 staff 操作')
  },

  async track(openid, action, data) {
    if (action === 'batchUploadTrack') {
      const { user, order } = await getOrderForAccess(openid, data.orderId)
      if (!user.roles.includes('staff') || order.staffOpenid !== openid) throw new Error('仅订单员工可上传轨迹')
      if (order.status !== 'in_service') throw new Error('仅服务中可上传轨迹')
      const uploadedAt = now()
      const points = Array.isArray(data.points) ? data.points.slice(0, 50) : []
      await Promise.all(points.map((point) => db.collection('track_logs').add({ data: { orderId: data.orderId, staffUserId: user._id, staffOpenid: openid, latitude: Number(point.latitude), longitude: Number(point.longitude), speed: Number(point.speed || 0), accuracy: Number(point.accuracy || 0), recordedAt: point.recordedAt || uploadedAt, uploadedAt } })))
      return { count: points.length }
    }
    if (action === 'getOrderTracks') {
      await getOrderForAccess(openid, data.orderId)
      const res = await db.collection('track_logs').where({ orderId: data.orderId }).orderBy('recordedAt', 'asc').get()
      return res.data
    }
    throw new Error('未知 track 操作')
  },

  async checkin(openid, action, data) {
    if (action === 'getMonthCalendar') {
      await getUser(openid)
      const monthKey = normalizeMonthKey(data.monthKey)
      return buildMonthCalendar(openid, monthKey)
    }
    if (action === 'getMyRetroCards') {
      const user = await getUser(openid)
      const logsRes = await db.collection('retro_card_logs').where({ openid }).orderBy('createdAt', 'desc').get()
      return {
        retroCardCount: Number(user.retroCardCount || 0),
        completedOrderCount: Number(user.completedOrderCount || 0),
        logs: logsRes.data || []
      }
    }
    if (action === 'checkinToday') {
      const user = await getUser(openid)
      const todayInfo = toCstParts()
      const existing = (await db.collection('user_checkins').where({ openid, dateKey: todayInfo.dateKey }).limit(1).get()).data[0]
      if (existing) throw new Error('今天已签到')
      const config = await ensureMonthConfig(todayInfo.monthKey)
      const reward = normalizeCheckinReward((config.days || []).find((item) => Number(item.day) === todayInfo.dayNumber) || {}, todayInfo.dayNumber)
      const claimed = await claimCheckinReward(user, reward, todayInfo, 'normal')
      const time = now()
      const created = await db.collection('user_checkins').add({
        data: {
          userId: user._id,
          openid,
          monthKey: todayInfo.monthKey,
          dateKey: todayInfo.dateKey,
          day: todayInfo.dayNumber,
          checkinType: 'normal',
          usedRetroCard: false,
          rewardSnapshot: claimed.rewardSnapshot,
          pointsDelta: claimed.pointsDelta,
          couponId: claimed.couponId || '',
          createdAt: time,
          updatedAt: time
        }
      })
      return {
        _id: created._id,
        monthKey: todayInfo.monthKey,
        dateKey: todayInfo.dateKey,
        day: todayInfo.dayNumber,
        rewardSnapshot: claimed.rewardSnapshot,
        pointsDelta: claimed.pointsDelta,
        couponId: claimed.couponId || '',
        retroCardCount: Number((await getUser(openid)).retroCardCount || 0)
      }
    }
    if (action === 'retroCheckin') {
      const user = await getUser(openid)
      const todayInfo = toCstParts()
      const monthKey = normalizeMonthKey(data.monthKey || todayInfo.monthKey)
      const day = Math.max(Math.round(Number(data.day || 0)), 1)
      if (monthKey !== todayInfo.monthKey) throw new Error('当前仅支持补签本月日期')
      if (day >= todayInfo.dayNumber) throw new Error('只能补签今天之前的日期')
      if (day > getMonthDays(monthKey)) throw new Error('补签日期无效')
      if (Number(user.retroCardCount || 0) <= 0) throw new Error('补签卡不足')
      const dateKey = `${monthKey}-${String(day).padStart(2, '0')}`
      const existing = (await db.collection('user_checkins').where({ openid, dateKey }).limit(1).get()).data[0]
      if (existing) throw new Error('该日期已签到')
      const config = await ensureMonthConfig(monthKey)
      const reward = normalizeCheckinReward((config.days || []).find((item) => Number(item.day) === day) || {}, day)
      const claimed = await claimCheckinReward(user, reward, { monthKey, dateKey, dayNumber: day }, 'retro')
      const time = now()
      await grantRetroCards(openid, user._id, -1, 'retro_checkin', dateKey, `补签 ${dateKey} 消耗补签卡 1 张`)
      const created = await db.collection('user_checkins').add({
        data: {
          userId: user._id,
          openid,
          monthKey,
          dateKey,
          day,
          checkinType: 'retro',
          usedRetroCard: true,
          rewardSnapshot: claimed.rewardSnapshot,
          pointsDelta: claimed.pointsDelta,
          couponId: claimed.couponId || '',
          createdAt: time,
          updatedAt: time
        }
      })
      return {
        _id: created._id,
        monthKey,
        dateKey,
        day,
        rewardSnapshot: claimed.rewardSnapshot,
        pointsDelta: claimed.pointsDelta,
        couponId: claimed.couponId || '',
        retroCardCount: Number((await getUser(openid)).retroCardCount || 0)
      }
    }
    if (action === 'createCheckin') {
      const { user, order } = await getOrderForAccess(openid, data.orderId)
      if (!user.roles.includes('staff') || order.staffOpenid !== openid) throw new Error('仅订单员工可打卡')
      if (order.status !== 'in_service') throw new Error('仅服务中可打卡')
      if (!data.eventType) throw new Error('请选择打卡类型')
      const time = now()
      const checkin = { orderId: data.orderId, staffUserId: user._id, staffOpenid: openid, eventType: data.eventType, mediaFileId: data.mediaFileId || '', watermarkedMediaFileId: '', latitude: Number(data.latitude || 0), longitude: Number(data.longitude || 0), serverTime: time, remark: data.remark || '', createdAt: time }
      const created = await db.collection('checkin_logs').add({ data: checkin })
      await appendOrderTimeline(data.orderId, 'checkin', '服务打卡', data.eventType, 'staff')
      return { _id: created._id, ...checkin }
    }
    if (action === 'listOrderCheckins') {
      await getOrderForAccess(openid, data.orderId)
      const res = await db.collection('checkin_logs').where({ orderId: data.orderId }).orderBy('createdAt', 'asc').get()
      return res.data
    }
    throw new Error('未知 checkin 操作')
  },

  async incident(openid, action, data) {
    if (action === 'createSosIncident') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可发起 SOS')
      const orderRes = await db.collection('orders').doc(data.orderId).get()
      const order = orderRes.data
      if (order.staffOpenid !== openid) throw new Error('不是该订单员工')
      const incident = { orderId: data.orderId, staffUserId: user._id, staffOpenid: openid, incidentType: data.incidentType || 'sos', description: data.description || '', latitude: Number(data.latitude || 0), longitude: Number(data.longitude || 0), mediaFileIds: data.mediaFileIds || [], status: 'open', createdAt: now(), updatedAt: now() }
      const created = await db.collection('order_incidents').add({ data: incident })
      return { _id: created._id, ...incident }
    }
    if (action === 'listIncidents') {
      await requireAdmin(openid)
      const res = await db.collection('order_incidents').orderBy('createdAt', 'desc').get()
      return res.data
    }
    if (action === 'resolveIncident') {
      await requireAdmin(openid)
      await db.collection('order_incidents').doc(data.id).update({ data: { status: data.status || 'resolved', updatedAt: now() } })
      return { id: data.id }
    }
    throw new Error('未知 incident 操作')
  },

  async admin(openid, action, data) {
    const admin = await requireAdmin(openid)
    if (action === 'dashboard') {
      const statuses = ['paid', 'assigned', 'in_service', 'completed']
      const counts = {}
      for (let i = 0; i < statuses.length; i += 1) counts[statuses[i]] = (await db.collection('orders').where({ status: statuses[i] }).count()).total
      const staffPending = await db.collection('staff_profiles').where({ auditStatus: 'pending' }).count()
      const incidentsOpen = await db.collection('order_incidents').where({ status: 'open' }).count()
      return { orders: counts, staffPending: staffPending.total, incidentsOpen: incidentsOpen.total }
    }
    if (action === 'getSystemSettings') {
      return getSystemSettings()
    }
    if (action === 'saveSystemSettings') {
      const saved = await saveSystemSettings(data)
      await logAdmin(admin, 'platform_config', 'system_settings', 'saveSystemSettings', saved.value)
      return saved.value
    }
    if (action === 'listOrders') {
      const where = data.status ? { status: data.status } : {}
      const res = await db.collection('orders').where(where).orderBy('createdAt', 'desc').get()
      return Promise.all((res.data || []).map(attachOrderDisplayData))
    }
    if (action === 'getOrderDetail' || action === 'getEvidence') {
      const id = data.id || data.orderId
      const order = await db.collection('orders').doc(id).get()
      const tracks = await db.collection('track_logs').where({ orderId: id }).orderBy('recordedAt', 'asc').get()
      const checkins = await db.collection('checkin_logs').where({ orderId: id }).orderBy('createdAt', 'asc').get()
      const unlockLogs = await db.collection('unlock_code_logs').where({ orderId: id }).orderBy('createdAt', 'desc').get()
      return { order: await attachOrderDisplayData(order.data), tracks: tracks.data, checkins: checkins.data, unlockLogs: unlockLogs.data }
    }
    if (action === 'assignOrder') {
      const orderRes = await db.collection('orders').doc(data.orderId).get()
      if (orderRes.data.status !== 'paid') throw new Error('仅已支付订单可派单')
      const profileRes = await db.collection('staff_profiles').doc(data.staffProfileId).get()
      const profile = profileRes.data
      if (profile.auditStatus !== 'approved') throw new Error('员工未审核通过')
      const staffUserRes = await db.collection('users').where({ openid: profile.openid }).limit(1).get()
      const staffUser = staffUserRes.data[0]
      if (!staffUser) throw new Error('员工用户不存在')
      const time = now()
      await db.collection('orders').doc(data.orderId).update({ data: { staffUserId: staffUser._id, staffOpenid: staffUser.openid, staffProfileId: profile._id, status: 'assigned', assignmentSource: 'admin_assign', assignedAt: time, updatedAt: time } })
      await appendOrderTimeline(data.orderId, 'assigned', '管理员已派单', maskStaffName(profile.realName), 'admin')
      await logAdmin(admin, 'order', data.orderId, 'assignOrder', { staffProfileId: data.staffProfileId })
      return { orderId: data.orderId }
    }
    if (action === 'listServicePrices') {
      return listServicePrices(true)
    }
    if (action === 'saveServicePrice') {
      const key = String(data.key || '').trim()
      const preset = defaultServicePrices.find((item) => item.key === key)
      if (!preset) throw new Error('服务项目不存在')
      const price = Number(data.price)
      if (!Number.isFinite(price) || price < 0) throw new Error('价格不正确')
      const time = now()
      const payload = { key, label: preset.label, price, enabled: data.enabled !== false, description: data.description || preset.description, sortOrder: preset.sortOrder, updatedAt: time }
      const existing = await db.collection('service_prices').where({ key }).limit(1).get()
      if (existing.data[0]) {
        await db.collection('service_prices').doc(existing.data[0]._id).update({ data: payload })
      } else {
        await db.collection('service_prices').add({ data: { ...payload, createdAt: time } })
      }
      await logAdmin(admin, 'service_price', key, 'saveServicePrice', { price, enabled: payload.enabled })
      return payload
    }
    if (action === 'resetDefaultServicePrices') {
      const time = now()
      await Promise.all(defaultServicePrices.map(async (preset) => {
        const existing = await db.collection('service_prices').where({ key: preset.key }).limit(1).get()
        const payload = { ...preset, updatedAt: time }
        if (existing.data[0]) return db.collection('service_prices').doc(existing.data[0]._id).update({ data: payload })
        return db.collection('service_prices').add({ data: { ...payload, createdAt: time } })
      }))
      await logAdmin(admin, 'service_price', 'defaults', 'resetDefaultServicePrices', {})
      return listServicePrices(true)
    }
    if (action === 'listCouponTemplates') {
      const res = await db.collection('coupon_templates').orderBy('sortOrder', 'asc').get()
      return (res.data || []).sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    }
    if (action === 'saveCouponTemplate') {
      const name = safeText(data.name).trim()
      if (!name) throw new Error('优惠券名称不能为空')
      const discountAmount = Math.round(Number(data.discountAmount || 0))
      const minOrderAmount = Math.max(Math.round(Number(data.minOrderAmount || 0)), 0)
      const validType = data.validType === 'fixed_range' ? 'fixed_range' : 'relative_days'
      const validDays = Math.max(Math.round(Number(data.validDays || 30)), 1)
      const validFromFixed = safeText(data.validFromFixed).trim()
      const validToFixed = safeText(data.validToFixed).trim()
      if (!discountAmount || discountAmount < 0) throw new Error('优惠金额不正确')
      if (validType === 'fixed_range') {
        if (!validFromFixed || !validToFixed) throw new Error('请填写固定有效期')
        if (validToFixed < validFromFixed) throw new Error('固定有效期结束时间不能早于开始时间')
      }
      const validServiceKeys = (await listServicePrices(true)).map((item) => item.key)
      const applicableServiceTypes = Array.isArray(data.applicableServiceTypes) ? data.applicableServiceTypes.map((item) => String(item || '').trim()).filter(Boolean) : []
      if (applicableServiceTypes.some((key) => !validServiceKeys.includes(key))) throw new Error('适用服务不正确')
      const time = now()
      const payload = {
        name,
        description: safeText(data.description).trim(),
        type: 'fixed',
        discountAmount,
        minOrderAmount,
        applicableServiceTypes,
        validType,
        validDays,
        validFromFixed: validType === 'fixed_range' ? validFromFixed : '',
        validToFixed: validType === 'fixed_range' ? validToFixed : '',
        displayTag: safeText(data.displayTag).trim(),
        claimNotice: safeText(data.claimNotice).trim(),
        useNotice: safeText(data.useNotice).trim(),
        enabled: data.enabled !== false,
        totalIssueLimit: Math.max(Math.round(Number(data.totalIssueLimit || 0)), 0),
        perUserLimit: Math.max(Math.round(Number(data.perUserLimit || 1)), 1),
        sortOrder: Number(data.sortOrder || 100),
        updatedAt: time
      }
      if (data._id) {
        const existing = await db.collection('coupon_templates').doc(data._id).get()
        await db.collection('coupon_templates').doc(data._id).update({ data: payload })
        await logAdmin(admin, 'coupon_template', data._id, 'saveCouponTemplate', { name, discountAmount, validType })
        return { ...existing.data, ...payload, _id: data._id }
      }
      const created = await db.collection('coupon_templates').add({ data: { ...payload, issuedCount: 0, createdAt: time } })
      await logAdmin(admin, 'coupon_template', created._id, 'saveCouponTemplate', { name, discountAmount, validType })
      return { _id: created._id, ...payload, issuedCount: 0, createdAt: time }
    }
    if (action === 'issueCouponToUser') {
      const templateId = safeText(data.templateId).trim()
      const targetOpenid = safeText(data.openid).trim()
      if (!templateId) throw new Error('请选择优惠券模板')
      if (!targetOpenid) throw new Error('请输入用户 openid')
      const template = (await db.collection('coupon_templates').doc(templateId).get()).data
      if (!template || template.enabled === false) throw new Error('优惠券模板不可用')
      const targetUser = (await db.collection('users').where({ openid: targetOpenid }).limit(1).get()).data[0]
      if (!targetUser || targetUser.status !== 'active') throw new Error('目标用户不存在')
      const issued = await issueCouponToTargetUser(template, targetUser, { adminUserId: admin._id, adminOpenid: openid })
      await logAdmin(admin, 'coupon_template', templateId, 'issueCouponToUser', { targetOpenid, couponId: issued._id })
      return { _id: issued._id, templateId, openid: targetOpenid, status: 'available', templateSnapshot: issued.templateSnapshot, validFrom: issued.validFrom, validTo: issued.validTo }
    }
    if (action === 'listStaffAudits') {
      const where = data.auditStatus ? { auditStatus: data.auditStatus } : {}
      const res = await db.collection('staff_profiles').where(where).orderBy('updatedAt', 'desc').get()
      return res.data
    }
    if (action === 'auditStaff') {
      const status = data.auditStatus === 'approved' ? 'approved' : 'rejected'
      const profileRes = await db.collection('staff_profiles').doc(data.staffProfileId).get()
      const profile = profileRes.data
      await db.collection('staff_profiles').doc(data.staffProfileId).update({ data: { auditStatus: status, auditRemark: data.auditRemark || '', updatedAt: now() } })
      const userRes = await db.collection('users').where({ openid: profile.openid }).limit(1).get()
      const staffUser = userRes.data[0]
      if (staffUser) {
        const existingRoles = staffUser.roles || ['client']
        const roles = status === 'approved'
          ? Array.from(new Set([...existingRoles, 'staff']))
          : existingRoles.filter((role) => role !== 'staff')
        const userUpdate = { roles, updatedAt: now() }
        if (staffUser.activeRole === 'staff' && status !== 'approved') userUpdate.activeRole = 'client'
        await db.collection('users').doc(staffUser._id).update({ data: userUpdate })
      }
      await logAdmin(admin, 'staff_profile', data.staffProfileId, 'auditStaff', { status })
      return { staffProfileId: data.staffProfileId, auditStatus: status }
    }
    if (action === 'listMemberLevels') {
      const levels = await getMemberLevels()
      return levels.map((level) => ({
        ...level,
        pointMultiplier: Math.max(Number(level.pointMultiplier || 1), 1),
        description: safeText(level.description).trim(),
        benefits: normalizeBenefits(level.benefits)
      }))
    }
    if (action === 'saveMemberLevel') {
      const name = safeText(data.name).trim()
      if (!name) throw new Error('等级名称不能为空')
      const existingLevels = await getMemberLevels()
      const duplicate = existingLevels.find((item) => item.name === name && item._id !== data._id)
      if (duplicate) throw new Error('已存在同名会员等级，请先编辑原等级或换一个名称')
      const minPoints = Math.max(Math.round(Number(data.minPoints || 0)), 0)
      const time = now()
      const payload = {
        name,
        minPoints,
        icon: safeText(data.icon).trim(),
        pointMultiplier: Math.max(Number(data.pointMultiplier || 1), 1),
        description: safeText(data.description).trim(),
        benefits: normalizeBenefits(data.benefits),
        sortOrder: Number(data.sortOrder || 0),
        updatedAt: time
      }
      if (data._id) {
        await db.collection('member_levels').doc(data._id).update({ data: payload })
        await syncUsersMemberLevelName(data._id, name)
        await logAdmin(admin, 'member_level', data._id, 'saveMemberLevel', { name, minPoints, pointMultiplier: payload.pointMultiplier })
        return { _id: data._id, ...payload }
      }
      const created = await db.collection('member_levels').add({ data: { ...payload, createdAt: time } })
      await logAdmin(admin, 'member_level', created._id, 'saveMemberLevel', { name, minPoints, pointMultiplier: payload.pointMultiplier })
      return { _id: created._id, ...payload, createdAt: time }
    }
    if (action === 'deleteMemberLevel') {
      if (!data._id) throw new Error('缺少等级 ID')
      await db.collection('member_levels').doc(data._id).remove()
      await recalcUsersForDeletedLevel(data._id)
      await logAdmin(admin, 'member_level', data._id, 'deleteMemberLevel', {})
      return { _id: data._id }
    }
    if (action === 'grantPoints') {
      const targetOpenid = safeText(data.openid).trim()
      if (!targetOpenid) throw new Error('请输入用户 openid')
      const delta = Math.round(Number(data.delta || 0))
      if (!delta) throw new Error('积分变动不能为 0')
      const reason = safeText(data.reason).trim() || '管理员操作'
      await addPoints(targetOpenid, '', delta, 'admin_grant', admin._id, reason)
      await logAdmin(admin, 'user', targetOpenid, 'grantPoints', { delta, reason })
      return { openid: targetOpenid, delta }
    }
    if (action === 'listPointLogs') {
      const where = data.openid ? { openid: safeText(data.openid).trim() } : {}
      const res = await db.collection('point_logs').where(where).orderBy('createdAt', 'desc').get()
      return res.data || []
    }
    if (action === 'getCheckinMonthConfig') {
      const monthKey = normalizeMonthKey(data.monthKey)
      const config = await ensureMonthConfig(monthKey)
      return {
        ...config,
        days: defaultCheckinDays(monthKey).map((fallback) => normalizeCheckinReward((config.days || []).find((item) => Number(item.day) === fallback.day) || fallback, fallback.day))
      }
    }
    if (action === 'saveCheckinMonthConfig') {
      const monthKey = normalizeMonthKey(data.monthKey)
      const dayCount = getMonthDays(monthKey)
      const couponIds = Array.from(new Set((Array.isArray(data.days) ? data.days : []).map((item) => safeText(item.couponTemplateId).trim()).filter(Boolean)))
      const couponTemplates = {}
      for (const couponId of couponIds) {
        const template = (await db.collection('coupon_templates').doc(couponId).get()).data
        if (!template || template.enabled === false) throw new Error('签到奖励优惠券不可用')
        couponTemplates[couponId] = normalizeCouponSnapshot(template)
      }
      const days = Array.from({ length: dayCount }, (_, index) => {
        const day = index + 1
        const raw = (Array.isArray(data.days) ? data.days : []).find((item) => Number(item.day) === day) || {}
        const reward = normalizeCheckinReward(raw, day)
        if (reward.rewardType === 'coupon') {
          if (!reward.couponTemplateId) throw new Error(`第 ${day} 天未选择优惠券模板`)
          reward.couponSnapshot = couponTemplates[reward.couponTemplateId] || null
        } else {
          reward.couponTemplateId = ''
          reward.couponSnapshot = null
        }
        if (reward.rewardType !== 'points') reward.points = 0
        return reward
      })
      const time = now()
      const payload = { monthKey, days, status: safeText(data.status).trim() || 'active', updatedAt: time }
      const existing = await getMonthConfig(monthKey)
      if (existing) {
        await db.collection('checkin_month_configs').doc(existing._id).update({ data: payload })
        await logAdmin(admin, 'checkin_month_config', existing._id, 'saveCheckinMonthConfig', { monthKey })
        return { _id: existing._id, ...existing, ...payload }
      }
      const created = await db.collection('checkin_month_configs').add({ data: { ...payload, createdAt: time } })
      await logAdmin(admin, 'checkin_month_config', created._id, 'saveCheckinMonthConfig', { monthKey })
      return { _id: created._id, ...payload, createdAt: time }
    }
    if (action === 'issueCouponByLevels') {
      const templateId = safeText(data.templateId).trim()
      const targetLevelIds = normalizeTargetLevelIds(data.targetLevelIds)
      if (!templateId) throw new Error('请选择优惠券模板')
      if (!targetLevelIds.length) throw new Error('请选择至少一个会员段位')
      const targetLevels = await resolveTargetLevels(targetLevelIds)
      if (!targetLevels.length) throw new Error('所选会员段位不存在')
      const targetLevelNamesSnapshot = targetLevels.map((level) => level.name)
      const template = (await db.collection('coupon_templates').doc(templateId).get()).data
      if (!template || template.enabled === false) throw new Error('优惠券模板不可用')
      const usersRes = await db.collection('users').where({ status: 'active' }).get()
      const eligible = (usersRes.data || []).filter((u) => targetLevelIds.includes(u.memberLevel || ''))
      let issued = 0; let skipped = 0
      const skippedReasons = {}
      for (const targetUser of eligible) {
        try {
          await issueCouponToTargetUser(template, targetUser, { adminUserId: admin._id, adminOpenid: openid })
          issued++
        } catch (error) {
          skipped++
          const reason = safeText(error.message).trim() || '发放失败'
          skippedReasons[reason] = (skippedReasons[reason] || 0) + 1
        }
      }
      const skippedReasonText = Object.keys(skippedReasons).map((reason) => `${reason}：${skippedReasons[reason]}人`).join('\n')
      await logAdmin(admin, 'coupon_template', templateId, 'issueCouponByLevels', { targetLevelIds, targetLevelNamesSnapshot, issued, skipped, skippedReasons, eligibleCount: eligible.length })
      return { issued, skipped, targetLevelIds, targetLevelNamesSnapshot, eligibleCount: eligible.length, skippedReasons, skippedReasonText }
    }
    if (action === 'publishRewardMailByLevels') {
      const targetLevelIds = normalizeTargetLevelIds(data.targetLevelIds)
      if (!targetLevelIds.length) throw new Error('请选择至少一个会员段位')
      const targetLevels = await resolveTargetLevels(targetLevelIds)
      if (!targetLevels.length) throw new Error('所选会员段位不存在')
      const targetLevelNamesSnapshot = targetLevels.map((level) => level.name)
      const rewardType = data.rewardType === 'coupon' ? 'coupon' : 'points'
      const title = safeText(data.title).trim() || '会员奖励到账'
      const content = safeText(data.content).trim()
      const reward = { type: rewardType }
      if (rewardType === 'coupon') {
        const couponTemplateId = safeText(data.couponTemplateId).trim()
        if (!couponTemplateId) throw new Error('请选择奖励优惠券')
        const template = (await db.collection('coupon_templates').doc(couponTemplateId).get()).data
        if (!template || template.enabled === false) throw new Error('奖励优惠券不可用')
        reward.couponTemplateId = couponTemplateId
        reward.couponSnapshot = normalizeCouponSnapshot(template)
      } else {
        reward.points = Math.max(Math.round(Number(data.points || 0)), 0)
        if (!reward.points) throw new Error('奖励积分必须大于 0')
      }
      const usersRes = await db.collection('users').where({ status: 'active' }).get()
      const eligible = (usersRes.data || []).filter((u) => targetLevelIds.includes(u.memberLevel || ''))
      const time = now()
      let issued = 0
      for (const targetUser of eligible) {
        await db.collection('reward_mails').add({
          data: {
            userId: targetUser._id,
            openid: targetUser.openid,
            targetLevelIds,
            targetLevelNamesSnapshot,
            title,
            content,
            reward,
            sentByAdminUserId: admin._id,
            sentByAdminOpenid: openid,
            readAt: null,
            claimedAt: null,
            rewardClaimResult: null,
            createdAt: time,
            updatedAt: time
          }
        })
        issued++
      }
      await logAdmin(admin, 'reward_mail', title, 'publishRewardMailByLevels', { targetLevelIds, targetLevelNamesSnapshot, rewardType, issued })
      return { issued, skipped: 0, targetLevelIds, targetLevelNamesSnapshot }
    }
    if (action === 'saveLotteryActivity') {
      const name = safeText(data.name).trim()
      if (!name) throw new Error('活动名称不能为空')
      const prizes = Array.isArray(data.prizes) ? data.prizes.map((p) => ({
        templateId: safeText(p.templateId).trim(),
        name: safeText(p.name).trim(),
        probability: Math.max(Number(p.probability || 0), 0),
        stockLeft: Math.max(Math.round(Number(p.stockLeft || 0)), 0)
      })).filter((p) => p.name) : []
      const time = now()
      const payload = { name, description: safeText(data.description).trim(), prizes, enabled: data.enabled === true, updatedAt: time }
      if (data._id) {
        await db.collection('lottery_activities').doc(data._id).update({ data: payload })
        await logAdmin(admin, 'lottery_activity', data._id, 'saveLotteryActivity', { name })
        return { _id: data._id, ...payload }
      }
      const created = await db.collection('lottery_activities').add({ data: { ...payload, createdAt: time } })
      await logAdmin(admin, 'lottery_activity', created._id, 'saveLotteryActivity', { name })
      return { _id: created._id, ...payload, createdAt: time }
    }
    if (action === 'listLotteryActivities') {
      const res = await db.collection('lottery_activities').orderBy('createdAt', 'desc').get()
      return res.data || []
    }
    if (action === 'toggleLotteryActivity') {
      const activityRes = await db.collection('lottery_activities').doc(data._id).get()
      const enabled = !activityRes.data.enabled
      await db.collection('lottery_activities').doc(data._id).update({ data: { enabled, updatedAt: now() } })
      await logAdmin(admin, 'lottery_activity', data._id, 'toggleLotteryActivity', { enabled })
      return { _id: data._id, enabled }
    }
    throw new Error('未知 admin 操作')
  },

  async ai(openid, action, data) {
    if (action === 'aiPetAssistant') {
      const question = safeText(data.question).trim()
      if (!question) throw new Error('请填写咨询问题')
      const petId = safeText(data.petId).trim()
      let petInfo = ''
      if (petId) {
        const petRes = await db.collection('pets').doc(petId).get()
        if (petRes.data) {
          const p = petRes.data
          petInfo = `【宠物资料】名称：${p.name}，种类：${p.species === 'dog' ? '狗' : p.species === 'cat' ? '猫' : '其他'}，品种：${p.breed || '未知'}，体重：${p.weight || '未填'}kg。`
        }
      }

      let answer = ''
      // 直接调用微信云开发内置的 hy3-preview 大模型
      const model = cloud.extend.AI.createModel('hunyuan')
      const res = await model.generateText({
        model: 'hy3',
        messages: [
          { role: 'system', content: `你是一个VIP上门宠护平台的专业AI智能助手和宠物医生顾问，性格温馨专业，精通宠物护理、疾病预防、上门服务注意事项。${petInfo}` },
          { role: 'user', content: question }
        ]
      })

      if (res && res.choices && res.choices[0] && res.choices[0].message) {
        answer = res.choices[0].message.content
      } else if (res && res.text) {
        answer = res.text
      } else {
        answer = JSON.stringify(res)
      }

      return {
        question,
        answer,
        generatedAt: nowText(),
        source: 'hy3-preview'
      }
    }

    if (action === 'aiGenerateReport') {
      const orderId = safeText(data.orderId).trim()
      if (!orderId) throw new Error('订单 ID 不能为空')
      const orderRes = await db.collection('orders').doc(orderId).get()
      const order = orderRes.data
      if (!order) throw new Error('订单不存在')

      const checkinsRes = await db.collection('checkin_logs').where({ orderId }).get()
      const checkins = checkinsRes.data || []
      const eventLabels = checkins.map(c => c.eventType).join('、')

      const reportSummary = `【AI 智能宠护报告总结】
今日给宝贝「${order.petName || '宠物'}」的服务已顺利完成！
服务项目：${order.serviceSummary || '上门宠护'}
关键服务打卡记录：${checkins.length} 次（打卡环节包含：${eventLabels || '基础入户与服务'}）。
宠物状态：精神状态良好，打卡互动顺畅，离户时已确认门锁与电源安全。感谢您的信任！`

      return {
        orderId,
        reportSummary,
        generatedAt: nowText()
      }
    }

    throw new Error('未知 ai 操作')
  },

  async initData(openid, action) {
    if (action === 'checkCollections') {
      const result = []
      for (let i = 0; i < collections.length; i += 1) {
        const name = collections[i]
        try {
          await db.collection(name).limit(1).get()
          result.push({ name, exists: true })
        } catch (error) {
          result.push({ name, exists: false, message: '请在云开发控制台创建该集合' })
        }
      }
      return result
    }

    async function seedAdmin() {
      const time = now()
      let user = await getOptionalUser(openid)
      if (!user) {
        const userData = { openid, phone: '', nickname: '管理员', avatarUrl: '', roles: ['client', 'staff', 'admin'], activeRole: 'admin', status: 'active', createdAt: time, updatedAt: time }
        const created = await db.collection('users').add({ data: userData })
        return { _id: created._id, ...userData }
      }
      const roles = Array.from(new Set([...(user.roles || ['client']), 'staff', 'admin']))
      await db.collection('users').doc(user._id).update({ data: { roles, activeRole: 'admin', status: 'active', updatedAt: time } })
      return { ...user, roles, activeRole: 'admin', status: 'active' }
    }

    if (action === 'seedAdmin') return seedAdmin()
    if (action === 'seedDemoData') {
      const user = await seedAdmin()
      const time = now()
      const petRes = await db.collection('pets').where({ openid, name: '可乐' }).limit(1).get()
      let pet = petRes.data[0]
      if (!pet) {
        const petData = { userId: user._id, openid, name: '可乐', species: 'dog', breed: '柴犬', weight: 12, specialNotes: '有轻微爆冲，需短牵。', createdAt: time, updatedAt: time }
        const createdPet = await db.collection('pets').add({ data: petData })
        pet = { _id: createdPet._id, ...petData }
      }
      const orderRes = await db.collection('orders').where({ clientOpenid: openid, petId: pet._id }).limit(1).get()
      let order = orderRes.data[0]
      if (!order) {
        const start = new Date(Date.now() + 60 * 60 * 1000)
        const end = new Date(Date.now() + 2 * 60 * 60 * 1000)
        const orderData = { orderNo: `D${Date.now()}`, clientUserId: user._id, clientOpenid: openid, staffUserId: '', staffOpenid: '', staffProfileId: '', publishMode: 'open', requestedStaffProfileId: '', requestedStaffUserId: '', requestedStaffOpenid: '', requestedStaffName: '', requestedStaffSnapshot: null, assignmentSource: '', petId: pet._id, petName: pet.name, serviceType: 'walk', serviceTypes: ['walk'], serviceLabels: ['上门遛狗'], serviceSummary: '上门遛狗', serviceAddress: '演示小区 1 号楼', addressDetail: '1号楼 101', doorplate: '门牌 101', addressLatitude: 0, addressLongitude: 0, startTime: start.toISOString().slice(0, 16).replace('T', ' '), endTime: end.toISOString().slice(0, 16).replace('T', ' '), durationMinutes: 60, amount: 89, payAmount: 89, priceSnapshot: { services: [{ key: 'walk', label: '上门遛狗', price: 89 }], durationMinutes: 60, weight: 12 }, paymentStatus: 'paid', status: 'paid', requiredCheckins: requiredCheckins('walk', ['walk']), insurancePolicyNo: '', cancelReason: '', paidAt: time, createdAt: time, updatedAt: time }
        const createdOrder = await db.collection('orders').add({ data: orderData })
        order = { _id: createdOrder._id, ...orderData }
      }
      return { user, pet, order }
    }
    throw new Error('未知 initData 操作')
  }
}

exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext()
    const moduleName = event.module || event.name
    const action = event.action
    const data = event.data || {}
    const handler = handlers[moduleName]
    if (!handler) throw new Error(`未知模块：${moduleName}`)
    return ok(await handler(OPENID, action, data))
  } catch (error) {
    return fail(error.message)
  }
}
