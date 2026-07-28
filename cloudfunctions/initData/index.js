const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const collections = [
  'users',
  'pets',
  'home_security',
  'staff_profiles',
  'orders',
  'payments',
  'track_logs',
  'checkin_logs',
  'unlock_code_logs',
  'order_incidents',
  'admin_operation_logs'
]

function ok(data) { return { ok: true, data } }
function fail(message) { return { ok: false, message } }
function now() { return new Date() }

async function getUser(openid) {
  const res = await db.collection('users').where({ openid }).limit(1).get()
  return res.data[0]
}

async function seedAdmin(openid) {
  const time = now()
  let user = await getUser(openid)

  if (!user) {
    const data = {
      openid,
      phone: '',
      nickname: '管理员',
      avatarUrl: '',
      roles: ['client', 'staff', 'admin'],
      activeRole: 'admin',
      status: 'active',
      createdAt: time,
      updatedAt: time
    }
    const created = await db.collection('users').add({ data })
    return { _id: created._id, ...data }
  }

  const roles = Array.from(new Set([...(user.roles || ['client']), 'staff', 'admin']))
  await db.collection('users').doc(user._id).update({
    data: {
      roles,
      activeRole: 'admin',
      status: 'active',
      updatedAt: time
    }
  })

  return { ...user, roles, activeRole: 'admin', status: 'active' }
}

async function seedDemoData(openid) {
  const user = await seedAdmin(openid)
  const time = now()

  const petRes = await db.collection('pets').where({ openid, name: '可乐' }).limit(1).get()
  let pet = petRes.data[0]
  if (!pet) {
    const data = {
      userId: user._id,
      openid,
      name: '可乐',
      species: 'dog',
      breed: '柴犬',
      weight: 12,
      specialNotes: '有轻微爆冲，需短牵。',
      createdAt: time,
      updatedAt: time
    }
    const created = await db.collection('pets').add({ data })
    pet = { _id: created._id, ...data }
  }

  const orderRes = await db.collection('orders').where({ clientOpenid: openid, petId: pet._id }).limit(1).get()
  let order = orderRes.data[0]
  if (!order) {
    const start = new Date(Date.now() + 60 * 60 * 1000)
    const end = new Date(Date.now() + 2 * 60 * 60 * 1000)
    const data = {
      orderNo: `D${Date.now()}`,
      clientUserId: user._id,
      clientOpenid: openid,
      staffUserId: '',
      staffOpenid: '',
      petId: pet._id,
      petName: pet.name,
      serviceType: 'walk',
      serviceAddress: '演示小区 1 号楼',
      addressLatitude: 0,
      addressLongitude: 0,
      startTime: start.toISOString().slice(0, 16).replace('T', ' '),
      endTime: end.toISOString().slice(0, 16).replace('T', ' '),
      amount: 89,
      payAmount: 89,
      paymentStatus: 'paid',
      status: 'paid',
      requiredCheckins: ['enter_door', 'leash_on', 'return_home', 'leave_door'],
      insurancePolicyNo: '',
      cancelReason: '',
      paidAt: time,
      createdAt: time,
      updatedAt: time
    }
    const created = await db.collection('orders').add({ data })
    order = { _id: created._id, ...data }
  }

  return { user, pet, order }
}

async function checkCollections() {
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

exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext()
    const action = event.action

    if (action === 'checkCollections') return ok(await checkCollections())
    if (action === 'seedAdmin') return ok(await seedAdmin(OPENID))
    if (action === 'seedDemoData') return ok(await seedDemoData(OPENID))

    return fail('未知操作')
  } catch (error) {
    return fail(error.message)
  }
}
