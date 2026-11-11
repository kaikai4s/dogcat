module.exports = function createHelpers({ now, toTimeValue, ORDER_STATUS, safeText, createRefundForOrder, makeIdempotencyKey, db, appendOrderTimeline, appendOrderClientMessage, restoreOrderCoupon, notifyOrder }) {
function shouldExpireUnacceptedOrder(order = {}, time = now()) {
  const start = toTimeValue(order.startTime || (order.serviceSessions && order.serviceSessions[0] && order.serviceSessions[0].startTime))
  const isGroup = !!(order.groupBuyId || order.source === 'community_groupbuy')
  const threshold = isGroup ? (start - 2 * 3600 * 1000) : start
  return order.status === ORDER_STATUS.PAID && !safeText(order.staffOpenid).trim() && start > 0 && threshold <= time.getTime()
}

async function expireUnacceptedOrder(orderId, order, time = now(), forceGroupExpire = false) {
  // Forced sibling cleanup may bypass the deadline, never assignment or service.
  const eligible = value => value && value.status === ORDER_STATUS.PAID && !safeText(value.staffOpenid).trim() &&
    (forceGroupExpire || shouldExpireUnacceptedOrder(value, time))
  if (!forceGroupExpire && !shouldExpireUnacceptedOrder(order, time)) return order
  const current = (await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))).data || order
  if (!eligible(current) || (forceGroupExpire && current.groupBuyId !== order.groupBuyId)) return current
  if (current.status === ORDER_STATUS.EXPIRED || ['refunding', 'refunded'].includes(current.paymentStatus)) {
    return order
  }
  const isPaid = current.paymentStatus === 'paid' && Number(current.payAmount || 0) > 0
  const isGroup = !!(current.groupBuyId || current.source === 'community_groupbuy')
  const expireReason = isGroup ? '服务开始前2小时无人接单，拼单自动作废' : '服务开始时间前无人接单'
  const refundReason = isGroup ? '服务开始前2小时无人接单，拼单自动全额退款' : '服务开始时间前无人接单，系统自动全额退款'
  const update = {
    status: ORDER_STATUS.EXPIRED,
    expiredAt: time,
    expireReason,
    ...(isGroup ? { groupBuyStatus: 'cancelled' } : {}),
    updatedAt: time
  }

  let refund = null
  let refundAmount = 0
  if (isPaid) {
    const totalCents = Math.round(Number(current.payAmount) * 100)
    const reservedCents = Math.round(Number(current.refundAmount || 0) * 100)
    if (!Number.isSafeInteger(totalCents) || !Number.isSafeInteger(reservedCents) || reservedCents < 0 || reservedCents >= totalCents) throw new Error('订单剩余可退金额异常，请先对账')
    refundAmount = (totalCents - reservedCents) / 100
    refund = await createRefundForOrder(current, refundAmount, refundReason, 'system_expire', current.clientOpenid, makeIdempotencyKey('expire_refund', orderId), {
      unreadForClient: false, cancelStatus: 'expired',
      beforeReserve: async (tx, latest) => {
        if (!eligible(latest) || latest.paymentStatus !== 'paid' || latest.groupBuyId !== current.groupBuyId) {
          throw new Error('订单状态或预约时间已变化，不可过期退款，请刷新后重试')
        }
        return { expireReason, ...(isGroup ? { groupBuyStatus: 'cancelled' } : {}) }
      }
    })
    // The refund service owns financial status and may already have committed
    // SUCCESS/CLOSED. Only synchronize the group metadata after it returns.
    if (isGroup) await db.collection('orders').doc(orderId).update({ data: { groupBuyStatus: 'cancelled' } })
  }

  if (!refund) {
    const changed = await db.runTransaction(async tx => {
      const current = (await tx.collection('orders').doc(orderId).get().catch(() => ({ data: null }))).data
      if (!eligible(current) || ['paid', 'paying', 'refunding', 'refunded'].includes(current.paymentStatus) ||
          (forceGroupExpire && current.groupBuyId !== order.groupBuyId)) return false
      await tx.collection('orders').doc(orderId).update({ data: update })
      if (current.couponId && typeof restoreOrderCoupon === 'function') {
        await restoreOrderCoupon(current.couponId, orderId, tx)
      }
      return true
    })
    if (!changed) return order
  }
  const updatedOrder = refund ? ((await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))).data || { ...order, _id: orderId, ...update }) : { ...order, _id: orderId, ...update }
  const refundDescription = refundAmount < Number(current.payAmount) ? `剩余退款 ¥${refundAmount}` : `全额退款 ¥${refundAmount}`
  const noticeDetail = isPaid ? (isGroup ? `服务开始前2小时无人接单，拼单已自动取消，已发起${refundDescription}` : `服务开始时间前无人接单，已发起${refundDescription}`) : expireReason
  // Refunds have already committed. Notification failures must not prevent
  // cancelling the group and refunding its other unassigned households.
  try {
    await appendOrderTimeline(orderId, 'expired', isGroup ? '拼单已超时取消' : '订单已过期', noticeDetail, 'system')
  } catch (error) {
    console.error('[expire-order-timeline]', { orderId, message: error.message })
  }
  try {
    await appendOrderClientMessage(updatedOrder, { eventType: 'expired', title: isGroup ? '拼单超时未接单已取消' : '订单已过期', detail: noticeDetail, actorRole: 'system' })
  } catch (error) {
    console.error('[expire-order-message]', { orderId, message: error.message })
  }
  if (typeof notifyOrder === 'function' && updatedOrder.clientOpenid) {
    await notifyOrder(updatedOrder.clientOpenid, 'orderCancelled', updatedOrder, {
      statusText: '已过期',
      cancelReason: noticeDetail,
      refundAmount,
      cancelledAt: time
    }, 'client', `order_cancelled:expired:${orderId}`).catch(error => console.error('[expire-order-notification]', { orderId, message: error.message }))
  }
  if (isGroup && order.groupBuyId) {
    let shouldProcessSiblings = !forceGroupExpire
    try {
      const groupRes = await db.collection('pet_playground_groups').where({
        _id: order.groupBuyId,
        status: db.command.neq('cancelled')
      }).update({
        data: {
          status: 'cancelled',
          deadline: time,
          cancelReason: '服务开始前2小时无人接单，拼单已自动取消',
          updatedAt: time
        }
      })
      if (groupRes && groupRes.stats && groupRes.stats.updated === 0 && !forceGroupExpire) {
        // 其他并发实例已处理过该拼单组取消
        shouldProcessSiblings = false
      }
    } catch (_) {
      await db.collection('pet_playground_groups').doc(order.groupBuyId).update({
        data: {
          status: 'cancelled',
          deadline: time,
          cancelReason: '服务开始前2小时无人接单，拼单已自动取消',
          updatedAt: time
        }
      }).catch(() => {})
    }

    if (shouldProcessSiblings) {
      const siblingRes = await db.collection('orders').where({
        groupBuyId: order.groupBuyId,
        status: ORDER_STATUS.PAID,
        _id: db.command.neq(orderId)
      }).get().catch(() => ({ data: [] }))
      for (const sib of siblingRes.data || []) {
        if (!safeText(sib.staffOpenid).trim()) {
          try {
            await expireUnacceptedOrder(sib._id, sib, time, true)
          } catch (err) {
            console.error('[expireUnacceptedOrder] sibling expire failed:', sib._id, err.message)
          }
        }
      }
    }
  }
  return updatedOrder
}

async function expireDueUnacceptedOrders() {
  const time = now()
  try {
    const groupBuy = require('../services/playground-group-buy')({ db, now, createRefundForOrder })
    if (typeof groupBuy.expireDueGroupBuys === 'function') {
      await groupBuy.expireDueGroupBuys(time)
    }
  } catch (err) {
    console.error('[expireDueUnacceptedOrders] expireDueGroupBuys error:', err.message)
  }
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
