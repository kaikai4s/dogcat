const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('admin: 订单交易成功与完单后查看订单应当展示平台收益和宠托师收益', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      { _id: 'u_client', openid: 'openid_client', phone: '13800000001', nickname: '客户张三' },
      { _id: 'u_staff', openid: 'openid_staff', phone: '13900000002', nickname: '宠托师李四' }
    ],
    staff_profiles: [
      { _id: 'p_staff', openid: 'openid_staff', realName: '李四', phone: '13900000002', status: 'approved' }
    ],
    platform_configs: [
      {
        _id: 'system_settings',
        settlement: { staffCommissionRate: 0.7, settlementDelayDays: 1 }
      }
    ],
    orders: [
      // 1. 普通交易成功订单（客户已付款 100 元，服务中）
      {
        _id: 'order_in_service',
        orderNo: 'ORD_20261013_001',
        clientOpenid: 'openid_client',
        staffOpenid: 'openid_staff',
        status: 'in_service',
        paymentStatus: 'paid',
        paidAt: new Date('2026-10-13T10:00:00Z'),
        payAmount: 100,
        totalAmount: 100,
        refundAmount: 0,
        createdAt: new Date('2026-10-13T09:30:00Z')
      },
      // 2. 加急公共订单（客户支付 50 元，平台加急补贴宠托师收益 80 元）
      {
        _id: 'order_urgent',
        orderNo: 'ORD_20261013_002',
        clientOpenid: 'openid_client',
        staffOpenid: 'openid_staff',
        status: 'assigned',
        paymentStatus: 'paid',
        paidAt: new Date('2026-10-13T11:00:00Z'),
        payAmount: 50,
        totalAmount: 50,
        isUrgent: true,
        urgentStaffReward: 80,
        createdAt: new Date('2026-10-13T10:30:00Z')
      },
      // 3. 已完单结算订单（已入账 staff_earnings）
      {
        _id: 'order_completed',
        orderNo: 'ORD_20261013_003',
        clientOpenid: 'openid_client',
        staffOpenid: 'openid_staff',
        status: 'completed',
        paymentStatus: 'paid',
        paidAt: new Date('2026-10-13T08:00:00Z'),
        payAmount: 200,
        totalAmount: 200,
        refundAmount: 0,
        createdAt: new Date('2026-10-13T07:30:00Z')
      },
      // 4. 全额退款订单（客户付 100 已全退 100）
      {
        _id: 'order_refunded',
        orderNo: 'ORD_20261013_004',
        clientOpenid: 'openid_client',
        status: 'cancelled',
        paymentStatus: 'refunded',
        paidAt: new Date('2026-10-13T06:00:00Z'),
        payAmount: 100,
        totalAmount: 100,
        refundAmount: 100,
        createdAt: new Date('2026-10-13T05:30:00Z')
      }
    ],
    staff_earnings: [
      {
        _id: 'earning_order_completed',
        orderId: 'order_completed',
        orderNo: 'ORD_20261013_003',
        staffOpenid: 'openid_staff',
        amount: 140, // 200 * 0.7 = 140
        grossAmount: 200,
        commissionRate: 0.7,
        status: 'pending',
        createdAt: new Date('2026-10-13T12:00:00Z')
      }
    ]
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 1. 验证普通服务中订单：实付 100，宠托师 70，平台 30
  const res1 = await adminFn.main({
    module: 'admin',
    action: 'getOrderDetail',
    data: { id: 'order_in_service' }
  })
  assert.equal(res1.ok, true)
  const p1 = res1.data.order.profitSummary
  assert.ok(p1, '应该返回 profitSummary')
  assert.equal(p1.hasPayment, true)
  assert.equal(p1.payAmount, 100)
  assert.equal(p1.staffReward, 70) // 70%
  assert.equal(p1.platformProfit, 30) // 30%
  assert.equal(p1.isSubsidy, false)
  assert.match(p1.settlementStatusText, /预计收益/)

  // 2. 验证加急公共订单：实付 50，加急宠托师收益 80，平台补贴 -30
  const res2 = await adminFn.main({
    module: 'admin',
    action: 'getOrderDetail',
    data: { id: 'order_urgent' }
  })
  assert.equal(res2.ok, true)
  const p2 = res2.data.order.profitSummary
  assert.equal(p2.hasPayment, true)
  assert.equal(p2.payAmount, 50)
  assert.equal(p2.staffReward, 80)
  assert.equal(p2.platformProfit, -30)
  assert.equal(p2.isSubsidy, true)
  assert.equal(p2.subsidyAmount, 30)

  // 3. 验证已完单入账订单：实付 200，实际入账宠托师 140，平台 60
  const res3 = await adminFn.main({
    module: 'admin',
    action: 'getOrderDetail',
    data: { id: 'order_completed' }
  })
  assert.equal(res3.ok, true)
  const p3 = res3.data.order.profitSummary
  assert.equal(p3.hasPayment, true)
  assert.equal(p3.payAmount, 200)
  assert.equal(p3.staffReward, 140)
  assert.equal(p3.platformProfit, 60)
  assert.match(p3.settlementStatusText, /已完单结算入账/)

  // 4. 验证全额退款订单：净额 0，宠托师 0，平台 0
  const res4 = await adminFn.main({
    module: 'admin',
    action: 'getOrderDetail',
    data: { id: 'order_refunded' }
  })
  assert.equal(res4.ok, true)
  const p4 = res4.data.order.profitSummary
  assert.equal(p4.hasPayment, true)
  assert.equal(p4.netPayAmount, 0)
  assert.equal(p4.staffReward, 0)
  assert.equal(p4.platformProfit, 0)
  assert.match(p4.settlementStatusText, /已全额退款/)

  // 5. 验证列表接口 listOrders：每个已付款订单都附带 profitSummary
  const listRes = await adminFn.main({
    module: 'admin',
    action: 'listOrders',
    data: { pageSize: 20 }
  })
  assert.equal(listRes.ok, true)
  assert.ok(listRes.data.list.length >= 4)
  const inServiceItem = listRes.data.list.find((o) => o._id === 'order_in_service')
  assert.ok(inServiceItem)
  assert.equal(inServiceItem.staffReward, 70)
  assert.equal(inServiceItem.platformProfit, 30)
  assert.ok(inServiceItem.profitSummary)
})
