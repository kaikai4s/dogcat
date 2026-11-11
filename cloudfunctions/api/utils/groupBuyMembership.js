// A paid household remains a member during a partial refund. Terminal
// cancellation and failed payment activation remove it from live operations.
function isParticipatingGroupOrder(order) {
  return !!order && !order.deletedAt && !order.adminDeletedAt && !order.groupBuyRefundRequired &&
    ['paid', 'refunding'].includes(order.paymentStatus) &&
    !['pending_pay', 'cancelled', 'closed', 'refunded', 'expired'].includes(order.status)
}

module.exports = { isParticipatingGroupOrder }
