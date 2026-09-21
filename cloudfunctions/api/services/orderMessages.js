module.exports = function createService({
  db,
  makeIdempotencyKey,
  now,
  safeText
}) {
  function isMallOrder(order = {}) {
    return order.orderType === 'mall' || (Array.isArray(order.items) && order.items.some((item) => item && item.productId)) || !!order.shippingAddress
  }

  function buildMallOrderTitle(order = {}) {
    const firstItem = Array.isArray(order.items) ? order.items[0] : null
    const itemName = firstItem && safeText(firstItem.name).trim()
    const count = Array.isArray(order.items) ? order.items.length : 0
    if (itemName && count > 1) return `${itemName}等${count}件商品`
    return itemName || '商城订单'
  }

  function buildOrderMessageTitle(order = {}) {
    if (isMallOrder(order)) return buildMallOrderTitle(order)
    return order.serviceSummary || (order.petName ? `${order.petName}的订单` : '订单消息')
  }

  async function getOrCreateOrderMessageThread(order = {}) {
    const orderId = order._id || order.orderId || ''
    const clientOpenid = safeText(order.clientOpenid).trim()
    if (!orderId || !clientOpenid) return null
    const existing = await db.collection('order_message_threads').where({ orderId, clientOpenid }).limit(1).get()
    if (existing.data[0]) return existing.data[0]
    const time = now()
    const thread = {
      orderId,
      orderNo: order.orderNo || '',
      clientOpenid,
      clientUserId: order.clientUserId || '',
      threadType: 'order',
      orderTitle: buildOrderMessageTitle(order),
      petName: order.petName || '',
      serviceSummary: order.serviceSummary || '',
      orderStatus: order.status || '',
      lastMessageTitle: '',
      lastMessageDetail: '',
      lastMessageAt: time,
      lastMessageType: '',
      unreadCount: 0,
      readAt: null,
      createdAt: time,
      updatedAt: time
    }
    const created = await db.collection('order_message_threads').add({ data: thread })
    return { _id: created._id, ...thread }
  }

  async function appendOrderClientMessage(order = {}, event = {}) {
    const orderId = order._id || event.orderId || ''
    const clientOpenid = safeText(order.clientOpenid).trim()
    if (!orderId || !clientOpenid) return null
    const eventType = safeText(event.eventType).trim()
    const title = safeText(event.title).trim()
    if (!eventType || !title) return null
    const detail = safeText(event.detail).trim()
    const idempotencyKey = safeText(event.idempotencyKey).trim() || makeIdempotencyKey('order_message', orderId, eventType, title, detail)
    const existingMessage = await db.collection('order_messages').where({ idempotencyKey }).limit(1).get()
    if (existingMessage.data[0]) return existingMessage.data[0]
    const thread = await getOrCreateOrderMessageThread({ ...order, _id: orderId })
    if (!thread || !thread._id) return null
    const time = event.createdAt || now()
    const actorRole = event.actorRole || ''
    const forceUnreadTypes = new Set(['paid', 'expired', 'refund_processing', 'refund_result', 'assigned', 'started', 'completed', 'early_start_requested', 'remote_unlock_requested'])
    const unreadForClient = event.unreadForClient !== undefined ? event.unreadForClient === true : (actorRole !== 'client' || forceUnreadTypes.has(eventType))
    const message = {
      threadId: thread._id,
      orderId,
      orderNo: order.orderNo || thread.orderNo || '',
      clientOpenid,
      clientUserId: order.clientUserId || thread.clientUserId || '',
      messageType: 'order_status',
      eventType,
      title,
      detail,
      actorRole,
      unreadForClient,
      idempotencyKey,
      createdAt: time
    }
    const created = await db.collection('order_messages').add({ data: message })
    const unreadCount = unreadForClient ? Number(thread.unreadCount || 0) + 1 : Number(thread.unreadCount || 0)
    await db.collection('order_message_threads').doc(thread._id).update({
      data: {
        orderNo: message.orderNo,
        orderTitle: buildOrderMessageTitle(order),
        petName: order.petName || thread.petName || '',
        serviceSummary: order.serviceSummary || thread.serviceSummary || '',
        orderStatus: order.status || thread.orderStatus || '',
        lastMessageId: created._id,
        lastMessageType: eventType,
        lastMessageTitle: title,
        lastMessageDetail: detail,
        lastMessageAt: time,
        lastActorRole: actorRole,
        unreadCount,
        hiddenForClient: false,
        updatedAt: time
      }
    })
    return { _id: created._id, ...message }
  }

  async function getOrCreateOrderStaffMessageThread(order = {}) {
    const orderId = order._id || order.orderId || ''
    const staffOpenid = safeText(order.staffOpenid).trim()
    if (!orderId || !staffOpenid) return null
    const existing = await db.collection('order_staff_message_threads').where({ orderId, staffOpenid }).limit(1).get()
    if (existing.data[0]) return existing.data[0]
    const time = now()
    const thread = {
      orderId,
      orderNo: order.orderNo || '',
      staffOpenid,
      staffUserId: order.staffUserId || '',
      recipientRole: 'staff',
      recipientOpenid: staffOpenid,
      threadType: 'order',
      orderTitle: buildOrderMessageTitle(order),
      petName: order.petName || '',
      serviceSummary: order.serviceSummary || '',
      orderStatus: order.status || '',
      lastMessageTitle: '',
      lastMessageDetail: '',
      lastMessageAt: time,
      lastMessageType: '',
      unreadCount: 0,
      readAt: null,
      createdAt: time,
      updatedAt: time
    }
    const created = await db.collection('order_staff_message_threads').add({ data: thread })
    return { _id: created._id, ...thread }
  }

  async function appendOrderStaffMessage(order = {}, event = {}) {
    const orderId = order._id || event.orderId || ''
    const staffOpenid = safeText(order.staffOpenid).trim()
    if (!orderId || !staffOpenid) return null
    const eventType = safeText(event.eventType).trim()
    const title = safeText(event.title).trim()
    if (!eventType || !title) return null
    const detail = safeText(event.detail).trim()
    const idempotencyKey = safeText(event.idempotencyKey).trim() || makeIdempotencyKey('order_staff_message', orderId, eventType, title, detail)
    const existingMessage = await db.collection('order_staff_messages').where({ idempotencyKey }).limit(1).get()
    if (existingMessage.data[0]) return existingMessage.data[0]
    const thread = await getOrCreateOrderStaffMessageThread({ ...order, _id: orderId })
    if (!thread || !thread._id) return null
    const time = event.createdAt || now()
    const actorRole = event.actorRole || ''
    const unreadForStaff = event.unreadForStaff !== undefined ? event.unreadForStaff === true : true
    const message = {
      threadId: thread._id,
      orderId,
      orderNo: order.orderNo || thread.orderNo || '',
      staffOpenid,
      staffUserId: order.staffUserId || thread.staffUserId || '',
      recipientRole: 'staff',
      recipientOpenid: staffOpenid,
      messageType: 'order_status',
      eventType,
      title,
      detail,
      actorRole,
      unreadForStaff,
      idempotencyKey,
      createdAt: time
    }
    const created = await db.collection('order_staff_messages').add({ data: message })
    const unreadCount = unreadForStaff ? Number(thread.unreadCount || 0) + 1 : Number(thread.unreadCount || 0)
    await db.collection('order_staff_message_threads').doc(thread._id).update({
      data: {
        orderNo: message.orderNo,
        orderTitle: buildOrderMessageTitle(order),
        petName: order.petName || thread.petName || '',
        serviceSummary: order.serviceSummary || thread.serviceSummary || '',
        orderStatus: order.status || thread.orderStatus || '',
        lastMessageId: created._id,
        lastMessageType: eventType,
        lastMessageTitle: title,
        lastMessageDetail: detail,
        lastMessageAt: time,
        lastActorRole: actorRole,
        unreadCount,
        hiddenForStaff: false,
        updatedAt: time
      }
    })
    return { _id: created._id, ...message }
  }

  return {
    isMallOrder,
    buildMallOrderTitle,
    buildOrderMessageTitle,
    getOrCreateOrderMessageThread,
    appendOrderClientMessage,
    getOrCreateOrderStaffMessageThread,
    appendOrderStaffMessage
  }
}
