const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

function ok(data) { return { ok: true, data } }
function fail(message) { return { ok: false, message } }
function now() { return new Date() }

async function getAdmin(openid) {
  const res = await db.collection('users').where({ openid }).limit(1).get()
  const user = res.data[0]
  if (!user || user.status !== 'active') throw new Error('请先登录')
  if (!Array.isArray(user.roles) || !user.roles.includes('admin')) throw new Error('仅管理员可操作')
  return user
}

async function log(admin, targetType, targetId, action, detail) {
  await db.collection('admin_operation_logs').add({
    data: {
      adminUserId: admin._id,
      adminOpenid: admin.openid,
      targetType,
      targetId,
      action,
      detail: detail || {},
      createdAt: now()
    }
  })
}

async function dashboard(openid) {
  await getAdmin(openid)
  const statuses = ['paid', 'assigned', 'in_service', 'completed']
  const counts = {}
  for (let i = 0; i < statuses.length; i += 1) {
    const res = await db.collection('orders').where({ status: statuses[i] }).count()
    counts[statuses[i]] = res.total
  }
  const staffPending = await db.collection('staff_profiles').where({ auditStatus: 'pending' }).count()
  const incidentsOpen = await db.collection('order_incidents').where({ status: 'open' }).count()
  return { orders: counts, staffPending: staffPending.total, incidentsOpen: incidentsOpen.total }
}

async function listOrders(openid, data) {
  await getAdmin(openid)
  const where = data.status ? { status: data.status } : {}
  const res = await db.collection('orders').where(where).orderBy('createdAt', 'desc').get()
  return res.data
}

async function getOrderDetail(openid, data) {
  await getAdmin(openid)
  const order = await db.collection('orders').doc(data.id).get()
  const tracks = await db.collection('track_logs').where({ orderId: data.id }).orderBy('recordedAt', 'asc').get()
  const checkins = await db.collection('checkin_logs').where({ orderId: data.id }).orderBy('createdAt', 'asc').get()
  const unlockLogs = await db.collection('unlock_code_logs').where({ orderId: data.id }).orderBy('createdAt', 'desc').get()
  return { order: order.data, tracks: tracks.data, checkins: checkins.data, unlockLogs: unlockLogs.data }
}

async function assignOrder(openid, data) {
  const admin = await getAdmin(openid)
  const orderRes = await db.collection('orders').doc(data.orderId).get()
  const order = orderRes.data
  if (order.status !== 'paid') throw new Error('仅已支付订单可派单')

  const staffProfileRes = await db.collection('staff_profiles').doc(data.staffProfileId).get()
  const profile = staffProfileRes.data
  if (profile.auditStatus !== 'approved') throw new Error('员工未审核通过')

  const staffUserRes = await db.collection('users').where({ openid: profile.openid }).limit(1).get()
  const staffUser = staffUserRes.data[0]
  if (!staffUser) throw new Error('员工用户不存在')

  await db.collection('orders').doc(data.orderId).update({
    data: {
      staffUserId: staffUser._id,
      staffOpenid: staffUser.openid,
      status: 'assigned',
      assignedAt: now(),
      updatedAt: now()
    }
  })
  await log(admin, 'order', data.orderId, 'assignOrder', { staffProfileId: data.staffProfileId })
  return { orderId: data.orderId }
}

async function listStaffAudits(openid, data) {
  await getAdmin(openid)
  const where = data.auditStatus ? { auditStatus: data.auditStatus } : {}
  const res = await db.collection('staff_profiles').where(where).orderBy('updatedAt', 'desc').get()
  return res.data
}

async function auditStaff(openid, data) {
  const admin = await getAdmin(openid)
  const status = data.auditStatus === 'approved' ? 'approved' : 'rejected'
  const profileRes = await db.collection('staff_profiles').doc(data.staffProfileId).get()
  const profile = profileRes.data

  await db.collection('staff_profiles').doc(data.staffProfileId).update({
    data: { auditStatus: status, auditRemark: data.auditRemark || '', updatedAt: now() }
  })

  const userRes = await db.collection('users').where({ openid: profile.openid }).limit(1).get()
  const staffUser = userRes.data[0]
  if (staffUser && status === 'approved') {
    const roles = Array.from(new Set([...(staffUser.roles || ['client']), 'staff']))
    await db.collection('users').doc(staffUser._id).update({ data: { roles, updatedAt: now() } })
  }

  await log(admin, 'staff_profile', data.staffProfileId, 'auditStaff', { status })
  return { staffProfileId: data.staffProfileId, auditStatus: status }
}

async function getEvidence(openid, data) {
  return getOrderDetail(openid, { id: data.orderId })
}

exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext()
    const action = event.action
    const data = event.data || {}
    if (action === 'dashboard') return ok(await dashboard(OPENID, data))
    if (action === 'listOrders') return ok(await listOrders(OPENID, data))
    if (action === 'getOrderDetail') return ok(await getOrderDetail(OPENID, data))
    if (action === 'assignOrder') return ok(await assignOrder(OPENID, data))
    if (action === 'listStaffAudits') return ok(await listStaffAudits(OPENID, data))
    if (action === 'auditStaff') return ok(await auditStaff(OPENID, data))
    if (action === 'getEvidence') return ok(await getEvidence(OPENID, data))
    return fail('未知操作')
  } catch (error) {
    return fail(error.message)
  }
}
