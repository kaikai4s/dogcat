module.exports = function createService({
  db,
  now
}) {
  async function logAdmin(admin, targetType, targetId, action, detail) {
    await db.collection('admin_operation_logs').add({
      data: { adminUserId: admin._id, adminOpenid: admin.openid, targetType, targetId, action, detail: detail || {}, createdAt: now() }
    })
  }

  async function appendOrderTimeline(orderId, type, title, detail, actorRole) {
    await db.collection('order_timeline').add({
      data: { orderId, type, title, detail: detail || '', actorRole: actorRole || '', createdAt: now() }
    })
  }

  async function appendPaymentEvent(eventType, payload = {}) {
    await db.collection('payment_events').add({
      data: {
        eventType,
        orderId: payload.orderId || '',
        paymentNo: payload.paymentNo || '',
        refundNo: payload.refundNo || '',
        status: payload.status || '',
        detail: payload.detail || {},
        raw: payload.raw || {},
        createdAt: now()
      }
    })
  }

  async function appendFinanceLog(action, payload = {}) {
    await db.collection('finance_logs').add({
      data: {
        action,
        targetType: payload.targetType || '',
        targetId: payload.targetId || '',
        orderId: payload.orderId || '',
        staffOpenid: payload.staffOpenid || '',
        amountDelta: Number(payload.amountDelta || 0),
        detail: payload.detail || {},
        createdAt: now()
      }
    })
  }

  return {
    logAdmin,
    appendOrderTimeline,
    appendPaymentEvent,
    appendFinanceLog
  }
}
