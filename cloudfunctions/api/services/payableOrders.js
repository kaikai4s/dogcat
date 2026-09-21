module.exports = function createService({
  getDocOrNull,
  getUser
}) {
  async function getPayableOrder(orderId) {
    const serviceOrder = await getDocOrNull('orders', orderId)
    if (serviceOrder) return { order: serviceOrder, collectionName: 'orders', orderType: 'service' }
    const mallOrder = await getDocOrNull('mall_orders', orderId)
    if (mallOrder) return { order: mallOrder, collectionName: 'mall_orders', orderType: 'mall' }
    return { order: null, collectionName: '', orderType: '' }
  }

  async function requireClientPayableOrder(openid, orderId, message = '无权操作该订单') {
    const user = await getUser(openid)
    const resolved = await getPayableOrder(orderId)
    if (!resolved.order || resolved.order.clientOpenid !== openid) throw new Error(message)
    return { user, ...resolved }
  }

  return {
    getPayableOrder,
    requireClientPayableOrder
  }
}
