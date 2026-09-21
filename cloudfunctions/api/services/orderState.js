module.exports = function createService({
  ORDER_TRANSITIONS,
  db,
  safeText
}) {
  function isPaidOrder(order = {}) {
    return order.paymentStatus === 'paid' || ['paid', 'assigned', 'in_service', 'completed'].includes(order.status)
  }

  function canTransitionOrder(fromStatus, toStatus) {
    return (ORDER_TRANSITIONS[fromStatus] || []).includes(toStatus)
  }

  function assertOrderTransition(fromStatus, toStatus, message) {
    if (!canTransitionOrder(fromStatus, toStatus)) throw new Error(message || '订单状态不可流转')
  }

  function orderStatusText(status) {
    const normalized = String(status || '').toLowerCase().trim()
    const map = {
      pending_pay: '待支付',
      unpaid: '待支付',
      paying: '支付中',
      paid: '待接单',
      assigned: '已接单',
      in_service: '服务中',
      day_completed: '当天已完成',
      completed: '已完成',
      cancelled: '已取消',
      expired: '已过期',
      refunding: '退款中',
      refunded: '已退款',
      refund_applied: '退款申请中',
      refund_pending: '待退款',
      partial_refunded: '部分退款',
      pending_ship: '待发货',
      shipped: '已发货',
      auto_completed: '已完成',
      closed: '已关闭',
      timeout_closed: '超时关闭'
    }
    return map[normalized] || '处理中'
  }

  function checkinEventText(eventType) {
    return ({
      sanitization: '隔离病菌/消毒打卡',
      enter_door: '到达入户',
      leash_on: '牵引准备',
      feed: '喂食',
      water: '换水',
      pet_status: '宠物状态',
      return_home: '返家确认',
      leave_door: '离户检查',
      clean: '清洁',
      medicine: '喂药',
      video_checkin: '视频打卡',
      pet_beauty_photo: '宠物美照'
    })[eventType] || '服务打卡'
  }

  function publicOrderNo(order = {}) {
    const value = safeText(order.orderNo || order._id).trim()
    if (!value) return '近期订单'
    return `订单 ${value.slice(-6)}`
  }

  async function updateOrderWhenStatus(orderId, expectedStatus, data, message, extraWhere = {}) {
    const updated = await db.collection('orders').where({ _id: orderId, status: expectedStatus, ...extraWhere }).update({ data })
    if (!updated.stats || !updated.stats.updated) throw new Error(message)
    return updated
  }

  function isOpenOrder(order) {
    return !order.staffOpenid && (!order.publishMode || order.publishMode === 'open') && !order.requestedStaffOpenid
  }

  return {
    isPaidOrder,
    canTransitionOrder,
    assertOrderTransition,
    orderStatusText,
    checkinEventText,
    publicOrderNo,
    updateOrderWhenStatus,
    isOpenOrder
  }
}
