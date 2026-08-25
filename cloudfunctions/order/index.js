const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

function ok(data) { return { ok: true, data } }
function fail(message) { return { ok: false, message } }
function now() { return new Date() }

function getKey() {
  const secret = process.env.HOME_SECURITY_KEY || 'dev-only-change-this-key-before-production'
  return crypto.createHash('sha256').update(secret).digest()
}

function encryptText(value) {
  if (!value) return { cipher: '', iv: '', tag: '' }
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv)
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
  return {
    cipher: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64')
  }
}

function mask(value) {
  const text = String(value || '')
  if (!text) return ''
  return text.length <= 2 ? '**' : `${text.slice(0, 1)}***${text.slice(-1)}`
}

function parseTime(value) {
  const date = value instanceof Date ? value : new Date(String(value || '').replace(' ', 'T'))
  const time = date.getTime()
  if (Number.isNaN(time)) throw new Error('时间格式不正确')
  return time
}

function isCovered(start, end, coverStart, coverEnd) {
  return parseTime(coverStart) <= parseTime(start) && parseTime(coverEnd) >= parseTime(end)
}

function securityTypeText(type) {
  if (type === 'someone_home') return '有人在家，敲门即可'
  if (type === 'remote_unlock') return '上门后远程开门'
  if (type === 'one_time_code') return '一次性密码'
  if (type === 'key') return '钥匙/门禁卡'
  return '入户方式'
}

function buildOrderHomeSecurity(data) {
  const legacyMap = {
    handover: 'someone_home',
    password: 'one_time_code',
    key: 'key',
    other: 'someone_home'
  }
  const input = data.orderHomeSecurity || data.homeSecurity || {}
  const type = input.type || legacyMap[data.lockMethod] || 'someone_home'
  const time = now()
  const base = {
    type,
    lockMethodText: securityTypeText(type),
    entryNotes: input.entryNotes || data.entryNotes || '',
    createdAt: time,
    updatedAt: time
  }

  if (type === 'someone_home') return base

  if (type === 'remote_unlock') {
    return {
      ...base,
      remoteUnlock: {
        lastRequestedAt: '',
        requestCount: 0,
        notifyChannels: ['wechat', 'admin_phone'],
        lastNotifyStatus: { wechat: '', admin_phone: '' }
      }
    }
  }

  if (type === 'one_time_code') {
    const code = input.code || input.doorLockCode || data.doorLockCode
    const effectiveStart = input.effectiveStart || data.doorLockCodeStartTime
    const effectiveEnd = input.effectiveEnd || data.doorLockCodeEndTime
    if (!String(code || '').trim()) throw new Error('请填写一次性开门密码')
    if (!effectiveStart || !effectiveEnd) throw new Error('请选择一次性密码有效时间')
    if (parseTime(effectiveEnd) <= parseTime(effectiveStart)) throw new Error('一次性密码结束时间必须晚于开始时间')
    const coversServiceTime = isCovered(data.startTime, data.endTime, effectiveStart, effectiveEnd)
    if (!coversServiceTime) throw new Error('一次性密码有效期需要覆盖完整服务时间')
    const encrypted = encryptText(code)
    return {
      ...base,
      hasDoorLockCode: true,
      oneTimeCode: {
        cipher: encrypted.cipher,
        iv: encrypted.iv,
        tag: encrypted.tag,
        masked: mask(code),
        effectiveStart,
        effectiveEnd,
        coversServiceTime
      }
    }
  }

  if (type === 'key') {
    const location = input.location || data.keyLocation || ''
    const imageFileIds = input.imageFileIds || data.keyImageFileIds || []
    if (!String(location || '').trim()) throw new Error('请填写钥匙放置位置')
    if (!Array.isArray(imageFileIds) || !imageFileIds.length) throw new Error('请上传钥匙放置位置图片')
    return {
      ...base,
      key: {
        location,
        imageFileIds,
        returnRequired: true,
        returnedAt: '',
        returnImageFileIds: [],
        returnNote: ''
      }
    }
  }

  throw new Error('请选择有效的入户方式')
}

function stripSensitiveSecurity(security) {
  if (!security) return security
  const safe = { ...security }
  if (safe.oneTimeCode) {
    safe.oneTimeCode = {
      masked: safe.oneTimeCode.masked || '',
      effectiveStart: safe.oneTimeCode.effectiveStart || '',
      effectiveEnd: safe.oneTimeCode.effectiveEnd || '',
      coversServiceTime: Boolean(safe.oneTimeCode.coversServiceTime)
    }
    safe.hasDoorLockCode = true
  }
  return safe
}

async function getUser(openid) {
  const res = await db.collection('users').where({ openid }).limit(1).get()
  const user = res.data[0]
  if (!user || user.status !== 'active') throw new Error('请先登录')
  return user
}

function calcAmount(data, pet) {
  const weight = Number(pet && pet.weight || data.weight || 0)
  const isWalk = data.serviceType === 'walk'
  if (weight > 25) return isWalk ? 119 : 89
  if (weight >= 10) return isWalk ? 89 : 69
  return isWalk ? 69 : 59
}

function requiredCheckins(serviceType) {
  return serviceType === 'walk'
    ? ['enter_door', 'leash_on', 'return_home', 'leave_door']
    : ['enter_door', 'feed', 'water', 'pet_status', 'leave_door']
}

async function quoteOrder(openid, data) {
  await getUser(openid)
  let pet = null
  if (data.petId) {
    const petRes = await db.collection('pets').doc(data.petId).get()
    if (petRes.data.openid !== openid) throw new Error('宠物不存在')
    pet = petRes.data
  }
  const amount = calcAmount(data, pet)
  return { amount, payAmount: amount, currency: 'CNY' }
}

async function createOrder(openid, data) {
  const user = await getUser(openid)
  if (!data.petId) throw new Error('请选择宠物')
  if (!data.serviceType) throw new Error('请选择服务类型')
  if (!data.startTime || !data.endTime) throw new Error('请选择服务时间')

  const petRes = await db.collection('pets').doc(data.petId).get()
  if (petRes.data.openid !== openid) throw new Error('宠物不存在')

  const amount = calcAmount(data, petRes.data)
  const time = now()
  const orderHomeSecurity = buildOrderHomeSecurity(data)
  const order = {
    orderNo: `O${Date.now()}${Math.floor(Math.random() * 1000)}`,
    clientUserId: user._id,
    clientOpenid: openid,
    staffUserId: '',
    staffOpenid: '',
    petId: data.petId,
    petName: petRes.data.name,
    serviceType: data.serviceType,
    serviceAddress: data.serviceAddress || '',
    addressDetail: data.addressDetail || '',
    doorplate: data.doorplate || '',
    publishMode: data.publishMode || 'open',
    requestedStaffName: data.requestedStaffName || '',
    staffProfileId: data.staffProfileId || '',
    addressLatitude: Number(data.addressLatitude || 0),
    addressLongitude: Number(data.addressLongitude || 0),
    startTime: data.startTime,
    endTime: data.endTime,
    durationMinutes: Number(data.durationMinutes || 0),
    amount,
    payAmount: amount,
    paymentStatus: 'unpaid',
    status: 'pending_pay',
    requiredCheckins: requiredCheckins(data.serviceType),
    orderHomeSecurity,
    insurancePolicyNo: '',
    cancelReason: '',
    createdAt: time,
    updatedAt: time
  }

  const created = await db.collection('orders').add({ data: order })
  return { _id: created._id, ...order, orderHomeSecurity: stripSensitiveSecurity(orderHomeSecurity) }
}

async function listOrders(openid, data) {
  const user = await getUser(openid)
  const role = data.role || user.activeRole || 'client'
  const where = role === 'staff' ? { staffOpenid: openid } : { clientOpenid: openid }
  const res = await db.collection('orders').where(where).orderBy('createdAt', 'desc').get()
  return res.data.map((order) => ({ ...order, orderHomeSecurity: stripSensitiveSecurity(order.orderHomeSecurity) }))
}

async function getOrderDetail(openid, data) {
  const user = await getUser(openid)
  const res = await db.collection('orders').doc(data.id).get()
  const order = res.data
  const isOwner = order.clientOpenid === openid || order.staffOpenid === openid
  const isAdmin = user.roles.includes('admin')
  if (!isOwner && !isAdmin) throw new Error('无权访问订单')
  return { ...order, orderHomeSecurity: stripSensitiveSecurity(order.orderHomeSecurity) }
}

async function cancelOrder(openid, data) {
  const order = await getOrderDetail(openid, { id: data.id || data.orderId })
  if (!['pending_pay', 'paid', 'assigned'].includes(order.status)) throw new Error('当前状态不可取消')
  await db.collection('orders').doc(data.id || data.orderId).update({ data: { status: 'cancelled', cancelReason: data.reason || '', updatedAt: now() } })
  return { id: data.id || data.orderId }
}

async function startService(openid, data) {
  const user = await getUser(openid)
  if (!user.roles.includes('staff')) throw new Error('仅员工可开始服务')
  const order = await getOrderDetail(openid, { id: data.id })
  if (order.staffOpenid !== openid) throw new Error('不是该订单员工')
  if (order.status !== 'assigned') throw new Error('订单状态不可开始')
  await db.collection('orders').doc(data.id).update({ data: { status: 'in_service', startedAt: now(), arrivedAt: now(), updatedAt: now() } })
  return { id: data.id }
}

async function finishService(openid, data) {
  const user = await getUser(openid)
  if (!user.roles.includes('staff')) throw new Error('仅员工可完成服务')
  const order = await getOrderDetail(openid, { id: data.id })
  if (order.staffOpenid !== openid) throw new Error('不是该订单员工')
  if (order.status !== 'in_service') throw new Error('订单状态不可完成')

  const checkins = await db.collection('checkin_logs').where({ orderId: data.id }).get()
  const eventSet = checkins.data.reduce((map, item) => ({ ...map, [item.eventType]: true }), {})
  const missing = (order.requiredCheckins || []).filter((eventType) => !eventSet[eventType])
  if (missing.length) throw new Error(`缺少强制打卡：${missing.join(',')}`)

  const security = order.orderHomeSecurity || {}
  if (security.type === 'key' && security.key && security.key.returnRequired && !security.key.returnedAt) {
    throw new Error('请先完成放回钥匙打卡')
  }

  await db.collection('orders').doc(data.id).update({ data: { status: 'completed', completedAt: now(), updatedAt: now() } })
  return { id: data.id }
}

async function getServiceReport(openid, data) {
  const order = await getOrderDetail(openid, { id: data.id })
  const tracks = await db.collection('track_logs').where({ orderId: data.id }).orderBy('recordedAt', 'asc').get()
  const checkins = await db.collection('checkin_logs').where({ orderId: data.id }).orderBy('createdAt', 'asc').get()
  return { order, tracks: tracks.data, checkins: checkins.data }
}

exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext()
    const action = event.action
    const data = event.data || {}
    if (action === 'quoteOrder') return ok(await quoteOrder(OPENID, data))
    if (action === 'createOrder') return ok(await createOrder(OPENID, data))
    if (action === 'listOrders') return ok(await listOrders(OPENID, data))
    if (action === 'getOrderDetail') return ok(await getOrderDetail(OPENID, data))
    if (action === 'cancelOrder') return ok(await cancelOrder(OPENID, data))
    if (action === 'startService') return ok(await startService(OPENID, data))
    if (action === 'finishService') return ok(await finishService(OPENID, data))
    if (action === 'getServiceReport') return ok(await getServiceReport(OPENID, data))
    return fail('未知操作')
  } catch (error) {
    return fail(error.message)
  }
}
