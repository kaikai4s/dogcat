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

async function createSosIncident(openid, data) {
  const user = await getUser(openid)
  if (!user.roles.includes('staff')) throw new Error('仅员工可发起 SOS')
  const orderRes = await db.collection('orders').doc(data.orderId).get()
  const order = orderRes.data
  if (order.staffOpenid !== openid) throw new Error('不是该订单员工')

  const incident = {
    orderId: data.orderId,
    staffUserId: user._id,
    staffOpenid: openid,
    incidentType: data.incidentType || 'sos',
    description: data.description || '',
    latitude: Number(data.latitude || 0),
    longitude: Number(data.longitude || 0),
    mediaFileIds: data.mediaFileIds || [],
    status: 'open',
    createdAt: now(),
    updatedAt: now()
  }
  const created = await db.collection('order_incidents').add({ data: incident })
  return { _id: created._id, ...incident }
}

async function listIncidents(openid) {
  const user = await getUser(openid)
  if (!user.roles.includes('admin')) throw new Error('仅管理员可查看')
  const res = await db.collection('order_incidents').orderBy('createdAt', 'desc').get()
  return res.data
}

async function resolveIncident(openid, data) {
  const user = await getUser(openid)
  if (!user.roles.includes('admin')) throw new Error('仅管理员可处理')
  await db.collection('order_incidents').doc(data.id).update({ data: { status: data.status || 'resolved', updatedAt: now() } })
  return { id: data.id }
}

exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext()
    const action = event.action
    const data = event.data || {}
    if (action === 'createSosIncident') return ok(await createSosIncident(OPENID, data))
    if (action === 'listIncidents') return ok(await listIncidents(OPENID, data))
    if (action === 'resolveIncident') return ok(await resolveIncident(OPENID, data))
    return fail('未知操作')
  } catch (error) {
    return fail(error.message)
  }
}
