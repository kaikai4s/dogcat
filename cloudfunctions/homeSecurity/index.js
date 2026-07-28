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
  if (!value) return ''
  return value.length <= 2 ? '**' : `${value.slice(0, 1)}***${value.slice(-1)}`
}

async function getUser(openid) {
  const res = await db.collection('users').where({ openid }).limit(1).get()
  const user = res.data[0]
  if (!user || user.status !== 'active') throw new Error('请先登录')
  return user
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

async function getUnlockCode(openid, data) {
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

    const doorLockCode = decryptText(security.doorLockCodeCipher, security.doorLockCodeIv, security.doorLockCodeTag)
    result = 'success'
    reason = 'ok'
    return { doorLockCode, keyLocation: security.keyLocation || '', entryNotes: security.entryNotes || '' }
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

exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext()
    const action = event.action
    const data = event.data || {}

    if (action === 'saveHomeSecurity') return ok(await saveHomeSecurity(OPENID, data))
    if (action === 'getMaskedHomeSecurity') return ok(await getMaskedHomeSecurity(OPENID))
    if (action === 'getUnlockCode') return ok(await getUnlockCode(OPENID, data))

    return fail('未知操作')
  } catch (error) {
    return fail(error.message)
  }
}
