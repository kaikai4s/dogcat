function shouldRestoreMallRefundStock(order) {
  if (order.oversoldRefundRequired === true || order.stockRestored === true || !Array.isArray(order.items) || !order.items.length) return false
  const fulfillmentStatus = order.preRefundStatus || order.status
  if (fulfillmentStatus === 'pending_ship' && !order.shippedAt && !order.trackingNo && !order.receivedAt) return true
  return order.afterSaleType === 'return_and_refund' && Boolean(order.returnReceivedAt)
}

module.exports = { shouldRestoreMallRefundStock }
