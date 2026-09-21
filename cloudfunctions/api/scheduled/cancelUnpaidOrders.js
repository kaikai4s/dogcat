module.exports = function createHelpers({ db, ORDER_STATUS, now, toTimeValue, appendOrderTimeline }) {
async function cancelUnpaidOrders() {
  const res = await db.collection('orders').where({ status: ORDER_STATUS.PENDING_PAY }).get()
  const time = now()
  const timeoutMinutes = 30
  const timeoutMs = timeoutMinutes * 60 * 1000
  const cancelledOrders = []

  for (const order of res.data || []) {
    const createdAt = toTimeValue(order.createdAt)
    if (createdAt > 0 && time.getTime() - createdAt > timeoutMs) {
      const update = {
        status: 'cancelled',
        cancelReason: `超过${timeoutMinutes}分钟未支付，系统自动取消`,
        cancelledAt: time,
        updatedAt: time
      }
      await db.collection('orders').doc(order._id).update({ data: update })

      if (order.couponId) {
        await db.collection('user_coupons').doc(order.couponId).update({
          data: {
            status: 'available',
            lockedOrderId: '',
            lockedAt: '',
            unlockedAt: time,
            updatedAt: time
          }
        })
      }

      await appendOrderTimeline(order._id, 'cancelled', '订单已取消', update.cancelReason, 'system')
      cancelledOrders.push(order._id)
    }
  }

  return cancelledOrders
}

return { cancelUnpaidOrders }
}
