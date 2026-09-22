const { AsyncLocalStorage } = require('async_hooks')
const { tree, permissions, ownerActions } = require('../config/adminPermissions')

module.exports = function createService({ db, crypto, now }) {
  const scope = new AsyncLocalStorage()
  const denied = () => Object.assign(new Error('没有此后台功能的权限'), { code: 'ADMIN_FORBIDDEN' })
  async function optional(tx, collection, id) {
    try { return (await tx.collection(collection).doc(id).get()).data || null } catch (error) {
      if (String(error.message).includes(`document with _id ${id} does not exist`)) return null
      throw error
    }
  }
  async function policy() { return optional(db, 'admin_access_config', 'policy') }
  async function access(user) {
    const config = await policy()
    const superAdmin = config?.enabled ? config.ownerOpenid === user.openid : true
    if (superAdmin) return { enabled: !!config?.enabled, superAdmin: true, permissions: [...permissions], groupIds: [] }
    const membership = await optional(db, 'admin_memberships', user._id)
    const granted = new Set()
    const groupIds = membership?.groupIds || []
    for (const id of groupIds) {
      const group = await optional(db, 'admin_groups', id)
      if (group?.enabled) for (const permission of group.permissions || []) if (permissions.has(permission)) granted.add(permission)
    }
    return { enabled: true, superAdmin: false, permissions: [...granted], groupIds }
  }
  async function begin(user) {
    const request = scope.getStore()
    if (!request || request.logId) return
    request.logId = crypto.randomBytes(16).toString('hex')
    const target = {}
    // Deliberately do not persist payloads, credentials, messages or payment evidence.
    for (const field of ['id', '_id', 'orderId', 'userId', 'openid', 'incidentId', 'groupId']) {
      if (typeof request.data[field] === 'string') target[field] = request.data[field].slice(0, 128)
    }
    await db.collection('admin_access_logs').doc(request.logId).set({ data: {
      actorOpenid: user.openid, actorUserId: user._id, actorName: user.nickname || '',
      module: request.module, action: request.action, permission: `${request.module}.${request.action}`,
      target, status: 'started', createdAt: now()
    } })
  }
  async function authorizeAdmin(user, permission) {
    const request = scope.getStore()
    // Service calls without an RPC scope retain their existing role check.
    if (!request) {
      const current = await access(user)
      if (!current.superAdmin) throw denied()
      return user
    }
    await begin(user)
    const current = await access(user)
    const key = permission || `${request.module}.${request.action}`
    if (key === 'admin.getMyAdminAccess') return user
    if (current.superAdmin) return user
    if (ownerActions.has(key) || !current.permissions.includes(key)) throw denied()
    if (key === 'admin.getSystemSettings' && request.data.includeSecrets === true) throw denied()
    // Editing roles or administrators is never delegated through ordinary user editing.
    if (['admin.updateUserProfile', 'admin.deleteUser', 'admin.hardDeleteUser'].includes(key)) {
      const target = (await db.collection('users').where({ openid: request.data.openid }).limit(1).get()).data[0]
      if (target?.roles?.includes('admin')) throw denied()
      if (key === 'admin.updateUserProfile' && request.data.roles?.includes('admin')) throw denied()
      if (key === 'admin.updateUserProfile' && target) {
        if (JSON.stringify([...(request.data.roles || ['client'])].sort()) !== JSON.stringify([...(target.roles || ['client'])].sort())) throw denied()
        for (const field of ['points', 'totalPoints', 'retroCardCount']) {
          if (Number(request.data[field] || 0) !== Number(target[field] || 0) && !current.permissions.includes('admin.grantPoints')) throw denied()
        }
      }
    }
    return user
  }
  async function runAdminRequest(module, action, data, callback) {
    const request = { module, action, data, logId: '' }
    return scope.run(request, async () => {
      let status = 'succeeded', errorCode = ''
      try { return await callback() } catch (error) {
        status = error.code === 'ADMIN_FORBIDDEN' ? 'denied' : 'failed'
        errorCode = error.code || 'OPERATION_FAILED'
        throw error
      } finally {
        if (request.logId) {
          try { await db.collection('admin_access_logs').doc(request.logId).update({ data: { status, errorCode, completedAt: now() } }) }
          catch (error) { console.error('[admin-audit] completion unavailable', request.logId) }
        }
      }
    })
  }
  async function owner(tx, user) {
    const config = await optional(tx, 'admin_access_config', 'policy')
    if (!config?.enabled || config.ownerOpenid !== user.openid) throw denied()
    return config
  }
  async function page(collection, where, data, project = item => item) {
    const size = 30
    const condition = { ...where }
    if (data.cursor) condition._id = db.command.gt(String(data.cursor))
    const rows = (await db.collection(collection).where(condition).orderBy('_id', 'asc').limit(size + 1).get()).data || []
    return { list: rows.slice(0, size).map(project), hasMore: rows.length > size, cursor: rows.length > size ? rows[size - 1]._id : '' }
  }
  async function handleAdminAccess(user, action, data) {
    if (action === 'getMyAdminAccess') return { ...await access(user), tree }
    if (action === 'enableAdminPermissions') return db.runTransaction(async tx => {
      const current = await optional(tx, 'admin_access_config', 'policy')
      if (current?.enabled) {
        if (current.ownerOpenid !== user.openid) throw denied()
        return { enabled: true }
      }
      const latest = (await tx.collection('users').doc(user._id).get()).data
      if (latest.status !== 'active' || !latest.roles?.includes('admin')) throw denied()
      await tx.collection('admin_access_config').doc('policy').set({ data: { enabled: true, ownerOpenid: user.openid, ownerUserId: user._id, createdAt: now() } })
      return { enabled: true }
    })
    if (action === 'listAdminGroups') return page('admin_groups', {}, data)
    if (action === 'saveAdminGroup') {
      const name = String(data.name || '').trim()
      if (!name || name.length > 40) throw new Error('用户组名称为1至40个字符')
      if (!Array.isArray(data.permissions) || data.permissions.some(key => !permissions.has(key))) throw new Error('权限树包含无效权限')
      const id = data.id ? String(data.id) : crypto.randomBytes(16).toString('hex')
      return db.runTransaction(async tx => {
        await owner(tx, user)
        const previous = await optional(tx, 'admin_groups', id)
        if (data.id && !previous) throw new Error('用户组不存在')
        if (previous && previous.revision !== data.revision) throw new Error('用户组已被修改，请刷新')
        const group = { name, enabled: data.enabled === true, permissions: [...new Set(data.permissions)], revision: (previous?.revision || 0) + 1, updatedAt: now(), updatedBy: user.openid }
        await tx.collection('admin_groups').doc(id).set({ data: group })
        return { _id: id, ...group }
      })
    }
    if (action === 'setAdminMembership') {
      if (!Array.isArray(data.groupIds) || data.groupIds.length > 10 || data.groupIds.some(id => typeof id !== 'string')) throw new Error('最多分配10个用户组')
      const target = (await db.collection('users').where({ openid: String(data.openid || '') }).limit(1).get()).data[0]
      if (!target) throw new Error('用户不存在')
      return db.runTransaction(async tx => {
        const config = await owner(tx, user)
        if (config.ownerOpenid === target.openid) throw new Error('超级管理员不通过用户组修改')
        const latest = (await tx.collection('users').doc(target._id).get()).data
        if (!latest || latest.status !== 'active') throw new Error('用户状态不可用')
        const membership = await optional(tx, 'admin_memberships', target._id)
        if ((membership?.revision || 0) !== Number(data.revision || 0)) throw new Error('人员权限已更新，请刷新')
        for (const id of data.groupIds) if (!(await optional(tx, 'admin_groups', id))?.enabled) throw new Error('用户组不存在或已停用')
        const roles = [...new Set([...(latest.roles || ['client']), 'admin'])]
        const value = { openid: latest.openid, groupIds: [...new Set(data.groupIds)], revision: (membership?.revision || 0) + 1, updatedAt: now(), updatedBy: user.openid }
        await tx.collection('users').doc(target._id).update({ data: { roles, updatedAt: now() } })
        await tx.collection('admin_memberships').doc(target._id).set({ data: value })
        return value
      })
    }
    if (action === 'listAdminMembers' || action === 'listOperationActors') return page('users', { roles: db.command.in(['admin']) }, data, item => ({ _id: item._id, openid: item.openid, nickname: item.nickname || '', status: item.status }))
    if (action === 'getAdminMembership') {
      await owner(db, user)
      const target = (await db.collection('users').where({ openid: String(data.openid || '') }).limit(1).get()).data[0]
      if (!target) throw new Error('用户不存在')
      return await optional(db, 'admin_memberships', target._id) || { openid: target.openid, groupIds: [], revision: 0 }
    }
    if (action === 'listOperationLogs') {
      const where = {}
      if (data.actorOpenid) where.actorOpenid = String(data.actorOpenid)
      if (data.status) where.status = String(data.status)
      if (data.module) where.module = String(data.module)
      if (data.action) where.action = String(data.action)
      const pageNumber = Math.max(1, Math.min(10000, Math.floor(Number(data.page) || 1)))
      const rows = (await db.collection('admin_access_logs').where(where).orderBy('createdAt', 'desc').orderBy('_id', 'desc').skip((pageNumber - 1) * 30).limit(31).get()).data || []
      return { list: rows.slice(0, 30), hasMore: rows.length > 30, page: pageNumber }
    }
    throw new Error('未知权限管理操作')
  }
  async function protectAdminOwner(target, roles, status) {
    const config = await policy()
    if (config?.enabled && config.ownerOpenid === target.openid && (!roles.includes('admin') || status !== 'active')) throw new Error('不能停用或删除超级管理员')
  }
  return { authorizeAdmin, runAdminRequest, handleAdminAccess, protectAdminOwner }
}
