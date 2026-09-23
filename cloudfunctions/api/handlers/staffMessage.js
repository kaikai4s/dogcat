module.exports = function createHandler(context) {
  const {
    db,
    getUser,
    now,
    orderStatusText,
    paginateList,
    readScopedDocuments,
    safeText,
    sortMessageThreads
  } = context
  return async function staffMessage(openid, action, data) {
    const user = await getUser(openid)
    if (!(user.roles || []).includes('staff')) throw new Error('仅宠托师可查看消息')
    if (action === 'listThreads') {
      const visibleThreads = (await readScopedDocuments('order_staff_message_threads', { staffOpenid: openid }, 'updatedAt', 'desc'))
        .filter((thread) => thread.hiddenForStaff !== true)
      const list = sortMessageThreads(visibleThreads.map((thread) => ({
        ...thread,
        orderStatusText: orderStatusText(thread.orderStatus),
        hasUnread: Number(thread.unreadCount || 0) > 0
      })))
      return paginateList(list, data)
    }
    if (action === 'getUnreadSummary') {
      const threads = await readScopedDocuments('order_staff_message_threads', { staffOpenid: openid })
      const totalUnread = threads
        .filter((thread) => thread.hiddenForStaff !== true)
        .reduce((sum, thread) => sum + Math.max(Number(thread.unreadCount || 0), 0), 0)
      return { totalUnread, hasUnread: totalUnread > 0 }
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
      const messages = await readScopedDocuments('order_staff_messages', { threadId: thread._id }, 'createdAt', 'asc')
      return {
        thread: { ...thread, orderStatusText: orderStatusText(thread.orderStatus) },
        messages: messages.map((message) => ({ ...message }))
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
    throw new Error('未知 staffMessage 操作')
  }
}
