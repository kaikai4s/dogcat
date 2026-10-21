module.exports = function createHelpers({ now, toTimeValue, ORDER_STATUS, safeText, createRefundForOrder, makeIdempotencyKey, db, appendOrderTimeline, appendOrderClientMessage, restoreOrderCoupon }) {
function shouldExpireUnacceptedOrder(order = {}, time = now()) {
  const start = toTimeValue(order.startTime)
  const isGroup = !!(order.groupBuyId || order.source === 'community_groupbuy')
  const threshold = isGroup ? (start - 2 * 3600 * 1000) : start
  return order.status === ORDER_STATUS.PAID && !safeText(order.staffOpenid).trim() && start > 0 && threshold <= time.getTime()
}

async function expireUnacceptedOrder(orderId, order, time = now()) {
  if (!shouldExpireUnacceptedOrder(order, time)) return order
  const isPaid = order.paymentStatus === 'paid' && Number(order.payAmount || 0) > 0
  const isGroup = !!(order.groupBuyId || order.source === 'community_groupbuy')
  const expireReason = isGroup ? '服务开始前2小时无人接单，拼单自动作废' : '服务开始时间前无人接单'
  const refundReason = isGroup ? '服务开始前2小时无人接单，拼单自动全额退款' : '服务开始时间前无人接单，系统自动全额退款'
  const update = {
    status: ORDER_STATUS.EXPIRED,
    expiredAt: time,
    expireReason,
    updatedAt: time
  }

  let refund = null
  if (isPaid) {
    refund = await createRefundForOrder(order, order.payAmount, refundReason, 'system_expire', order.clientOpenid, makeIdempotencyKey('expire_refund', orderId), { unreadForClient: false, cancelStatus: 'expired' })
    update.paymentStatus = 'refunding'
    update.refundStatus = 'processing'
    update.refundNo = refund.refundNo
    update.refundAmount = Number(order.payAmount)
  }

  if (!refund) {
    const changed = await db.runTransaction(async tx => {
      const current = (await tx.collection('orders').doc(orderId).get().catch(() => ({ data: null }))).data
      if (!current || !shouldExpireUnacceptedOrder(current, time) || current.paymentStatus === 'paid') return false
      await tx.collection('orders').doc(orderId).update({ data: update })
      if (current.couponId && typeof restoreOrderCoupon === 'function') {
        await restoreOrderCoupon(current.couponId, orderId, tx)
      }
      return true
    })
    if (!changed) return order
  }
  const updatedOrder = refund ? ((await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))).data || { ...order, _id: orderId, ...update }) : { ...order, _id: orderId, ...update }
  const noticeDetail = isPaid ? (isGroup ? `服务开始前2小时无人接单，拼单已自动取消并全额退款 ¥${order.payAmount}` : `服务开始时间前无人接单，已发起全额退款 ¥${order.payAmount}`) : expireReason
  await appendOrderTimeline(orderId, 'expired', isGroup ? '拼单已超时取消' : '订单已过期', noticeDetail, 'system')
  await appendOrderClientMessage(updatedOrder, { eventType: 'expired', title: isGroup ? '拼单超时未接单已取消' : '订单已过期', detail: noticeDetail, actorRole: 'system' })
  if (isGroup && order.groupBuyId) {
    await db.collection('pet_playground_groups').doc(order.groupBuyId).update({
      data: {
        status: 'cancelled',
        deadline: time,
        cancelReason: '服务开始前2小时无人接单，拼单已自动取消',
        updatedAt: time
      }
    }).catch(() => {})
  }
  return updatedOrder
}

async function expireDueUnacceptedOrders() {
  const time = now()
  let cursor = ''
  while (true) {
    const where = { status: ORDER_STATUS.PAID }
    if (cursor) where._id = db.command.gt(cursor)
    const rows = (await db.collection('orders').where(where).orderBy('_id', 'asc').limit(100).get()).data || []
    for (const order of rows) {
      try { await expireUnacceptedOrder(order._id, order, time) }
      catch (error) { console.error('[expire-order]', { orderId: order._id, message: error.message }) }
    }
    if (rows.length < 100) break
    cursor = rows[rows.length - 1]._id
  }
}

return { shouldExpireUnacceptedOrder, expireUnacceptedOrder, expireDueUnacceptedOrders }
}
