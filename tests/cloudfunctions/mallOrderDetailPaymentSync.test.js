const test = require('node:test')
const assert = require('node:assert/strict')

const createMallHandler = require('../../cloudfunctions/api/handlers/mall')
const createAdminMallHandler = require('../../cloudfunctions/api/handlers/adminMall')

test('mall.getOrderDetail automatically synchronizes paid WeChat order and marks it pending_ship', async () => {
  const order = {
    _id: 'mall_order_auto_sync',
    orderNo: 'MO202610150001',
    clientOpenid: 'client_openid',
    status: 'pending_pay',
    paymentStatus: 'unpaid',
    paymentNo: 'P202610150002',
    payAmount: 99.00,
    items: [{ productId: 'p1', skuId: 'sku1', name: '猫抓板', quantity: 1, price: 99 }]
  }

  const payments = [{
    _id: 'payment_mall_1',
    orderId: order._id,
    paymentNo: order.paymentNo,
    amount: 99.00,
    channel: 'wechat',
    status: 'pending'
  }]

  let synced = false

  const handler = createMallHandler({
    db: {},
    getDocOrNull: async (col, id) => {
      assert.equal(col, 'mall_orders')
      assert.equal(id, order._id)
      return { ...order }
    },
    readScopedDocuments: async (col, where) => {
      assert.equal(col, 'payments')
      assert.equal(where.orderId, order._id)
      return payments
    },
    syncWechatPaidOrder: async (currentOrder, currentPayments) => {
      synced = true
      assert.equal(currentOrder._id, order._id)
      assert.equal(currentPayments[0].paymentNo, order.paymentNo)
      return {
        ...currentOrder,
        status: 'pending_ship',
        paymentStatus: 'paid',
        paidAt: '2026-10-15 15:35:00'
      }
    },
    mallOrderStatusText: (status) => {
      if (status === 'pending_ship') return '待发货'
      if (status === 'pending_pay') return '待付款'
      return status
    }
  })

  const result = await handler('client_openid', 'getOrderDetail', { orderId: order._id })

  assert.equal(synced, true)
  assert.equal(result.status, 'pending_ship')
  assert.equal(result.paymentStatus, 'paid')
  assert.equal(result.statusText, '待发货')
  assert.equal(result.paidAt, '2026-10-15 15:35:00')
})

test('adminMall.getOrderDetail also synchronizes unpaid WeChat order when payments exist', async () => {
  const order = {
    _id: 'mall_order_admin_sync',
    orderNo: 'MO202610150002',
    clientOpenid: 'client_openid',
    status: 'pending_pay',
    paymentStatus: 'unpaid',
    paymentNo: 'P202610150003',
    payAmount: 150.00,
    items: [{ productId: 'p2', skuId: 'sku2', name: '全价冻干', quantity: 2, price: 75 }]
  }

  const payments = [{
    _id: 'payment_mall_2',
    orderId: order._id,
    paymentNo: order.paymentNo,
    amount: 150.00,
    channel: 'wechat',
    status: 'pending'
  }]

  let adminSynced = false

  const handler = createAdminMallHandler({
    db: {
      collection: () => ({
        where: () => ({
          get: async () => ({ data: [] })
        })
      })
    },
    requireAdmin: async () => ({ openid: 'admin_openid', roles: ['admin'] }),
    getDocOrNull: async (col, id) => {
      assert.equal(col, 'mall_orders')
      assert.equal(id, order._id)
      return { ...order }
    },
    readScopedDocuments: async (col, where) => {
      assert.equal(col, 'payments')
      assert.equal(where.orderId, order._id)
      return payments
    },
    syncWechatPaidOrder: async (currentOrder) => {
      adminSynced = true
      return {
        ...currentOrder,
        status: 'pending_ship',
        paymentStatus: 'paid',
        paidAt: '2026-10-15 15:36:00'
      }
    },
    mallOrderStatusText: (status) => {
      if (status === 'pending_ship') return '待发货'
      return status
    }
  })

  const result = await handler('admin_openid', 'getOrderDetail', { orderId: order._id })

  assert.equal(adminSynced, true)
  assert.equal(result.status, 'pending_ship')
  assert.equal(result.paymentStatus, 'paid')
  assert.equal(result.statusText, '待发货')
  assert.equal(result.maxRefundable, 150)
})
