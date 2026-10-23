const { documentPages, readOptionalDocument } = require('../utils/documentPages')

module.exports = function createService(context) {
  const { db, crypto, now } = context
  const page = 'pages/admin/mall/orders/index'
  const templateKey = 'adminMallOrderPaid'
  const deliveryKey = order => `admin_mall_paid:${order._id}`

  async function canReceiveMallOrder(user) {
    if (!user || !user.openid || !user.roles?.includes('admin') || ['disabled', 'deleted'].includes(user.status)) return false
    const flags = await context.getAdminPermissionFlags(user, ['adminMall.listOrders'])
    return flags['adminMall.listOrders'] === true
  }

  function messageData(order) {
    return context.buildSubscriptionData('orderPaid', { ...order, orderType: 'mall', businessType: 'mall' }, {})
  }

  async function enqueueMallPaidAdminNotifications(tx, order) {
    const id = 'mall_paid_' + crypto.createHash('sha256').update(order._id).digest('hex').slice(0, 32)
    if (await readOptionalDocument(tx, 'admin_notifications', id)) return []
    const recipients = []
    for await (const users of documentPages(tx, db.command, 'users', { roles: db.command.in(['admin']) })) {
      for (const user of users) {
        if (!await canReceiveMallOrder(user) || recipients.includes(user.openid)) continue
        recipients.push(user.openid)
        await context.enqueueSubscription(tx, { openid: user.openid, templateKey, orderId: order._id, page,
          messageData: messageData(order), deliveryKey: deliveryKey(order) })
      }
    }
    const time = now()
    await tx.collection('admin_notifications').doc(id).set({ data: {
      type: 'mall_order_paid', title: '商城新订单待发货', content: `商城订单 ${order.orderNo || order._id} 已支付，请及时发货。`,
      level: 'info', orderId: order._id, orderNo: order.orderNo || '', actionUrl: '/' + page,
      extra: { orderType: 'mall' }, read: false, readBy: [], idempotencyKey: id, createdAt: time, updatedAt: time
    } })
    return recipients
  }

  async function notifyMallPaidAdmins(order, recipients) {
    for (const openid of recipients || []) {
      await context.sendSubscribeMessage(openid, templateKey, page, messageData(order), order._id, deliveryKey(order))
    }
  }

  async function countPendingMallOrders() {
    // An order with an active after-sale request belongs to the after-sale count only.
    const where = db.command.or([
      { status: 'pending_ship', refundStatus: db.command.in(['none', 'rejected']) },
      { status: 'pending_ship', refundStatus: db.command.exists(false) },
      { status: 'pending_ship', refundStatus: '' },
      { refundStatus: db.command.in(['applied', 'return_shipped', 'pending_manual']) }
    ])
    return Number((await db.collection('mall_orders').where(where).count()).total || 0)
  }

  return { canReceiveMallOrder, enqueueMallPaidAdminNotifications, notifyMallPaidAdmins, countPendingMallOrders }
}
