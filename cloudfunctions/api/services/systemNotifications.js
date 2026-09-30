module.exports = function createService({
  checkTextSecurity,
  db,
  getUser,
  logAdmin,
  now,
  nowText,
  paginateList,
  readScopedDocuments,
  safeText
}) {
  function formatNotificationType(type) {
    return {
      system: '系统公告',
      notice: '服务通知',
      activity: '活动福利'
    }[type] || '系统通知'
  }

  /**
   * 管理员发送系统通知
   */
  async function sendSystemNotification(data = {}, adminUser = {}) {
    const title = safeText(data.title).trim()
    const content = safeText(data.content).trim()
    if (!title) throw new Error('请输入通知标题')
    if (title.length > 50) throw new Error('通知标题不能超过 50 字')
    if (!content) throw new Error('请输入通知内容')
    if (content.length > 1000) throw new Error('通知内容不能超过 1000 字')

    const target = ['all', 'client', 'staff'].includes(data.target) ? data.target : 'all'
    const type = ['system', 'notice', 'activity'].includes(data.type) ? data.type : 'system'
    const level = ['urgent', 'normal'].includes(data.level) ? data.level : 'normal'
    const targetUrl = safeText(data.targetUrl).trim()
    if (targetUrl && targetUrl.length > 200) throw new Error('跳转链接不能超过 200 字')

    const textToCheck = [title, content].filter(Boolean).join(' ')
    if (textToCheck && typeof checkTextSecurity === 'function') {
      const openid = adminUser.openid || (adminUser && adminUser.data && adminUser.data.openid) || ''
      await checkTextSecurity(openid, textToCheck, { scene: 2, label: '系统通知内容' })
    }
    const rawTime = typeof now === 'function' ? now() : (typeof nowText === 'function' ? nowText() : new Date())
    const time = rawTime instanceof Date ? rawTime.toISOString() : String(rawTime)

    const doc = {
      title,
      content,
      target,
      type,
      targetUrl,
      level,
      status: 'active',
      senderAdminId: adminUser._id || '',
      senderAdminOpenid: adminUser.openid || '',
      senderAdminName: adminUser.name || adminUser.nickName || '系统管理员',
      createdAt: time,
      updatedAt: time
    }

    const res = await db.collection('system_notifications').add({ data: doc })
    const notificationId = res._id || (res.data && res.data._id)
    if (typeof logAdmin === 'function') {
      await logAdmin(adminUser, 'system_notification', notificationId, 'send', { title, target, type, level }).catch(() => {})
    }

    return { _id: notificationId, ...doc }
  }

  /**
   * 管理后台查询历史发送的系统通知
   */
  async function listAdminSystemNotifications(data = {}) {
    const all = await readScopedDocuments('system_notifications', {}, 'createdAt', 'desc')
    const list = all.map((item) => ({
      ...item,
      typeText: formatNotificationType(item.type),
      targetText: item.target === 'all' ? '全员广播' : (item.target === 'client' ? '用户端' : '宠托师端'),
      levelText: item.level === 'urgent' ? '加急预警' : '普通通知',
      statusText: item.status === 'revoked' ? '已撤回' : '正常'
    }))
    return paginateList(list, data)
  }

  /**
   * 管理员撤回/下线系统通知
   */
  async function revokeSystemNotification(data = {}, adminUser = {}) {
    const notificationId = safeText(data.id || data.notificationId).trim()
    if (!notificationId) throw new Error('通知ID缺失')
    const time = nowText ? nowText() : (now() instanceof Date ? now().toISOString() : String(now()))

    await db.collection('system_notifications').doc(notificationId).update({
      data: { status: 'revoked', revokedAt: time, updatedAt: time }
    })

    if (typeof logAdmin === 'function') {
      await logAdmin(adminUser, 'system_notification', notificationId, 'revoke', {}).catch(() => {})
    }

    return { success: true, notificationId }
  }

  /**
   * 用户端或宠托师端获取系统通知列表
   */
  async function listUserSystemNotifications(openid, role = 'client', data = {}) {
    const user = await getUser(openid).catch(() => ({ roles: [] }))
    const activeNotices = await readScopedDocuments('system_notifications', { status: 'active' }, 'createdAt', 'desc')
    const visible = activeNotices.filter((n) => n.target === 'all' || n.target === role)

    const allReadAt = (role === 'staff' ? user.staffSystemNoticeAllReadAt : user.clientSystemNoticeAllReadAt) || user.systemNoticeAllReadAt || ''
    const userReads = await readScopedDocuments('user_notification_reads', { openid, role }).catch(() => [])
    const readIds = new Set(userReads.map((r) => r.notificationId))

    const decorated = visible.map((item) => {
      const isRead = Boolean(readIds.has(item._id) || (allReadAt && item.createdAt <= allReadAt))
      return {
        ...item,
        isRead,
        typeText: formatNotificationType(item.type),
        levelText: item.level === 'urgent' ? '重要' : '常规',
        createdAtText: item.createdAt ? String(item.createdAt).replace('T', ' ').slice(0, 16) : ''
      }
    })

    const unreadCount = decorated.filter((item) => !item.isRead).length
    const pageData = paginateList(decorated, data)
    return {
      ...pageData,
      unreadCount
    }
  }

  /**
   * 用户端或宠托师端标记系统通知已读
   */
  async function markSystemNotificationRead(openid, role = 'client', data = {}) {
    const time = nowText ? nowText() : (now() instanceof Date ? now().toISOString() : String(now()))
    if (data.all === true) {
      const field = role === 'staff' ? 'staffSystemNoticeAllReadAt' : 'clientSystemNoticeAllReadAt'
      await db.collection('users').where({ openid }).update({
        data: { [field]: time, updatedAt: time }
      }).catch(() => {})
      return { success: true, all: true, unreadCount: 0 }
    }

    const notificationId = safeText(data.id || data.notificationId).trim()
    if (!notificationId) throw new Error('通知ID缺失')

    const existing = await db.collection('user_notification_reads')
      .where({ openid, role, notificationId })
      .limit(1)
      .get()
      .catch(() => ({ data: [] }))

    if (!existing.data || !existing.data.length) {
      await db.collection('user_notification_reads').add({
        data: { openid, role, notificationId, readAt: time }
      }).catch(() => {})
    }

    return { success: true, notificationId }
  }

  /**
   * 获取指定用户在指定角色的未读系统通知数量
   */
  async function getUserSystemNotificationUnreadCount(openid, role = 'client', userDoc = null) {
    try {
      const activeNotices = await readScopedDocuments('system_notifications', { status: 'active' })
      const visible = activeNotices.filter((n) => n.target === 'all' || n.target === role)
      if (!visible.length) return 0

      const user = userDoc || (await getUser(openid).catch(() => ({ roles: [] })))
      const allReadAt = (role === 'staff' ? user.staffSystemNoticeAllReadAt : user.clientSystemNoticeAllReadAt) || user.systemNoticeAllReadAt || ''
      const userReads = await readScopedDocuments('user_notification_reads', { openid, role }).catch(() => [])
      const readIds = new Set(userReads.map((r) => r.notificationId))

      return visible.filter((item) => !readIds.has(item._id) && (!allReadAt || item.createdAt > allReadAt)).length
    } catch (_) {
      return 0
    }
  }

  return {
    sendSystemNotification,
    listAdminSystemNotifications,
    revokeSystemNotification,
    listUserSystemNotifications,
    markSystemNotificationRead,
    getUserSystemNotificationUnreadCount
  }
}
