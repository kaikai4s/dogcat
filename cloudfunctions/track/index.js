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
  if (!allowed) throw new Error('无权访问轨迹')
  return { user, order }
}

async function batchUploadTrack(openid, data) {
  const { user, order } = await getOrderForAccess(openid, data.orderId)
  if (!user.roles.includes('staff') || order.staffOpenid !== openid) throw new Error('仅订单员工可上传轨迹')
  if (order.status !== 'in_service') throw new Error('仅服务中可上传轨迹')

  const points = Array.isArray(data.points) ? data.points : []
  const uploadedAt = now()
  const tasks = points.slice(0, 50).map((point) => db.collection('track_logs').add({
    data: {
      orderId: data.orderId,
      staffUserId: user._id,
      staffOpenid: openid,
      latitude: Number(point.latitude),
      longitude: Number(point.longitude),
      speed: Number(point.speed || 0),
      accuracy: Number(point.accuracy || 0),
      recordedAt: point.recordedAt || uploadedAt,
      uploadedAt
    }
  }))
  await Promise.all(tasks)
  return { count: tasks.length }
}

async function getOrderTracks(openid, data) {
  await getOrderForAccess(openid, data.orderId)
  const res = await db.collection('track_logs').where({ orderId: data.orderId }).orderBy('recordedAt', 'asc').get()
  return res.data
}

exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext()
    const action = event.action
    const data = event.data || {}
    if (action === 'batchUploadTrack') return ok(await batchUploadTrack(OPENID, data))
    if (action === 'getOrderTracks') return ok(await getOrderTracks(OPENID, data))
    return fail('未知操作')
  } catch (error) {
    return fail(error.message)
  }
}
