const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

function ok(data) { return { ok: true, data } }
function fail(message) { return { ok: false, message } }
function now() { return new Date() }

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
    addressLatitude: Number(data.addressLatitude || 0),
    addressLongitude: Number(data.addressLongitude || 0),
    startTime: data.startTime,
    endTime: data.endTime,
    amount,
    payAmount: amount,
    paymentStatus: 'unpaid',
    status: 'pending_pay',
    requiredCheckins: requiredCheckins(data.serviceType),
    insurancePolicyNo: '',
    cancelReason: '',
    createdAt: time,
    updatedAt: time
  }

  const created = await db.collection('orders').add({ data: order })
  return { _id: created._id, ...order }
}

async function listOrders(openid, data) {
  const user = await getUser(openid)
  const role = data.role || user.activeRole || 'client'
  const where = role === 'staff' ? { staffOpenid: openid } : { clientOpenid: openid }
  const res = await db.collection('orders').where(where).orderBy('createdAt', 'desc').get()
  return res.data
}

async function getOrderDetail(openid, data) {
  const user = await getUser(openid)
  const res = await db.collection('orders').doc(data.id).get()
  const order = res.data
  const isOwner = order.clientOpenid === openid || order.staffOpenid === openid
  const isAdmin = user.roles.includes('admin')
  if (!isOwner && !isAdmin) throw new Error('无权访问订单')
  return order
}

async function cancelOrder(openid, data) {
  const order = await getOrderDetail(openid, { id: data.id })
  if (!['pending_pay', 'paid', 'assigned'].includes(order.status)) throw new Error('当前状态不可取消')
  await db.collection('orders').doc(data.id).update({ data: { status: 'cancelled', cancelReason: data.reason || '', updatedAt: now() } })
  return { id: data.id }
}

async function startService(openid, data) {
  const user = await getUser(openid)
  if (!user.roles.includes('staff')) throw new Error('仅员工可开始服务')
  const order = await getOrderDetail(openid, { id: data.id })
  if (order.staffOpenid !== openid) throw new Error('不是该订单员工')
  if (order.status !== 'assigned') throw new Error('订单状态不可开始')
  await db.collection('orders').doc(data.id).update({ data: { status: 'in_service', startedAt: now(), updatedAt: now() } })
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
