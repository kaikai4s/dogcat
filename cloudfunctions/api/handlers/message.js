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
  return async function message(openid, action, data) {
    await getUser(openid)
    if (action === 'listThreads') {
      return queryMessageThreads(openid, 'client', data)
    }
    if (action === 'getUnreadSummary') {
      const orderUnread = await queryOrderMessageUnread(openid, 'client')
      const user = await getUser(openid).catch(() => ({ roles: [] }))
      let systemUnread = 0
      if (typeof getUserSystemNotificationUnreadCount === 'function') {
        systemUnread = await getUserSystemNotificationUnreadCount(openid, 'client', user)
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
        const doc = await db.collection('order_message_threads').doc(threadId).get().catch(() => ({ data: null }))
        thread = doc && doc.data
      } else if (orderId) {
        const res = await db.collection('order_message_threads').where({ orderId, clientOpenid: openid }).limit(1).get()
        thread = res.data[0]
      }
      if (!thread || thread.clientOpenid !== openid) throw new Error('消息会话不存在')
      const result = await queryThreadMessages(thread._id, 'client', data)
      return {
        thread: { ...thread, orderStatusText: orderStatusText(thread.orderStatus) },
        ...result
      }
    }
    if (action === 'deleteThread') {
      const threadId = safeText(data.threadId).trim()
      const orderId = safeText(data.orderId).trim()
      if (!threadId && !orderId) throw new Error('参数缺失')
      let query = { clientOpenid: openid }
      if (threadId) query._id = threadId
      else if (orderId) query.orderId = orderId
      const res = await db.collection('order_message_threads').where(query).limit(1).get().catch(() => ({ data: [] }))
      const resDoc = res && res.data && res.data[0]
      if (resDoc) {
        const time = now()
        await db.collection('order_message_threads').doc(resDoc._id).update({
          data: { hiddenForClient: true, hiddenAt: time, unreadCount: 0, updatedAt: time }
        })
      }
      return { success: true }
    }
    if (action === 'markThreadRead') {
      const threadId = safeText(data.threadId).trim()
      if (!threadId) throw new Error('消息会话不存在')
      const threadRes = await db.collection('order_message_threads').doc(threadId).get().catch(() => ({ data: null }))
      const thread = threadRes && threadRes.data
      if (!thread || thread.clientOpenid !== openid) throw new Error('消息会话不存在')
      const time = now()
      await db.collection('order_message_threads').doc(threadId).update({ data: { unreadCount: 0, readAt: time } })
      return { threadId, unreadCount: 0 }
    }
    if (action === 'markOrderThreadRead') {
      const orderId = safeText(data.orderId).trim()
      if (!orderId) throw new Error('订单消息不存在')
      const res = await db.collection('order_message_threads').where({ orderId, clientOpenid: openid }).limit(1).get()
      const thread = res.data[0]
      if (!thread) return { orderId, unreadCount: 0 }
      const time = now()
      await db.collection('order_message_threads').doc(thread._id).update({ data: { unreadCount: 0, readAt: time } })
      return { threadId: thread._id, orderId, unreadCount: 0 }
    }
    if (action === 'listSystemNotifications') {
      return listUserSystemNotifications(openid, 'client', data)
    }
    if (action === 'markSystemNotificationRead') {
      return markSystemNotificationRead(openid, 'client', data)
    }
    throw new Error('未知 message 操作')
  }
}
