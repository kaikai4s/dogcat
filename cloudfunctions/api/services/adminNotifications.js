module.exports = function createService({
  db,
  makeIdempotencyKey,
  now,
  paginateList,
  safeText
}) {
  /**
   * 向管理员端发送系统通知并持久化存储到 admin_notifications 集合
   */
  async function notifyAdmins(payload = {}) {
    const type = safeText(payload.type).trim() || 'system_notice'
    const title = safeText(payload.title).trim()
    const content = safeText(payload.content).trim()
    if (!title || !content) return null

    const level = ['urgent', 'warning', 'info'].includes(payload.level) ? payload.level : 'info'
    const orderId = safeText(payload.orderId).trim()
    const orderNo = safeText(payload.orderNo).trim()
    const actionUrl = safeText(payload.actionUrl).trim()
    const extra = payload.extra && typeof payload.extra === 'object' ? payload.extra : {}
    const time = now()

    // 幂等防重：如特定订单的超时预警只生成一次
    const idempotencyKey = safeText(payload.idempotencyKey).trim() ||
      makeIdempotencyKey('admin_notification', type, orderId || 'global', title)

    const existing = await db.collection('admin_notifications').where({ idempotencyKey }).limit(1).get()
    if (existing.data && existing.data[0]) {
      return existing.data[0]
    }

    const notification = {
      type,
      title,
      content,
      level,
      orderId,
      orderNo,
      actionUrl,
      extra,
      read: false,
      readBy: [],
      idempotencyKey,
      createdAt: time,
      updatedAt: time
    }

    const created = await db.collection('admin_notifications').add({ data: notification })
    return { _id: created._id, ...notification }
  }

  async function readAllNotifications(where = {}, maxLimit = 2000) {
    const rows = []
    let cursor = ''
    while (rows.length < maxLimit) {
      const condition = { ...where }
      if (cursor && db.command && typeof db.command.gt === 'function') {
        condition._id = db.command.gt(cursor)
      }
      const page = (await db.collection('admin_notifications').where(condition).orderBy('_id', 'asc').limit(100).get()).data || []
      rows.push(...page)
      if (page.length < 100) break
      cursor = page[page.length - 1]._id
    }
    return rows
  }

  function sosIncidentId(notification) {
    const id = safeText(notification.extra && notification.extra.incidentId).trim()
    if (id) return id
    // Older notifications may retain only the incident detail link.
    const [path, query = ''] = safeText(notification.actionUrl).split('?')
    if (path !== '/pages/admin/incidents/detail/index') return ''
    const match = query.match(/(?:^|&)id=([^&#]+)/)
    try { return match ? decodeURIComponent(match[1]) : '' } catch (_) { return '' }
  }

  // 阅读与处理状态独立；保留历史，待办以对应订单或事件的当前状态为准。
  async function attachResolutionState(notifications) {
    const dispatchTypes = ['order_start_overdue', 'order_finish_overdue', 'order_urgent_republished']
    const orderIds = [...new Set(notifications.filter(item => dispatchTypes.includes(item.type) && !item.resolved).map(item => item.orderId).filter(Boolean))]
    const orders = new Map()
    for (let i = 0; i < orderIds.length; i += 100) {
      const result = await db.collection('orders').where({ _id: db.command.in(orderIds.slice(i, i + 100)) }).limit(100).get()
      for (const order of result.data || []) orders.set(order._id, order)
    }
    const incidentIds = [...new Set(notifications.filter(item => item.type === 'sos_alert' && !item.resolved).map(sosIncidentId).filter(Boolean))]
    const incidents = new Map()
    for (let i = 0; i < incidentIds.length; i += 100) {
      const result = await db.collection('order_incidents').where({ _id: db.command.in(incidentIds.slice(i, i + 100)) }).limit(100).get()
      for (const incident of result.data || []) incidents.set(incident._id, incident)
    }
    return notifications.map(item => {
      let isResolved = item.resolved === true
      if (!isResolved && dispatchTypes.includes(item.type)) {
        const order = orders.get(item.orderId)
        const activeStatuses = item.type === 'order_start_overdue'
          ? ['assigned', 'on_the_way', 'day_completed']
          : item.type === 'order_finish_overdue'
            ? ['in_service']
            : ['paid']
        isResolved = !order || !activeStatuses.includes(order.status) ||
          (item.type === 'order_start_overdue' && order.isStartOverdue === false) ||
          (item.type === 'order_finish_overdue' && order.isFinishOverdue === false)
      }
      if (!isResolved && item.type === 'sos_alert') {
        const incident = incidents.get(sosIncidentId(item))
        // An order can have several incidents. Only this incident's confirmed
        // terminal state resolves its SOS; missing records must not hide alerts.
        isResolved = !!incident && ['resolved', 'rejected', 'closed'].includes(incident.status)
      }
      return { ...item, isResolved }
    })
  }

  async function resolveOrderDispatchNotifications(orderId, { reason = 'order_completed', actor = '', time = now() } = {}) {
    if (!orderId) return
    return db.collection('admin_notifications').where({
      orderId,
      type: db.command.in(['order_start_overdue', 'order_finish_overdue', 'order_urgent_republished']),
      resolved: db.command.neq(true)
    }).update({ data: { resolved: true, resolvedAt: time, resolvedBy: actor, resolutionReason: reason, updatedAt: time } })
  }

  /**
   * 管理员查询系统通知列表
   */
  async function listAdminNotifications(data = {}, currentAdminOpenid = '') {
    const type = safeText(data.type).trim()
    const level = safeText(data.level).trim()
    const status = safeText(data.status).trim() // unread | read

    const where = {}
    if (type && type !== 'all') where.type = type
    if (level && level !== 'all') where.level = level

    const allNotifications = (await attachResolutionState(await readAllNotifications(where, 2000)))
      .sort((a, b) => {
        const bTime = a && b ? new Date(b.createdAt || 0).getTime() : 0
        const aTime = a ? new Date(a.createdAt || 0).getTime() : 0
        return bTime - aTime
      })

    let list = allNotifications
    if (status === 'unread') {
      list = list.filter((item) => !item.isResolved && !item.read && !(Array.isArray(item.readBy) && item.readBy.includes(currentAdminOpenid)))
    } else if (status === 'read') {
      list = list.filter((item) => item.read || (Array.isArray(item.readBy) && item.readBy.includes(currentAdminOpenid)))
    }

    const unreadCount = allNotifications.filter((item) => !item.isResolved && !item.read && !(Array.isArray(item.readBy) && item.readBy.includes(currentAdminOpenid))).length

    const enriched = list.map((item) => {
      const isRead = item.read === true || (Array.isArray(item.readBy) && item.readBy.includes(currentAdminOpenid))
      return {
        ...item,
        isRead
      }
    })

    const wantsPage = data.page !== undefined || data.pageSize !== undefined
    const paged = wantsPage ? paginateList(enriched, data) : { list: enriched, total: enriched.length, page: 1, hasMore: false }
    return {
      ...paged,
      unreadCount
    }
  }

  /**
   * 标记管理员通知为已读
   */
  async function markAdminNotificationRead(data = {}, currentAdminOpenid = '') {
    const time = now()
    if (data.all === true) {
      const unreads = await readAllNotifications({ read: false }, 2000)
      for (const item of unreads) {
        const readBy = Array.isArray(item.readBy) ? Array.from(new Set([...item.readBy, currentAdminOpenid])) : [currentAdminOpenid]
        await db.collection('admin_notifications').doc(item._id).update({
          data: {
            read: true,
            readBy,
            readAt: time,
            updatedAt: time
          }
        })
      }
      return { success: true, count: unreads.length }
    }

    const id = safeText(data.id || data.notificationId).trim()
    if (!id) throw new Error('通知 ID 不能为空')
    const itemRes = await db.collection('admin_notifications').doc(id).get().catch(() => ({ data: null }))
    const item = itemRes && itemRes.data
    if (!item) throw new Error('通知不存在')

    const readBy = Array.isArray(item.readBy) ? Array.from(new Set([...item.readBy, currentAdminOpenid])) : [currentAdminOpenid]
    await db.collection('admin_notifications').doc(id).update({
      data: {
        read: true,
        readBy,
        readAt: time,
        updatedAt: time
      }
    })
    return { id, read: true }
  }

  /**
   * 获取未读通知总数
   */
  async function getAdminNotificationBadge(currentAdminOpenid = '') {
    const unreads = await readAllNotifications({ read: false }, 1000)
    const list = (await attachResolutionState(unreads))
      .filter((item) => !item.isResolved && !(Array.isArray(item.readBy) && item.readBy.includes(currentAdminOpenid)))
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
    const urgentCount = list.filter((item) => item.level === 'urgent').length
    const latestUrgent = list.find((item) => item.level === 'urgent') || null
    return {
      unreadCount: list.length,
      urgentCount,
      latestUrgent
    }
  }

  return {
    notifyAdmins,
    resolveOrderDispatchNotifications,
    listAdminNotifications,
    markAdminNotificationRead,
    getAdminNotificationBadge
  }
}
