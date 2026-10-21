const { readOptionalDocument } = require('../utils/documentPages')

module.exports = function createService({
  db,
  crypto,
  authorizeAdmin
}) {
  async function getUser(openid) {
    if (typeof openid !== 'string' || !openid.trim()) throw new Error('请先登录')
    const res = await db.collection('users').where({ openid }).limit(1).get()
    const user = res.data[0]
    if (!user || user.status !== 'active') throw new Error('请先登录')
    return user
  }

  async function getOptionalUser(openid) {
    if (typeof openid !== 'string' || !openid.trim()) return null
    const res = await db.collection('users').where({ openid }).limit(1).get()
    return res.data[0]
  }

  async function createUserOnce(openid, data) {
    if (typeof openid !== 'string' || !openid.trim()) throw new Error('请先登录')
    const id = `user_${crypto.createHash('sha256').update(openid).digest('hex').slice(0, 32)}`
    return db.runTransaction(async tx => {
      const current = await readOptionalDocument(tx, 'users', id)
      if (current) {
        if (current.openid !== openid || current.status !== 'active') throw new Error('账号不可用')
        return current
      }
      const historical = (await tx.collection('users').where({ openid }).limit(1).get()).data[0]
      if (historical) return historical
      await tx.collection('users').doc(id).set({ data: { ...data, openid } })
      return { ...data, openid, _id: id }
    })
  }

  async function requireAdmin(openid) {
    const user = await getUser(openid)
    if (!Array.isArray(user.roles) || !user.roles.includes('admin')) throw new Error('仅管理员可操作')
    return authorizeAdmin(user)
  }

  return {
    getUser,
    getOptionalUser,
    createUserOnce,
    requireAdmin
  }
}
