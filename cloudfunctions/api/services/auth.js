module.exports = function createService({
  db,
  authorizeAdmin
}) {
  async function getUser(openid) {
    const res = await db.collection('users').where({ openid }).limit(1).get()
    const user = res.data[0]
    if (!user || user.status !== 'active') throw new Error('请先登录')
    return user
  }

  async function getOptionalUser(openid) {
    const res = await db.collection('users').where({ openid }).limit(1).get()
    return res.data[0]
  }

  async function requireAdmin(openid) {
    const user = await getUser(openid)
    if (!Array.isArray(user.roles) || !user.roles.includes('admin')) throw new Error('仅管理员可操作')
    return authorizeAdmin(user)
  }

  return {
    getUser,
    getOptionalUser,
    requireAdmin
  }
}
