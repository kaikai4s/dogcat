function getOrderRefundState(order = {}) {
  if (order.paymentStatus === 'refunding' || order.refundStatus === 'processing' || order.status === 'refunding') return 'refunding'
  if (order.paymentStatus === 'refunded' || ['refunded', 'partial_refunded'].includes(order.status) ||
    ['success', 'refunded', 'full_refunded', 'partially_refunded'].includes(order.refundStatus) || Number(order.refundedAmount) > 0) return 'refunded'
  return ''
}

module.exports = { getOrderRefundState }
