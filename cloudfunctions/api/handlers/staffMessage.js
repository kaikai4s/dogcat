module.exports = function createHandler(context) {
  const {
    db,
    getUser,
    getUserSystemNotificationUnreadCount,
    listUserSystemNotifications,
    markSystemNotificationRead,
    now,
    orderStatusText,
    safeText,
    queryMessageThreads,
    queryThreadMessages,
    queryOrderMessageUnread
  } = context
  return async function staffMessage(openid, action, data) {
    const user = await getUser(openid)
    if (!(user.roles || []).includes('staff')) throw new Error('仅宠托师可查看消息')
    if (action === 'listThreads') {
      return queryMessageThreads(openid, 'staff', data)
    }
    if (action === 'getUnreadSummary') {
      const orderUnread = await queryOrderMessageUnread(openid, 'staff')
      let systemUnread = 0
      if (typeof getUserSystemNotificationUnreadCount === 'function') {
        systemUnread = await getUserSystemNotificationUnreadCount(openid, 'staff', user)
      }
      const totalUnread = orderUnread + systemUnread
      return { totalUnread, orderUnread, systemUnread, hasUnread: totalUnread > 0 }
    }
    if (action === 'getThreadMessages') {
      const threadId = safeText(data.threadId).trim()
      const orderId = safeText(data.orderId).trim()
      if (!threadId && !orderId) throw new Error('消息会话不存在')
      let thread = null
      if (threadId) {
        const doc = await db.collection('order_staff_message_threads').doc(threadId).get().catch(() => ({ data: null }))
        thread = doc && doc.data
      } else if (orderId) {
        const res = await db.collection('order_staff_message_threads').where({ orderId, staffOpenid: openid }).limit(1).get()
        thread = res.data[0]
      }
      if (!thread || thread.staffOpenid !== openid) throw new Error('消息会话不存在')
      const result = await queryThreadMessages(thread._id, 'staff', data)
      return {
        thread: { ...thread, orderStatusText: orderStatusText(thread.orderStatus) },
        ...result
      }
    }
    if (action === 'deleteThread') {
      const threadId = safeText(data.threadId).trim()
      const orderId = safeText(data.orderId).trim()
      if (!threadId && !orderId) throw new Error('参数缺失')
      let query = { staffOpenid: openid }
      if (threadId) query._id = threadId
      else if (orderId) query.orderId = orderId
      const res = await db.collection('order_staff_message_threads').where(query).limit(1).get().catch(() => ({ data: [] }))
      const resDoc = res && res.data && res.data[0]
      if (resDoc) {
        const time = now()
        await db.collection('order_staff_message_threads').doc(resDoc._id).update({
          data: { hiddenForStaff: true, hiddenAt: time, unreadCount: 0, updatedAt: time }
        })
      }
      return { success: true }
    }
    if (action === 'markThreadRead') {
      const threadId = safeText(data.threadId).trim()
      if (!threadId) throw new Error('消息会话不存在')
      const threadRes = await db.collection('order_staff_message_threads').doc(threadId).get().catch(() => ({ data: null }))
      const thread = threadRes && threadRes.data
      if (!thread || thread.staffOpenid !== openid) throw new Error('消息会话不存在')
      const time = now()
      await db.collection('order_staff_message_threads').doc(threadId).update({ data: { unreadCount: 0, readAt: time } })
      return { threadId, unreadCount: 0 }
    }
    if (action === 'markOrderThreadRead') {
      const orderId = safeText(data.orderId).trim()
      if (!orderId) throw new Error('订单消息不存在')
      const res = await db.collection('order_staff_message_threads').where({ orderId, staffOpenid: openid }).limit(1).get()
      const thread = res.data[0]
      if (!thread) return { orderId, unreadCount: 0 }
      const time = now()
      await db.collection('order_staff_message_threads').doc(thread._id).update({ data: { unreadCount: 0, readAt: time } })
      return { threadId: thread._id, orderId, unreadCount: 0 }
    }
    if (action === 'listSystemNotifications') {
      return listUserSystemNotifications(openid, 'staff', data)
    }
    if (action === 'markSystemNotificationRead') {
      return markSystemNotificationRead(openid, 'staff', data)
    }
    throw new Error('未知 staffMessage 操作')
  }
}
