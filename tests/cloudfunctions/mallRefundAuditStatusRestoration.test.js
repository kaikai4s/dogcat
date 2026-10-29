const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('mall refund audit rejection accurately restores pre-refund status and prevents status regression', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000001' },
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' }
    ],
    mall_products: [
      { _id: 'p1', name: '全价猫粮', price: 100, stock: 50, status: 'on_sale' }
    ],
    mall_orders: [
      // 1. 已完成收货订单（completed）
      {
        _id: 'order_completed',
        orderNo: 'MO10001',
        clientOpenid: 'openid_client',
        status: 'completed',
        paymentStatus: 'paid',
        payAmount: 100,
        amount: 100,
        expressCompany: '顺丰',
        trackingNo: 'SF12345678',
        shippedAt: '2026-09-20 10:00:00',
        receivedAt: '2026-09-22 14:00:00',
        items: [{ productId: 'p1', skuId: 'default', quantity: 1, price: 100 }]
      },
      // 2. 已发货订单（shipped）
      {
        _id: 'order_shipped',
        orderNo: 'MO10002',
        clientOpenid: 'openid_client',
        status: 'shipped',
        paymentStatus: 'paid',
        payAmount: 100,
        amount: 100,
        expressCompany: '中通',
        trackingNo: 'ZT87654321',
        shippedAt: '2026-09-23 09:00:00',
        items: [{ productId: 'p1', skuId: 'default', quantity: 1, price: 100 }]
      },
      // 3. 待发货订单（pending_ship）
      {
        _id: 'order_pending_ship',
        orderNo: 'MO10003',
        clientOpenid: 'openid_client',
        status: 'pending_ship',
        paymentStatus: 'paid',
        payAmount: 100,
        amount: 100,
        items: [{ productId: 'p1', skuId: 'default', quantity: 1, price: 100 }]
      },
      // 4. 历史遗留订单（缺少 preRefundStatus，但已有 receivedAt）
      {
        _id: 'order_legacy_completed',
        orderNo: 'MO10004',
        clientOpenid: 'openid_client',
        status: 'refund_applied',
        refundStatus: 'applied',
        paymentStatus: 'paid',
        payAmount: 100,
        amount: 100,
        expressCompany: '圆通',
        trackingNo: 'YT112233',
        shippedAt: '2026-09-18 10:00:00',
        receivedAt: '2026-09-19 12:00:00',
        items: [{ productId: 'p1', skuId: 'default', quantity: 1, price: 100 }]
      }
    ],
    admin_operation_logs: [],
    platform_configs: []
  })

  const clientApi = loadCloudFunction('api', db, 'openid_client')
  const adminApi = loadCloudFunction('api', db, 'openid_admin')

  // 场景 1：已完成收货的订单申请售后 -> 拒绝后必须准确恢复为 completed
  const applyRes1 = await clientApi.main({
    module: 'mall',
    action: 'applyRefund',
    data: { orderId: 'order_completed', reason: '不喜欢款式' }
  })
  assert.equal(applyRes1.ok, true)
  assert.equal(db.state.mall_orders.find((o) => o._id === 'order_completed').status, 'refund_applied')
  assert.equal(db.state.mall_orders.find((o) => o._id === 'order_completed').preRefundStatus, 'completed')

  const rejectRes1 = await adminApi.main({
    module: 'adminMall',
    action: 'auditRefund',
    data: { orderId: 'order_completed', approved: false, remark: '商品拆封已影响二次销售' }
  })
  assert.equal(rejectRes1.ok, true)
  assert.equal(rejectRes1.data.status, 'completed')
  assert.equal(rejectRes1.data.refundStatus, 'rejected')
  const order1InDb = db.state.mall_orders.find((o) => o._id === 'order_completed')
  assert.equal(order1InDb.status, 'completed', '已收货订单被拒绝后必须恢复为 completed，不能变更为 shipped 或 pending_ship')
  assert.equal(order1InDb.refundStatus, 'rejected')
  assert.equal(order1InDb.refundRejectReason, '商品拆封已影响二次销售')

  // 场景 2：已发货订单申请售后 -> 拒绝后恢复为 shipped
  const applyRes2 = await clientApi.main({
    module: 'mall',
    action: 'applyRefund',
    data: { orderId: 'order_shipped', reason: '想换个颜色' }
  })
  assert.equal(applyRes2.ok, true)
  assert.equal(db.state.mall_orders.find((o) => o._id === 'order_shipped').preRefundStatus, 'shipped')

  const rejectRes2 = await adminApi.main({
    module: 'adminMall',
    action: 'auditRefund',
    data: { orderId: 'order_shipped', approved: false, remark: '商品已在运输途中，请拒签或收货后退回' }
  })
  assert.equal(rejectRes2.ok, true)
  assert.equal(rejectRes2.data.status, 'shipped')
  const order2InDb = db.state.mall_orders.find((o) => o._id === 'order_shipped')
  assert.equal(order2InDb.status, 'shipped')
  assert.equal(order2InDb.refundStatus, 'rejected')

  // 场景 3：待发货订单申请售后 -> 拒绝后恢复为 pending_ship
  const applyRes3 = await clientApi.main({
    module: 'mall',
    action: 'applyRefund',
    data: { orderId: 'order_pending_ship', reason: '不小心下错了' }
  })
  assert.equal(applyRes3.ok, true)
  assert.equal(db.state.mall_orders.find((o) => o._id === 'order_pending_ship').preRefundStatus, 'pending_ship')

  const rejectRes3 = await adminApi.main({
    module: 'adminMall',
    action: 'auditRefund',
    data: { orderId: 'order_pending_ship', approved: false, remark: '定制商品已开始备货制作' }
  })
  assert.equal(rejectRes3.ok, true)
  assert.equal(rejectRes3.data.status, 'pending_ship')
  const order3InDb = db.state.mall_orders.find((o) => o._id === 'order_pending_ship')
  assert.equal(order3InDb.status, 'pending_ship')
  assert.equal(order3InDb.refundStatus, 'rejected')

  // 场景 4：历史遗留数据无 preRefundStatus，但有 receivedAt -> 兜底恢复为 completed
  const rejectRes4 = await adminApi.main({
    module: 'adminMall',
    action: 'auditRefund',
    data: { orderId: 'order_legacy_completed', approved: false, remark: '历史无理由退款超时' }
  })
  assert.equal(rejectRes4.ok, true)
  assert.equal(rejectRes4.data.status, 'completed')
  const order4InDb = db.state.mall_orders.find((o) => o._id === 'order_legacy_completed')
  assert.equal(order4InDb.status, 'completed', '历史无 preRefundStatus 但有 receivedAt 的订单拒绝后精准恢复为 completed')
  assert.equal(order4InDb.refundStatus, 'rejected')
})

test('mall partial compensation refund success restores preRefundStatus and updates refundStatus to partially_refunded', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000001' },
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' }
    ],
    mall_products: [
      { _id: 'p1', name: '全价猫粮', price: 100, stock: 50, status: 'on_sale' }
    ],
    mall_orders: [
      {
        _id: 'order_compensation_test',
        orderNo: 'MO10009',
        clientOpenid: 'openid_client',
        status: 'shipped',
        paymentStatus: 'paid',
        paymentNo: 'P202610150999',
        payAmount: 100,
        amount: 100,
        expressCompany: '顺丰',
        trackingNo: 'SF99998888',
        shippedAt: '2026-10-15 10:00:00',
        items: [{ productId: 'p1', skuId: 'default', quantity: 1, price: 100 }]
      }
    ],
    refunds: [],
    admin_operation_logs: [],
    platform_configs: [{ _id: 'global', payment: { mode: 'mock', refundEnabled: true } }]
  })

  const clientApi = loadCloudFunction('api', db, 'openid_client')
  const adminApi = loadCloudFunction('api', db, 'openid_admin')

  // 1. 买家申请破损少发补偿 ¥20
  const applyRes = await clientApi.main({
    module: 'mall',
    action: 'applyRefund',
    data: {
      orderId: 'order_compensation_test',
      afterSaleType: 'compensation',
      requestedAmount: 20,
      reason: '外包装破损少发一罐'
    }
  })
  assert.equal(applyRes.ok, true)
  const appliedOrder = db.state.mall_orders.find(o => o._id === 'order_compensation_test')
  assert.equal(appliedOrder.status, 'refund_applied')
  assert.equal(appliedOrder.preRefundStatus, 'shipped')
  assert.equal(appliedOrder.afterSaleType, 'compensation')

  // 2. 管理员同意赔付 ¥20
  const auditRes = await adminApi.main({
    module: 'adminMall',
    action: 'auditRefund',
    data: {
      orderId: 'order_compensation_test',
      approved: true,
      refundAmount: 20,
      remark: '核实属实，同意破损补偿20元'
    }
  })
  assert.equal(auditRes.ok, true)
  assert.equal(auditRes.data.refundAmount, 20)

  // 模拟支付的退款直接结算，不等待微信网关。
  const refundRecord = db.state.refunds.find(r => r.orderId === 'order_compensation_test')
  assert.ok(refundRecord, '退款记录已生成')
  assert.equal(refundRecord.status, 'success')
  assert.equal(refundRecord.refundAmount, 20)

  // 校验订单状态已从 refund_applied 恢复为 shipped（preRefundStatus）。
  const finalOrder = db.state.mall_orders.find(o => o._id === 'order_compensation_test')
  assert.equal(finalOrder.status, 'shipped', '部分补偿退款完成后，主状态必须恢复为 preRefundStatus(shipped)，不能卡在 refund_applied')
  assert.equal(finalOrder.refundStatus, 'partially_refunded')
  assert.equal(finalOrder.refundedAmount, 20)
  assert.equal(finalOrder.compensationAmount, 20)
})

