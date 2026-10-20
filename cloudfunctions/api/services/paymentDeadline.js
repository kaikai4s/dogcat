module.exports = function createService({ toTimeValue, now }) {
  function getOrderPaymentDeadline(order) {
    if (order.groupBuyId && Number.isFinite(order.paymentDeadline)) return order.paymentDeadline
    const createdAt = toTimeValue(order.createdAt)
    return createdAt > 0 ? createdAt + 30 * 60 * 1000 : 0
  }

  function assertOrderPaymentOpen(order) {
    if (order.groupBuyId && order.groupBuyStatus !== 'formed') throw new Error('拼单尚未成团，请在庄园“我的拼单”查看进度，成团后再付款')
    const deadline = getOrderPaymentDeadline(order)
    if (deadline && now().getTime() >= deadline) throw new Error('订单支付已超时，请重新下单')
  }

  return { getOrderPaymentDeadline, assertOrderPaymentOpen }
}
