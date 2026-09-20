const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

function createTestDb(overrides = {}) {
  return createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', nickname: '管理员', roles: ['admin'], status: 'active' },
      { _id: 'u_client', openid: 'openid_client', nickname: '客户小张', phone: '13800001111', roles: ['client'], status: 'active' },
      { _id: 'u_staff', openid: 'openid_staff', nickname: '宠托师小李', phone: '13900002222', roles: ['client', 'staff'], status: 'active' }
    ],
    orders: [
      {
        _id: 'ord_1',
        orderNo: 'O20260920001',
        clientOpenid: 'openid_client',
        staffOpenid: 'openid_staff',
        status: 'paid',
        paymentStatus: 'paid',
        payAmount: 120,
        paidAt: '2026-09-20 10:00',
        serviceType: 'feed',
        serviceAddress: '测试小区1号楼',
        startTime: '2026-09-20 14:00',
        endTime: '2026-09-20 15:00'
      }
    ],
    mall_orders: [
      {
        _id: 'mall_ord_1',
        orderNo: 'M20260920001',
        openid: 'openid_client',
        clientOpenid: 'openid_client',
        status: 'pending_ship',
        paymentStatus: 'paid',
        payAmount: 88,
        paidAt: '2026-09-20 10:30',
        items: [{ productId: 'p1', name: '猫砂', price: 88, quantity: 1 }],
        shippingAddress: { contactName: '小张', contactPhone: '13800001111', serviceAddress: '测试小区1号楼' }
      }
    ],
    refunds: [],
    order_timeline: [],
    admin_operation_logs: [],
    client_messages: [],
    platform_configs: [
      {
        _id: 'cfg_1',
        key: 'system_settings',
        value: {
          payment: { mode: 'mock' }
        }
      }
    ],
    ...overrides
  })
}

test('admin can manually update service order status with remark and audit log', async () => {
  const db = createTestDb()
  const adminFn = loadCloudFunction('api', db, 'openid_admin')
  const clientFn = loadCloudFunction('api', db, 'openid_client')

  // Non-admin should be rejected
  const nonAdminAttempt = await clientFn.main({
    module: 'admin',
    action: 'updateOrderStatus',
    data: { orderId: 'ord_1', status: 'completed', remark: '尝试越权操作' }
  })
  assert.equal(nonAdminAttempt.ok, false)

  // Empty remark should be rejected
  const noRemarkAttempt = await adminFn.main({
    module: 'admin',
    action: 'updateOrderStatus',
    data: { orderId: 'ord_1', status: 'completed', remark: '' }
  })
  assert.equal(noRemarkAttempt.ok, false)
  assert.match(noRemarkAttempt.message, /操作说明/)

  // Invalid status should be rejected
  const invalidStatusAttempt = await adminFn.main({
    module: 'admin',
    action: 'updateOrderStatus',
    data: { orderId: 'ord_1', status: 'non_existent_status', remark: '测试' }
  })
  assert.equal(invalidStatusAttempt.ok, false)

  // Valid status change to completed
  const successResult = await adminFn.main({
    module: 'admin',
    action: 'updateOrderStatus',
    data: { orderId: 'ord_1', status: 'completed', remark: '线下与宠物主及宠托师核实，已服务完毕' }
  })
  assert.equal(successResult.ok, true)
  assert.equal(successResult.data.status, 'completed')
  assert.equal(successResult.data.prevStatus, 'paid')

  // Verify database update
  const order = db.state.orders.find((o) => o._id === 'ord_1')
  assert.equal(order.status, 'completed')
  assert.ok(order.completedAt)
  assert.equal(order.adminManualStatusRemark, '线下与宠物主及宠托师核实，已服务完毕')

  // Verify timeline and admin logs
  const timeline = db.state.order_timeline.filter((t) => t.orderId === 'ord_1')
  assert.ok(timeline.length > 0)
  assert.match(timeline[timeline.length - 1].title, /已完成/)

  const logs = db.state.admin_operation_logs.filter((l) => l.targetId === 'ord_1' && l.action === 'updateOrderStatus')
  assert.equal(logs.length, 1)
  assert.equal(logs[0].detail.targetStatus, 'completed')
})

test('admin can manually refund service order with custom amount and explanation', async () => {
  const db = createTestDb()
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // Partial refund: payAmount is 120, refund 50
  const refund1 = await adminFn.main({
    module: 'admin',
    action: 'refundOrder',
    data: { orderId: 'ord_1', refundAmount: 50, reason: '宠托师迟到半小时，协商部分退款' }
  })
  assert.equal(refund1.ok, true)
  assert.equal(refund1.data.refundAmount, 50)
  assert.equal(refund1.data.totalRefundAmount, 50)
  assert.equal(refund1.data.isFullRefund, false)

  let order = db.state.orders.find((o) => o._id === 'ord_1')
  assert.equal(order.refundAmount, 50)
  assert.equal(order.refundStatus, 'partially_refunded')

  // Exceeding remaining refundable amount (120 - 50 = 70) should be rejected
  const overRefund = await adminFn.main({
    module: 'admin',
    action: 'refundOrder',
    data: { orderId: 'ord_1', refundAmount: 80, reason: '超出上限' }
  })
  assert.equal(overRefund.ok, false)
  assert.match(overRefund.message, /上限/)

  // Refund remaining 70 (full refund)
  const refund2 = await adminFn.main({
    module: 'admin',
    action: 'refundOrder',
    data: { orderId: 'ord_1', refundAmount: 70, reason: '退还剩余费用' }
  })
  assert.equal(refund2.ok, true)
  assert.equal(refund2.data.totalRefundAmount, 120)
  assert.equal(refund2.data.isFullRefund, true)

  order = db.state.orders.find((o) => o._id === 'ord_1')
  assert.equal(order.refundAmount, 120)
  assert.equal(order.status, 'refunded')
  assert.equal(order.paymentStatus, 'refunded')
})

test('admin can manually update mall order status and manually refund mall order', async () => {
  const db = createTestDb()
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 1. Manually update mall order status to completed
  const updateRes = await adminFn.main({
    module: 'adminMall',
    action: 'updateOrderStatus',
    data: { orderId: 'mall_ord_1', status: 'completed', remark: '客户已自提商品，状态改为已完成' }
  })
  assert.equal(updateRes.ok, true)
  assert.equal(updateRes.data.status, 'completed')

  const mallOrder = db.state.mall_orders.find((o) => o._id === 'mall_ord_1')
  assert.equal(mallOrder.status, 'completed')
  assert.equal(mallOrder.adminManualStatusRemark, '客户已自提商品，状态改为已完成')

  // 2. Manually refund mall order (custom amount 30 out of 88)
  const refundRes = await adminFn.main({
    module: 'adminMall',
    action: 'refundOrder',
    data: { orderId: 'mall_ord_1', refundAmount: 30, reason: '包装破损，退差价30元' }
  })
  assert.equal(refundRes.ok, true)
  assert.equal(refundRes.data.refundAmount, 30)
  assert.equal(refundRes.data.totalRefundAmount, 30)
  assert.equal(refundRes.data.isFullRefund, false)

  assert.equal(mallOrder.refundAmount, 30)
  assert.equal(mallOrder.refundStatus, 'partially_refunded')

  // 3. Exceeding max refundable amount check
  const overRefund = await adminFn.main({
    module: 'adminMall',
    action: 'refundOrder',
    data: { orderId: 'mall_ord_1', refundAmount: 60, reason: '超出可退余额 (剩余58)' }
  })
  assert.equal(overRefund.ok, false)
  assert.match(overRefund.message, /上限/)
})
