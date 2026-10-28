const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('autoRefundStaffDeposit uses deterministic idempotent refundNo preventing duplicate cashouts', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      { _id: 'u_staff', openid: 'openid_staff', roles: ['client', 'staff'], status: 'active' }
    ],
    staff_profiles: [
      {
        _id: 'sp_1',
        openid: 'openid_staff',
        realName: '测试宠托师',
        auditStatus: 'approved',
        staffLevel: 'certified',
        depositStatus: 'paid'
      }
    ],
    staff_deposits: [
      {
        _id: 'dep_1',
        staffOpenid: 'openid_staff',
        staffUserId: 'u_staff',
        staffProfileId: 'sp_1',
        amount: 500,
        paidAmount: 500,
        refundedAmount: 0,
        forfeitedAmount: 0,
        availableRefundAmount: 500,
        status: 'paid',
        statusText: '已缴纳',
        createdAt: '2026-01-01T00:00:00Z',
        paidAt: '2026-01-01T00:05:00Z'
      }
    ],
    payments: [
      {
        _id: 'pay_1',
        orderId: 'dep_1',
        depositId: 'dep_1',
        targetType: 'staff_deposit',
        paymentNo: 'P123',
        amount: 500,
        channel: 'mock',
        status: 'success'
      }
    ],
    staff_deposit_events: [],
    finance_logs: [],
    admin_operation_logs: [],
    refunds: [],
    orders: [],
    order_incidents: [],
    platform_configs: [
      {
        _id: 'cfg_1',
        key: 'system_settings',
        value: {
          staffDeposit: { enabled: true, amount: 500 },
          payment: { mode: 'mock' }
        }
      }
    ]
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin')
  const refundRes = await adminFn.main({
    module: 'admin',
    action: 'autoRefundStaffDeposit',
    data: { depositId: 'dep_1', reason: '自愿退出退款' }
  })

  assert.equal(refundRes.ok, true)
  assert.equal(refundRes.data.status, 'refunded')
  assert.ok(refundRes.data.refundNo, 'refundNo must be generated')

  const updatedDep = db.state.staff_deposits.find(d => d._id === 'dep_1')
  assert.equal(updatedDep.lastRefundNo, refundRes.data.refundNo)
})

test('client order payment does not reuse prepayId older than 90 minutes', async () => {
  const expiredTime = new Date(Date.now() - 100 * 60 * 1000).toISOString()
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active' }
    ],
    orders: [
      {
        _id: 'order_1',
        orderNo: 'ORD001',
        clientOpenid: 'openid_client',
        clientUserId: 'u_client',
        status: 'pending_pay',
        paymentStatus: 'unpaid',
        payAmount: 100,
        groupBuyId: 'gb1',
        paymentDeadline: Date.now() + 24 * 3600 * 1000,
        createdAt: expiredTime
      }
    ],
    payments: [
      {
        _id: 'pay_expired',
        orderId: 'order_1',
        targetType: 'service_order',
        openid: 'openid_client',
        paymentNo: 'P001',
        amount: 100,
        channel: 'mock',
        prepayId: 'wx_expired_prepay_123',
        status: 'pending',
        createdAt: expiredTime,
        updatedAt: expiredTime
      }
    ],
    platform_configs: [
      {
        _id: 'cfg_1',
        key: 'system_settings',
        value: {
          payment: { mode: 'mock' }
        }
      }
    ]
  })

  const clientFn = loadCloudFunction('api', db, 'openid_client')
  const payRes = await clientFn.main({
    module: 'payment',
    action: 'createPayment',
    data: { orderId: 'order_1' }
  })

  assert.equal(payRes.ok, true)
  assert.equal(payRes.data.mock, true)
})
