const { readOptionalDocument } = require('../utils/documentPages')

module.exports = function createService({
  crypto,
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
    const level = ['urgent', 'normal', 'warning', 'info'].includes(data.level) ? data.level : 'normal'
    const targetUrl = safeText(data.targetUrl || data.actionUrl).trim()
    if (targetUrl && targetUrl.length > 200) throw new Error('跳转链接不能超过 200 字')
    const targetOpenid = safeText(data.targetOpenid).trim()
    const targetOpenids = Array.isArray(data.targetOpenids)
      ? Array.from(new Set(data.targetOpenids.map((item) => safeText(item).trim()).filter(Boolean))).slice(0, 200)
      : []

    const textToCheck = [title, content].filter(Boolean).join(' ')
    if (textToCheck && typeof checkTextSecurity === 'function') {
      const openid = adminUser.openid || (adminUser && adminUser.data && adminUser.data.openid) || ''
      await checkTextSecurity(openid, textToCheck, { scene: 2, label: '系统通知内容' })
    }
    const rawTime = typeof now === 'function' ? now() : (typeof nowText === 'function' ? nowText() : new Date())
    const time = rawTime instanceof Date ? rawTime.toISOString() : String(rawTime)
    const extra = data.extra && typeof data.extra === 'object' ? data.extra : {}
    const idempotencyKey = safeText(data.idempotencyKey).trim()
    if (idempotencyKey) {
      const existing = await db.collection('system_notifications').where({ idempotencyKey }).limit(1).get().catch(() => ({ data: [] }))
      if (existing.data && existing.data[0]) return existing.data[0]
    }

    const doc = {
      title,
      content,
      target,
      targetOpenid,
      targetOpenids,
      type,
      targetUrl,
      level,
      status: 'active',
      extra,
      idempotencyKey,
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

  async function notifyCommunityApplicationResult(tx, application, result, adminUser = {}) {
    if (!application.firstApplicantOpenid) return
    const rejected = result.status === 'rejected'
    const idempotencyKey = `community_application_result:${application._id}:${result.status}`
    const id = 'community_result_' + crypto.createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)
    if (await readOptionalDocument(tx, 'system_notifications', id)) return
    const rawTime = now()
    const time = rawTime instanceof Date ? rawTime.toISOString() : String(rawTime)
    const content = rejected
      ? `你申请的“${application.name}”未通过审核。原因：${result.reason}。该小区申请已结束，不能再次申请。`
      : `你申请的“${application.name}”已通过审核，现已启用为“${result.communityName}”，可以在下单或庄园中搜索选择。${result.founder ? '你已获得“小区初创者”头衔，可前往庄园头衔面板查看并手动佩戴。' : ''}`
    await tx.collection('system_notifications').doc(id).set({ data: {
      title: rejected ? '小区申请审核未通过' : '小区申请审核通过', content,
      target: 'client', targetOpenid: application.firstApplicantOpenid, targetOpenids: [],
      type: 'notice', targetUrl: '', level: 'normal', status: 'active', idempotencyKey,
      extra: { applicationId: application._id, status: result.status, communityId: result.communityId || '', founder: result.founder === true },
      senderAdminId: adminUser._id || '', senderAdminOpenid: adminUser.openid || '',
      senderAdminName: adminUser.name || adminUser.nickName || '系统管理员', createdAt: time, updatedAt: time
    } })
  }

  function toBeijingString(value) {
    if (!value) return ''
    const date = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(date.getTime())) return String(value || '')
    const cst = new Date(date.getTime() + 8 * 60 * 60 * 1000)
    const year = cst.getUTCFullYear()
    const month = String(cst.getUTCMonth() + 1).padStart(2, '0')
    const day = String(cst.getUTCDate()).padStart(2, '0')
    const hour = String(cst.getUTCHours()).padStart(2, '0')
    const minute = String(cst.getUTCMinutes()).padStart(2, '0')
    return `${year}-${month}-${day} ${hour}:${minute}`
  }

  /**
   * 管理后台查询历史发送的系统通知
   */
  async function listAdminSystemNotifications(data = {}) {
    const all = await readScopedDocuments('system_notifications', {}, 'createdAt', 'desc')
    const list = all.map((item) => ({
      ...item,
      typeText: formatNotificationType(item.type),
      targetText: item.targetOpenid || (Array.isArray(item.targetOpenids) && item.targetOpenids.length) ? '指定用户' : (item.target === 'all' ? '全员广播' : (item.target === 'client' ? '用户端' : '宠托师端')),
      levelText: item.level === 'urgent' ? '加急预警' : (item.level === 'warning' ? '提醒通知' : '普通通知'),
      statusText: item.status === 'revoked' ? '已撤回' : '正常',
      createdAtText: toBeijingString(item.createdAt)
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

  function isNoticeVisibleToUser(n, openid, role) {
    const directed = safeText(n.targetOpenid).trim() === openid || (Array.isArray(n.targetOpenids) && n.targetOpenids.includes(openid))
    if (directed) return n.target === 'all' || n.target === role
    return !n.targetOpenid && (!Array.isArray(n.targetOpenids) || n.targetOpenids.length === 0) && (n.target === 'all' || n.target === role)
  }

  /**
   * 用户端或宠托师端获取系统通知列表
   */
  async function listUserSystemNotifications(openid, role = 'client', data = {}) {
    const user = await getUser(openid).catch(() => ({ roles: [] }))
    const activeNotices = await readScopedDocuments('system_notifications', { status: 'active' }, 'createdAt', 'desc')
    let visible = activeNotices.filter((n) => isNoticeVisibleToUser(n, openid, role))

    // 动态防御与自动修补：若通知指向问卷详情，校验问卷是否处于已发布状态。已关闭或已删除的问卷通知在前台自动屏蔽并下线
    const questionnaireNotices = visible.filter((n) => n.targetUrl && n.targetUrl.includes('questionnaires/detail'))
    if (questionnaireNotices.length > 0) {
      const questionnaires = await readScopedDocuments('questionnaires', {}).catch(() => [])
      const qMap = new Map(questionnaires.map((q) => [String(q._id), q]))
      const invalidNoticeIds = new Set()

      for (const n of questionnaireNotices) {
        const match = n.targetUrl.match(/[?&]id=([^&#]+)/)
        const qId = match ? match[1] : null
        const q = qId ? qMap.get(String(qId)) : null
        if (!q || q.status !== 'published') {
          invalidNoticeIds.add(n._id)
          const rawTime = typeof now === 'function' ? now() : (typeof nowText === 'function' ? nowText() : new Date())
          const timeStr = rawTime instanceof Date ? rawTime.toISOString() : String(rawTime)
          db.collection('system_notifications').doc(n._id).update({
            data: { status: 'revoked', revokedAt: timeStr, updatedAt: timeStr }
          }).catch(() => {})
        }
      }

      if (invalidNoticeIds.size > 0) {
        visible = visible.filter((n) => !invalidNoticeIds.has(n._id))
      }
    }

    const allReadAt = (role === 'staff' ? user.staffSystemNoticeAllReadAt : user.clientSystemNoticeAllReadAt) || user.systemNoticeAllReadAt || ''
    const userReads = await readScopedDocuments('user_notification_reads', { openid, role }).catch(() => [])
    const readIds = new Set(userReads.map((r) => r.notificationId))

    const decorated = visible.map((item) => {
      const isRead = Boolean(readIds.has(item._id) || (allReadAt && item.createdAt <= allReadAt))
      return {
        ...item,
        isRead,
        typeText: formatNotificationType(item.type),
        levelText: item.level === 'urgent' ? '重要' : (item.level === 'warning' ? '提醒' : '常规'),
        createdAtText: toBeijingString(item.createdAt)
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
      const visible = activeNotices.filter((n) => isNoticeVisibleToUser(n, openid, role))
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
    notifyCommunityApplicationResult,
    listAdminSystemNotifications,
    revokeSystemNotification,
    listUserSystemNotifications,
    markSystemNotificationRead,
    getUserSystemNotificationUnreadCount
  }
}
