const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const collections = [
  'users', 'pets', 'home_security', 'staff_profiles', 'orders', 'payments',
  'track_logs', 'checkin_logs', 'unlock_code_logs', 'order_incidents', 'admin_operation_logs', 'service_prices',
  'sitter_favorites', 'service_reviews', 'user_addresses', 'order_timeline', 'platform_configs'
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
  return { ...profile, nickname: user.nickname || '', avatarUrl: user.avatarUrl || '' }
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

async function calcOrderPricing(data, pet) {
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
  return {
    amount,
    payAmount: amount,
    currency: 'CNY',
    serviceTypes,
    serviceLabels,
    serviceSummary: serviceLabels.join('、'),
    durationMinutes,
    priceItems,
    priceSnapshot: { services: priceItems, durationMinutes, weight }
  }
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

async function appendOrderTimeline(orderId, type, title, detail, actorRole) {
  await db.collection('order_timeline').add({
    data: { orderId, type, title, detail: detail || '', actorRole: actorRole || '', createdAt: now() }
  })
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
    favorite: await isFavoriteSitter(openid, profile._id),
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
  async auth(openid, action, data) {
    if (action === 'login') {
      let user = await getOptionalUser(openid)
      const time = now()
      if (!user) {
        const userData = { openid, phone: '', nickname: '微信用户', avatarUrl: '', roles: ['client'], activeRole: 'client', status: 'active', createdAt: time, updatedAt: time }
        const created = await db.collection('users').add({ data: userData })
        user = { _id: created._id, ...userData }
      }
      if (user.status !== 'active') throw new Error('账号不可用')
      return user
    }

    if (action === 'me') return getUser(openid)

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
      return calcOrderPricing(data, pet)
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
      const pricing = await calcOrderPricing(data, petRes.data)
      const requestedStaff = await getRequestedStaff(data)
      const time = now()
      const order = { orderNo: `O${Date.now()}${Math.floor(Math.random() * 1000)}`, clientUserId: user._id, clientOpenid: openid, staffUserId: '', staffOpenid: '', staffProfileId: '', ...requestedStaff, assignmentSource: '', sourceOrderId: data.sourceOrderId || '', petId: data.petId, petName: petRes.data.name, petSnapshot: { name: petRes.data.name || '', avatarFileId: petRes.data.avatarFileId || '', species: petRes.data.species || '', breed: petRes.data.breed || '', gender: petRes.data.gender || '', birthday: petRes.data.birthday || '', weight: Number(petRes.data.weight || 0), personality: petRes.data.personality || '', favoriteFood: petRes.data.favoriteFood || '', dislikes: petRes.data.dislikes || '', healthNotes: petRes.data.healthNotes || '', specialNotes: petRes.data.specialNotes || '' }, serviceType: pricing.serviceTypes[0], serviceTypes: pricing.serviceTypes, serviceLabels: pricing.serviceLabels, serviceSummary: pricing.serviceSummary, serviceAddress: data.serviceAddress || '', addressDetail: data.addressDetail || '', doorplate: data.doorplate || '', addressLatitude: Number(data.addressLatitude || 0), addressLongitude: Number(data.addressLongitude || 0), startTime: data.startTime, endTime: data.endTime, durationMinutes: pricing.durationMinutes, amount: pricing.amount, payAmount: pricing.payAmount, priceSnapshot: pricing.priceSnapshot, paymentStatus: 'unpaid', status: 'pending_pay', requiredCheckins: requiredCheckins(pricing.serviceTypes[0], pricing.serviceTypes), insurancePolicyNo: '', cancelReason: '', refundStatus: '', refundAmount: 0, createdAt: time, updatedAt: time }
      const created = await db.collection('orders').add({ data: order })
      await appendOrderTimeline(created._id, 'created', '订单已创建', order.serviceSummary, 'client')
      return { _id: created._id, ...order }
    }

    if (action === 'listOrders') {
      const user = await getUser(openid)
      const role = data.role || user.activeRole || 'client'
      const where = role === 'staff' ? { staffOpenid: openid } : { clientOpenid: openid }
      const res = await db.collection('orders').where(where).orderBy('createdAt', 'desc').get()
      return res.data
    }

    if (action === 'getOrderDetail') {
      const { order } = await getOrderForAccess(openid, data.id)
      return attachPetSnapshot(order)
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
      return { id: data.id }
    }

    if (action === 'getServiceReport') {
      const order = (await getOrderForAccess(openid, data.id)).order
      const tracks = await db.collection('track_logs').where({ orderId: data.id }).orderBy('recordedAt', 'asc').get()
      const checkins = await db.collection('checkin_logs').where({ orderId: data.id }).orderBy('createdAt', 'asc').get()
      return { order, tracks: tracks.data, checkins: checkins.data }
    }
    throw new Error('未知 order 操作')
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
      await db.collection('payments').add({ data: { orderId: data.orderId, orderNo: order.orderNo, paymentNo: `P${Date.now()}${Math.floor(Math.random() * 1000)}`, wxTransactionId: '', amount: order.payAmount, status: 'success', paidAt: time, rawCallback: { mock: true }, createdAt: time, updatedAt: time } })
      await db.collection('orders').doc(data.orderId).update({ data: { paymentStatus: 'paid', status: 'paid', paidAt: time, updatedAt: time } })
      await appendOrderTimeline(data.orderId, 'paid', '订单已支付', `支付金额 ¥${order.payAmount}`, 'client')
      return { orderId: data.orderId, status: 'paid' }
    }
    throw new Error('未知 payment 操作')
  },

  async staff(openid, action, data) {
    if (action === 'listApprovedSitters') {
      await getUser(openid)
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
      await getUser(openid)
      const profileRes = await db.collection('staff_profiles').doc(data.staffProfileId).get()
      const profile = profileRes.data
      if (!profile || profile.auditStatus !== 'approved') throw new Error('宠托师不可用')
      return toPublicSitterDetail(openid, await withSitterUserProfile(profile))
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
          if (profileRes.data && profileRes.data.auditStatus === 'approved') list.push({ ...(await toPublicSitterDetail(openid, profileRes.data)), favorite: true })
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
      const profile = { userId: user._id, openid, realName: data.realName || '', phone: data.phone || user.phone || '', serviceCity: data.serviceCity || '', serviceAreas: data.serviceAreas || '', faceVerifyStatus: 'pending', auditStatus: 'pending', auditRemark: '', updatedAt: time }
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
      return res.data
        .filter(isOpenOrder)
        .map((order) => {
          const distanceKm = calcDistanceKm(latitude, longitude, order.addressLatitude, order.addressLongitude)
          return { ...order, distanceKm, distanceText: formatDistance(distanceKm) }
        })
        .sort((a, b) => (a.distanceKm === null ? 999999 : a.distanceKm) - (b.distanceKm === null ? 999999 : b.distanceKm))
        .slice(0, 20)
    }
    if (action === 'listDirectOrders') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可查看')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = profileRes.data[0] || {}
      const res = await db.collection('orders').where({ status: 'paid' }).orderBy('startTime', 'asc').get()
      return res.data
        .filter((order) => order.publishMode === 'direct' && !order.staffOpenid && order.requestedStaffOpenid === openid)
        .map((order) => {
          const distanceKm = calcDistanceKm(profile.currentLatitude, profile.currentLongitude, order.addressLatitude, order.addressLongitude)
          return { ...order, distanceKm, distanceText: formatDistance(distanceKm) }
        })
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
      const res = await db.collection('orders').where({ staffOpenid: openid }).orderBy('startTime', 'asc').get()
      return res.data.map((order) => {
        const distanceKm = calcDistanceKm(profile.currentLatitude, profile.currentLongitude, order.addressLatitude, order.addressLongitude)
        return { ...order, distanceKm, distanceText: formatDistance(distanceKm) }
      })
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
    if (action === 'listOrders') {
      const where = data.status ? { status: data.status } : {}
      const res = await db.collection('orders').where(where).orderBy('createdAt', 'desc').get()
      return res.data
    }
    if (action === 'getOrderDetail' || action === 'getEvidence') {
      const id = data.id || data.orderId
      const order = await db.collection('orders').doc(id).get()
      const tracks = await db.collection('track_logs').where({ orderId: id }).orderBy('recordedAt', 'asc').get()
      const checkins = await db.collection('checkin_logs').where({ orderId: id }).orderBy('createdAt', 'asc').get()
      const unlockLogs = await db.collection('unlock_code_logs').where({ orderId: id }).orderBy('createdAt', 'desc').get()
      return { order: order.data, tracks: tracks.data, checkins: checkins.data, unlockLogs: unlockLogs.data }
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
    throw new Error('未知 admin 操作')
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
