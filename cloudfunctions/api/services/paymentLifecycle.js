module.exports = function createService({
  recordStaffDepositPayment, reserveOrderPayment, settleOrderPayment, requestOrderRefund,
  appendOrderClientMessage, createPaymentNo, notifyOrder, notifyOrderAccepted
}) {
  function buildMallOrderItemSnapshot(product, sku, quantity) {
    return { productId: product._id, skuId: sku.skuId, name: product.name, coverFileId: sku.imageFileId || product.coverFileId || '', price: Number(sku.price || 0), quantity, specText: sku.specText || '', specs: sku.specs || {}, skuSnapshot: { skuId: sku.skuId, specs: sku.specs || {}, specText: sku.specText || '', price: Number(sku.price || 0), originalPrice: Number(sku.originalPrice || 0), imageFileId: sku.imageFileId || '' } }
  }

  async function ensurePaymentRecord(order, openid, channel = 'mock', clientRequestId = '') {
    return reserveOrderPayment(order, openid, channel, clientRequestId)
  }

  async function markMallOrderPaid(orderId, order, paymentPayload = {}) {
    return markOrderPaid(orderId, paymentPayload)
  }

  async function markOrderPaid(orderId, paymentPayload = {}) {
    const result = await settleOrderPayment(orderId, paymentPayload)
    const order = result.order
    if (result.changed && result.orderType === 'service') {
      // Notifications cannot turn a committed payment into a failed callback.
      try {
        await appendOrderClientMessage(order, { eventType: 'paid', title: '订单已支付', detail: `支付金额 ¥${order.payAmount}`, actorRole: 'system', unreadForClient: true })
        await notifyOrder(order.clientOpenid, 'orderPaid', order, { amount: Number(order.payAmount), statusText: '已支付' })
        if (order.publishMode === 'direct' && order.requestedStaffOpenid) await notifyOrderAccepted(order, order.requestedStaffName)
      } catch (error) { console.error('[paid-notification]', { orderId, message: error.message }) }
    }
    return { orderId, status: 'paid', paymentNo: order.paymentNo }
  }

  async function markStaffDepositPaid(depositId, paymentPayload = {}) {
    return recordStaffDepositPayment(depositId, { ...paymentPayload, paymentNo: paymentPayload.paymentNo || createPaymentNo() })
  }

  async function createRefundForOrder(order, refundAmount, reason, source, operatorOpenid, clientRequestId = '', options = {}) {
    return requestOrderRefund(order, refundAmount, reason, source, operatorOpenid, clientRequestId, options)
  }

  return {
    buildMallOrderItemSnapshot,
    markMallOrderPaid,
    ensurePaymentRecord,
    markOrderPaid,
    markStaffDepositPaid,
    createRefundForOrder
  }
}
