module.exports = function createHelpers({ now, toTimeValue, ORDER_STATUS, safeText, createRefundForOrder, makeIdempotencyKey, db, appendOrderTimeline, appendOrderClientMessage }) {
function shouldExpireUnacceptedOrder(order = {}, time = now()) {
  const start = toTimeValue(order.startTime)
  return order.status === ORDER_STATUS.PAID && !safeText(order.staffOpenid).trim() && start > 0 && start <= time.getTime()
}

async function expireUnacceptedOrder(orderId, order, time = now()) {
  if (!shouldExpireUnacceptedOrder(order, time)) return order
  const isPaid = order.paymentStatus === 'paid' && Number(order.payAmount || 0) > 0
  const update = {
    status: ORDER_STATUS.EXPIRED,
    expiredAt: time,
    expireReason: '服务开始时间前无人接单',
    updatedAt: time
  }

  let refund = null
  if (isPaid) {
    refund = await createRefundForOrder(order, order.payAmount, '服务开始时间前无人接单，系统自动全额退款', 'system_expire', order.clientOpenid, makeIdempotencyKey('expire_refund', orderId, time.getTime()), { unreadForClient: false, cancelStatus: 'expired' })
    update.paymentStatus = 'refunding'
    update.refundStatus = 'processing'
    update.refundNo = refund.refundNo
    update.refundAmount = Number(order.payAmount)
  }

  if (!refund) {
    const changed = await db.runTransaction(async tx => {
      const current = (await tx.collection('orders').doc(orderId).get()).data
      if (!current || !shouldExpireUnacceptedOrder(current, time) || current.paymentStatus === 'paid') return false
      await tx.collection('orders').doc(orderId).update({ data: update })
      return true
    })
    if (!changed) return order
  }
  const updatedOrder = refund ? (await db.collection('orders').doc(orderId).get()).data : { ...order, _id: orderId, ...update }
  await appendOrderTimeline(orderId, 'expired', '订单已过期', isPaid ? `服务开始时间前无人接单，已发起全额退款 ¥${order.payAmount}` : '服务开始时间前无人接单', 'system')
  await appendOrderClientMessage(updatedOrder, { eventType: 'expired', title: '订单已过期', detail: isPaid ? `服务开始时间前无人接单，已自动发起全额退款 ¥${order.payAmount}` : '服务开始时间前无人接单', actorRole: 'system' })
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
