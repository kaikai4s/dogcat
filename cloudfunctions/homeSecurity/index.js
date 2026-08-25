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

function decryptText(cipher, iv, tag) {
  if (!cipher || !iv || !tag) return ''
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(cipher, 'base64')),
    decipher.final()
  ]).toString('utf8')
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

function historySummary(order) {
  const security = stripSensitiveSecurity(order.orderHomeSecurity)
  if (!security) return null
  return {
    orderId: order._id,
    orderNo: order.orderNo || '',
    serviceTime: `${order.startTime || ''} - ${order.endTime || ''}`,
    startTime: order.startTime || '',
    endTime: order.endTime || '',
    serviceAddress: order.serviceAddress || '',
    type: security.type,
    lockMethodText: security.lockMethodText || securityTypeText(security.type),
    orderHomeSecurity: security,
    createdAt: order.createdAt || ''
  }
}

async function getCustomerServiceSnapshot() {
  const res = await db.collection('platform_configs').where({ key: 'system_settings' }).limit(1).get()
  const settings = (res.data[0] && res.data[0].value) || {}
  const customerService = settings.customerService || {}
  return {
    phone: customerService.phone || '',
    wechatId: customerService.wechatId || '',
    workHours: customerService.workHours || '每天 9:00-21:00',
    officialAccountName: customerService.officialAccountName || ''
  }
}

async function getUser(openid) {
  const res = await db.collection('users').where({ openid }).limit(1).get()
  const user = res.data[0]
  if (!user || user.status !== 'active') throw new Error('请先登录')
  return user
}

async function getOrder(orderId) {
  const orderRes = await db.collection('orders').doc(orderId).get()
  return orderRes.data
}

async function saveHomeSecurity(openid, data) {
  const user = await getUser(openid)
  const encrypted = encryptText(data.doorLockCode || '')
  const payload = {
    userId: user._id,
    openid,
    doorLockCodeCipher: encrypted.cipher,
    doorLockCodeIv: encrypted.iv,
    doorLockCodeTag: encrypted.tag,
    keyLocation: data.keyLocation || '',
    entryNotes: data.entryNotes || '',
    cameraLocations: data.cameraLocations || '',
    forbiddenAreas: data.forbiddenAreas || '',
    emergencyContactName: data.emergencyContactName || '',
    emergencyContactPhone: data.emergencyContactPhone || '',
    updatedAt: now()
  }

  const existing = await db.collection('home_security').where({ openid }).limit(1).get()
  if (existing.data[0]) {
    await db.collection('home_security').doc(existing.data[0]._id).update({ data: payload })
    return { _id: existing.data[0]._id, ...payload, doorLockCodeMasked: mask(data.doorLockCode || '') }
  }

  const created = await db.collection('home_security').add({ data: payload })
  return { _id: created._id, ...payload, doorLockCodeMasked: mask(data.doorLockCode || '') }
}

async function getMaskedHomeSecurity(openid) {
  await getUser(openid)
  const res = await db.collection('home_security').where({ openid }).limit(1).get()
  const record = res.data[0]
  if (!record) return null
  const plain = decryptText(record.doorLockCodeCipher, record.doorLockCodeIv, record.doorLockCodeTag)
  return { ...record, doorLockCodeCipher: undefined, doorLockCodeIv: undefined, doorLockCodeTag: undefined, doorLockCodeMasked: mask(plain) }
}

async function listHomeSecurityHistory(openid, data) {
  await getUser(openid)
  const limit = Math.min(Number(data.limit || 30), 50)
  const res = await db.collection('orders').where({ clientOpenid: openid }).orderBy('createdAt', 'desc').get()
  return res.data.map(historySummary).filter(Boolean).slice(0, limit)
}

async function getUnlockCode(openid, data) {
  const user = await getUser(openid)
  const order = await getOrder(data.orderId)
  let result = 'forbidden'
  let reason = ''

  try {
    if (!user.roles.includes('staff')) throw new Error('仅员工可查看')
    if (order.staffOpenid !== openid) throw new Error('不是该订单绑定员工')
    if (!['assigned', 'in_service'].includes(order.status)) throw new Error('订单状态不允许查看')

    const current = now().getTime()
    const start = parseTime(order.startTime) - 30 * 60 * 1000
    const end = parseTime(order.endTime)
    if (current < start || current > end) throw new Error('不在服务解锁时间窗口')

    const security = order.orderHomeSecurity || {}
    if (security.type !== 'one_time_code' || !security.oneTimeCode) throw new Error('该订单未设置一次性密码')

    const effectiveStart = parseTime(security.oneTimeCode.effectiveStart)
    const effectiveEnd = parseTime(security.oneTimeCode.effectiveEnd)
    if (current < effectiveStart) throw new Error('一次性密码尚未生效，请提醒用户重新设置或等待生效')
    if (current > effectiveEnd) throw new Error('一次性密码已过期，请提醒用户重新设置')

    const doorLockCode = decryptText(security.oneTimeCode.cipher, security.oneTimeCode.iv, security.oneTimeCode.tag)
    result = 'success'
    reason = 'ok'
    return {
      lockMethodText: security.lockMethodText || securityTypeText(security.type),
      doorLockCode,
      effectiveStart: security.oneTimeCode.effectiveStart,
      effectiveEnd: security.oneTimeCode.effectiveEnd,
      entryNotes: security.entryNotes || ''
    }
  } catch (error) {
    reason = error.message
    throw error
  } finally {
    await db.collection('unlock_code_logs').add({
      data: {
        orderId: data.orderId,
        staffUserId: user._id,
        staffOpenid: openid,
        result,
        reason,
        createdAt: now()
      }
    })
  }
}

async function requestRemoteUnlock(openid, data) {
  const user = await getUser(openid)
  if (!user.roles.includes('staff')) throw new Error('仅员工可请求开门')
  const order = await getOrder(data.orderId)
  if (order.staffOpenid !== openid) throw new Error('不是该订单绑定员工')
  if (!['assigned', 'in_service'].includes(order.status)) throw new Error('订单状态不允许请求开门')
  const security = order.orderHomeSecurity || {}
  if (security.type !== 'remote_unlock') throw new Error('该订单不是远程开门方式')

  const remoteUnlock = security.remoteUnlock || { requestCount: 0, notifyChannels: ['wechat', 'admin_phone'], lastNotifyStatus: {} }
  const current = now()
  if (remoteUnlock.lastRequestedAt && current.getTime() - parseTime(remoteUnlock.lastRequestedAt) < 2 * 60 * 1000) {
    throw new Error('开门请求发送过于频繁，请稍后再试')
  }

  const customerServiceSnapshot = await getCustomerServiceSnapshot()
  const updatedSecurity = {
    ...security,
    remoteUnlock: {
      ...remoteUnlock,
      lastRequestedAt: current.toISOString(),
      requestCount: Number(remoteUnlock.requestCount || 0) + 1,
      notifyChannels: ['wechat', 'admin_phone'],
      lastNotifyStatus: { wechat: 'pending', admin_phone: 'available' },
      customerServiceSnapshot
    },
    updatedAt: current
  }
  await db.collection('orders').doc(data.orderId).update({ data: { orderHomeSecurity: updatedSecurity, updatedAt: current } })
  await db.collection('home_security_notifications').add({
    data: {
      orderId: data.orderId,
      type: 'remote_unlock',
      clientOpenid: order.clientOpenid,
      staffOpenid: openid,
      channels: ['wechat', 'admin_phone'],
      status: { wechat: 'pending', admin_phone: 'available' },
      customerServiceSnapshot,
      createdAt: current
    }
  })
  return stripSensitiveSecurity(updatedSecurity)
}

async function updateOrderOneTimeCode(openid, data) {
  await getUser(openid)
  const order = await getOrder(data.orderId)
  if (order.clientOpenid !== openid) throw new Error('无权修改该订单')
  if (!['pending_pay', 'paid', 'assigned', 'in_service'].includes(order.status)) throw new Error('当前订单状态不可修改密码')
  if (!String(data.code || '').trim()) throw new Error('请填写一次性开门密码')
  if (!data.effectiveStart || !data.effectiveEnd) throw new Error('请选择一次性密码有效时间')
  if (parseTime(data.effectiveEnd) <= parseTime(data.effectiveStart)) throw new Error('一次性密码结束时间必须晚于开始时间')

  const coversServiceTime = isCovered(order.startTime, order.endTime, data.effectiveStart, data.effectiveEnd)
  const encrypted = encryptText(data.code)
  const current = now()
  const updatedSecurity = {
    ...(order.orderHomeSecurity || {}),
    type: 'one_time_code',
    lockMethodText: securityTypeText('one_time_code'),
    entryNotes: data.entryNotes || (order.orderHomeSecurity && order.orderHomeSecurity.entryNotes) || '',
    hasDoorLockCode: true,
    oneTimeCode: {
      cipher: encrypted.cipher,
      iv: encrypted.iv,
      tag: encrypted.tag,
      masked: mask(data.code),
      effectiveStart: data.effectiveStart,
      effectiveEnd: data.effectiveEnd,
      coversServiceTime
    },
    updatedAt: current
  }
  await db.collection('orders').doc(data.orderId).update({ data: { orderHomeSecurity: updatedSecurity, updatedAt: current } })
  return stripSensitiveSecurity(updatedSecurity)
}

async function recordKeyReturned(openid, data) {
  const user = await getUser(openid)
  if (!user.roles.includes('staff')) throw new Error('仅员工可操作')
  const order = await getOrder(data.orderId)
  if (order.staffOpenid !== openid) throw new Error('不是该订单绑定员工')
  const security = order.orderHomeSecurity || {}
  if (security.type !== 'key' || !security.key) throw new Error('该订单不是钥匙入户方式')
  const imageFileIds = data.imageFileIds || []
  if (!Array.isArray(imageFileIds) || !imageFileIds.length) throw new Error('请上传放回钥匙位置图片')
  const current = now()
  const updatedSecurity = {
    ...security,
    key: {
      ...security.key,
      returnedAt: current.toISOString(),
      returnImageFileIds: imageFileIds,
      returnNote: data.note || ''
    },
    updatedAt: current
  }
  await db.collection('orders').doc(data.orderId).update({ data: { orderHomeSecurity: updatedSecurity, updatedAt: current } })
  return stripSensitiveSecurity(updatedSecurity)
}

exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext()
    const action = event.action
    const data = event.data || {}

    if (action === 'saveHomeSecurity') return ok(await saveHomeSecurity(OPENID, data))
    if (action === 'getMaskedHomeSecurity') return ok(await getMaskedHomeSecurity(OPENID))
    if (action === 'listHomeSecurityHistory') return ok(await listHomeSecurityHistory(OPENID, data))
    if (action === 'getUnlockCode') return ok(await getUnlockCode(OPENID, data))
    if (action === 'requestRemoteUnlock') return ok(await requestRemoteUnlock(OPENID, data))
    if (action === 'updateOrderOneTimeCode') return ok(await updateOrderOneTimeCode(OPENID, data))
    if (action === 'recordKeyReturned') return ok(await recordKeyReturned(OPENID, data))

    return fail('未知操作')
  } catch (error) {
    return fail(error.message)
  }
}
