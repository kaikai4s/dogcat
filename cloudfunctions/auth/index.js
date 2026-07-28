const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

function ok(data) {
  return { ok: true, data }
}

function fail(message) {
  return { ok: false, message }
}

function now() {
  return new Date()
}

async function getCurrentUser(openid) {
  const res = await db.collection('users').where({ openid }).limit(1).get()
  return res.data[0]
}

async function login(openid) {
  let user = await getCurrentUser(openid)
  const time = now()

  if (!user) {
    const userData = {
      openid,
      phone: '',
      nickname: '微信用户',
      avatarUrl: '',
      roles: ['client', 'staff'],
      activeRole: 'client',
      status: 'active',
      createdAt: time,
      updatedAt: time
    }
    const created = await db.collection('users').add({ data: userData })
    user = { _id: created._id, ...userData }
  }

  if (user.status !== 'active') {
    throw new Error('账号不可用')
  }

  return user
}

async function bindPhone(openid, data) {
  const phone = String(data.phone || '').trim()
  if (!phone) throw new Error('手机号不能为空')

  const user = await getCurrentUser(openid)
  if (!user) throw new Error('请先登录')

  await db.collection('users').doc(user._id).update({
    data: { phone, updatedAt: now() }
  })

  return { ...user, phone }
}

async function switchRole(openid, data) {
  const role = data.role
  const user = await getCurrentUser(openid)
  if (!user) throw new Error('请先登录')
  if (!Array.isArray(user.roles) || !user.roles.includes(role)) {
    throw new Error('当前账号无此角色权限')
  }

  await db.collection('users').doc(user._id).update({
    data: { activeRole: role, updatedAt: now() }
  })

  return { ...user, activeRole: role }
}

exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext()
    const action = event.action
    const data = event.data || {}

    if (action === 'login') return ok(await login(OPENID))
    if (action === 'me') {
      const user = await getCurrentUser(OPENID)
      if (!user) throw new Error('请先登录')
      return ok(user)
    }
    if (action === 'bindPhone') return ok(await bindPhone(OPENID, data))
    if (action === 'switchRole') return ok(await switchRole(OPENID, data))

    return fail('未知操作')
  } catch (error) {
    return fail(error.message)
  }
}
