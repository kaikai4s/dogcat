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

async function getStaffProfile(openid) {
  await getUser(openid)
  const res = await db.collection('staff_profiles').where({ openid }).limit(1).get()
  return res.data[0] || null
}

async function submitStaffProfile(openid, data) {
  const user = await getUser(openid)
  const time = now()
  const profile = {
    userId: user._id,
    openid,
    realName: data.realName || '',
    phone: data.phone || user.phone || '',
    idCardFrontFileId: data.idCardFrontFileId || '',
    idCardBackFileId: data.idCardBackFileId || '',
    noCriminalRecordFileId: data.noCriminalRecordFileId || '',
    qualificationCertFileId: data.qualificationCertFileId || '',
    healthCertFileId: data.healthCertFileId || '',
    serviceCity: data.serviceCity || '',
    serviceAreas: data.serviceAreas || '',
    faceVerifyStatus: 'pending',
    auditStatus: 'pending',
    auditRemark: '',
    updatedAt: time
  }

  const existing = await db.collection('staff_profiles').where({ openid }).limit(1).get()
  if (existing.data[0]) {
    await db.collection('staff_profiles').doc(existing.data[0]._id).update({ data: profile })
    return { _id: existing.data[0]._id, ...profile }
  }

  const created = await db.collection('staff_profiles').add({ data: { ...profile, createdAt: time } })
  return { _id: created._id, ...profile, createdAt: time }
}

async function listStaffOrders(openid) {
  const user = await getUser(openid)
  if (!user.roles.includes('staff')) throw new Error('仅员工可查看')
  const res = await db.collection('orders').where({ staffOpenid: openid }).orderBy('startTime', 'asc').get()
  return res.data
}

exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext()
    const action = event.action
    const data = event.data || {}
    if (action === 'getStaffProfile') return ok(await getStaffProfile(OPENID))
    if (action === 'submitStaffProfile') return ok(await submitStaffProfile(OPENID, data))
    if (action === 'listStaffOrders') return ok(await listStaffOrders(OPENID))
    if (action === 'acceptOrder') return fail('MVP 使用管理员手动派单')
    return fail('未知操作')
  } catch (error) {
    return fail(error.message)
  }
}
