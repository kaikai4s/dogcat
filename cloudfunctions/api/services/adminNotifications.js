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

    const allNotifications = (await readAllNotifications(where, 2000))
      .sort((a, b) => {
        const bTime = a && b ? new Date(b.createdAt || 0).getTime() : 0
        const aTime = a ? new Date(a.createdAt || 0).getTime() : 0
        return bTime - aTime
      })

    let list = allNotifications
    if (status === 'unread') {
      list = list.filter((item) => !item.read && !(Array.isArray(item.readBy) && item.readBy.includes(currentAdminOpenid)))
    } else if (status === 'read') {
      list = list.filter((item) => item.read || (Array.isArray(item.readBy) && item.readBy.includes(currentAdminOpenid)))
    }

    const unreadCount = allNotifications.filter((item) => !item.read && !(Array.isArray(item.readBy) && item.readBy.includes(currentAdminOpenid))).length

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
    const list = unreads.filter((item) => !(Array.isArray(item.readBy) && item.readBy.includes(currentAdminOpenid)))
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
    listAdminNotifications,
    markAdminNotificationRead,
    getAdminNotificationBadge
  }
}
