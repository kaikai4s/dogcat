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
    refund = await createRefundForOrder(order, order.payAmount, '服务开始时间前无人接单，系统自动全额退款', 'system_expire', order.clientOpenid, makeIdempotencyKey('expire_refund', orderId, time.getTime()), { unreadForClient: false })
    update.paymentStatus = 'refunding'
    update.refundStatus = 'processing'
    update.refundNo = refund.refundNo
    update.refundAmount = Number(order.payAmount)
  }

  await db.collection('orders').doc(orderId).update({ data: update })
  const updatedOrder = { ...order, _id: orderId, ...update }
  await appendOrderTimeline(orderId, 'expired', '订单已过期', isPaid ? `服务开始时间前无人接单，已发起全额退款 ¥${order.payAmount}` : '服务开始时间前无人接单', 'system')
  await appendOrderClientMessage(updatedOrder, { eventType: 'expired', title: '订单已过期', detail: isPaid ? `服务开始时间前无人接单，已自动发起全额退款 ¥${order.payAmount}` : '服务开始时间前无人接单', actorRole: 'system' })
  return updatedOrder
}

async function expireDueUnacceptedOrders() {
  const res = await db.collection('orders').where({ status: ORDER_STATUS.PAID }).get()
  const time = now()
  await Promise.all((res.data || []).map((order) => expireUnacceptedOrder(order._id, order, time)))
}

return { shouldExpireUnacceptedOrder, expireUnacceptedOrder, expireDueUnacceptedOrders }
}
