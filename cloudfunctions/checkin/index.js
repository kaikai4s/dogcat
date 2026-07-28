const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

function ok(data) { return { ok: true, data } }
function fail(message) { return { ok: false, message } }
function now() { return new Date() }

async function getUser(openid) {
  const res = await db.collection('users').where({ openid }).limit(1).get()
  const user = res.data[0]
  if (!user || user.status !== 'active') throw new Error('请先登录')
  return user
}

async function getOrderForAccess(openid, orderId) {
  const user = await getUser(openid)
  const res = await db.collection('orders').doc(orderId).get()
  const order = res.data
  const allowed = order.clientOpenid === openid || order.staffOpenid === openid || user.roles.includes('admin')
  if (!allowed) throw new Error('无权访问打卡')
  return { user, order }
}

async function createCheckin(openid, data) {
  const { user, order } = await getOrderForAccess(openid, data.orderId)
  if (!user.roles.includes('staff') || order.staffOpenid !== openid) throw new Error('仅订单员工可打卡')
  if (order.status !== 'in_service') throw new Error('仅服务中可打卡')
  if (!data.eventType) throw new Error('请选择打卡类型')

  const time = now()
  const checkin = {
    orderId: data.orderId,
    staffUserId: user._id,
    staffOpenid: openid,
    eventType: data.eventType,
    mediaFileId: data.mediaFileId || '',
    watermarkedMediaFileId: '',
    latitude: Number(data.latitude || 0),
    longitude: Number(data.longitude || 0),
    serverTime: time,
    remark: data.remark || '',
    createdAt: time
  }
  const created = await db.collection('checkin_logs').add({ data: checkin })
  return { _id: created._id, ...checkin }
}

async function listOrderCheckins(openid, data) {
  await getOrderForAccess(openid, data.orderId)
  const res = await db.collection('checkin_logs').where({ orderId: data.orderId }).orderBy('createdAt', 'asc').get()
  return res.data
}

exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext()
    const action = event.action
    const data = event.data || {}
    if (action === 'createCheckin') return ok(await createCheckin(OPENID, data))
    if (action === 'listOrderCheckins') return ok(await listOrderCheckins(OPENID, data))
    return fail('未知操作')
  } catch (error) {
    return fail(error.message)
  }
}
