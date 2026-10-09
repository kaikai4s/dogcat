const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('refund triggers automatic voiding or deduction of staff earnings', async () => {
  const staffOpenid = 'openid_staff_refund'
  const clientOpenid = 'openid_client_refund'
  const adminOpenid = 'openid_admin_refund'

  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: adminOpenid, roles: ['admin'], realName: '管理员', status: 'active' },
      { _id: 'u_staff', openid: staffOpenid, roles: ['staff'], realName: '张员工', status: 'active' },
      { _id: 'u_client', openid: clientOpenid, roles: ['client'], nickname: '李客户', status: 'active' }
    ],
    orders: [
      {
        _id: 'order_refund_full',
        orderNo: 'ORD_REFUND_FULL',
        clientOpenid,
        staffOpenid,
        status: 'completed',
        paymentStatus: 'paid',
        payAmount: 100,
        paidAt: new Date(),
        paymentNo: 'pay_full_001'
      },
      {
        _id: 'order_refund_part',
        orderNo: 'ORD_REFUND_PART',
        clientOpenid,
        staffOpenid,
        status: 'completed',
        paymentStatus: 'paid',
        payAmount: 100,
        paidAt: new Date(),
        paymentNo: 'pay_part_001'
      }
    ],
    staff_earnings: [
      {
        _id: 'earning_full',
        orderId: 'order_refund_full',
        staffOpenid,
        amount: 70,
        originalAmount: 70,
        status: 'available'
      },
      {
        _id: 'earning_part',
        orderId: 'order_refund_part',
        staffOpenid,
        amount: 70,
        originalAmount: 70,
        status: 'pending'
      }
    ],
    system_settings: [{
      _id: 'default',
      payment: { mode: 'mock' },
      settlement: { staffCommissionRate: 0.7, settlementDelayDays: 1 }
    }],
    refunds: [],
    finance_logs: [],
    admin_operation_logs: [],
    order_timeline: []
  })

  const adminApi = loadCloudFunction('api', db, adminOpenid)

  // 1. 管理员在后台全额退款 100 元 -> staff_earnings 应被全额作废
  const fullRefundRes = await adminApi.main({
    module: 'admin',
    action: 'refundOrder',
    data: {
      orderId: 'order_refund_full',
      refundAmount: 100,
      reason: '客户投诉全额退款'
    }
  })
  assert.equal(fullRefundRes.ok, true, fullRefundRes.error || '')

  const earningFull = db.state.staff_earnings.find(e => e._id === 'earning_full')
  assert.equal(earningFull.status, 'refunded_void')
  assert.equal(earningFull.amount, 0)
  assert.equal(earningFull.deductedAmount, 70)

  const voidLog = db.state.finance_logs.find(l => l.action === 'staff_earning_voided')
  assert.ok(voidLog, '应记录收益作废财务日志')
  assert.equal(voidLog.amountDelta, -70)

  // 2. 管理员部分退款 50 元 (50%) -> 70 元收益按比例扣除 35 元，剩余 35 元
  const partRefundRes = await adminApi.main({
    module: 'admin',
    action: 'refundOrder',
    data: {
      orderId: 'order_refund_part',
      refundAmount: 50,
      reason: '协商部分退款'
    }
  })
  assert.equal(partRefundRes.ok, true, partRefundRes.error || '')

  const earningPart = db.state.staff_earnings.find(e => e._id === 'earning_part')
  assert.equal(earningPart.status, 'pending')
  assert.equal(earningPart.amount, 35)
  assert.equal(earningPart.deductedAmount, 35)

  const partLog = db.state.finance_logs.find(l => l.action === 'staff_earning_partially_refunded')
  assert.ok(partLog, '应记录部分退款冲减财务日志')
  assert.equal(partLog.amountDelta, -35)
})

test('acceptDirectOrders setting disables booking for direct requests', async () => {
  const staffOpenid = 'openid_staff_direct'
  const clientOpenid = 'openid_client_direct'

  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: clientOpenid, roles: ['client'], phone: '13800000000', status: 'active' },
      { _id: 'u_staff', openid: staffOpenid, roles: ['staff'], phone: '13900000000', status: 'active' }
    ],
    pets: [
      { _id: 'pet_1', openid: clientOpenid, name: '旺财', species: 'dog' }
    ],
    staff_profiles: [
      {
        _id: 'sp_1',
        openid: staffOpenid,
        realName: '王宠托',
        auditStatus: 'approved',
        acceptDirectOrders: false,
        serviceAddress: '测试服务中心',
        serviceLatitude: 31.23,
        serviceLongitude: 121.47,
        serviceRadiusKm: 10,
        weeklySchedule: {
          '0': [{ start: 8, end: 20 }],
          '1': [{ start: 8, end: 20 }],
          '2': [{ start: 8, end: 20 }],
          '3': [{ start: 8, end: 20 }],
          '4': [{ start: 8, end: 20 }],
          '5': [{ start: 8, end: 20 }],
          '6': [{ start: 8, end: 20 }]
        }
      }
    ],
    system_settings: [{
      _id: 'default',
      payment: { mode: 'mock' },
      settlement: { staffCommissionRate: 0.7, settlementDelayDays: 1 }
    }],
    orders: []
  })

  const clientApi = loadCloudFunction('api', db, clientOpenid)

  const futureDate = new Date(Date.now() + 24 * 3600 * 1000 + 8 * 3600 * 1000)
  const dStr = `${futureDate.getUTCFullYear()}-${String(futureDate.getUTCMonth() + 1).padStart(2, '0')}-${String(futureDate.getUTCDate()).padStart(2, '0')}`
  const startTime = `${dStr} 14:00`
  const endTime = `${dStr} 15:00`

  const quoteRes = await clientApi.main({
    module: 'order',
    action: 'quoteOrder',
    data: {
      publishMode: 'direct',
      staffProfileId: 'sp_1',
      petIds: ['pet_1'],
      serviceType: 'walk',
      serviceTypes: ['visit_fee', 'walk'],
      serviceAddress: '测试服务中心',
      addressLatitude: 31.23,
      addressLongitude: 121.47,
      startTime,
      endTime
    }
  })

  assert.equal(quoteRes.ok, false)
  assert.match(quoteRes.error, /暂不接受指定预约/)
})

test('direct order locks time slot preventing another user from booking even before staff accepts', async () => {
  const staffOpenid = 'openid_staff_lock'
  const clientOpenid1 = 'openid_client_1'
  const clientOpenid2 = 'openid_client_2'

  const db = createCollectionStore({
    users: [
      { _id: 'u_client1', openid: clientOpenid1, roles: ['client'], phone: '13800000001', status: 'active' },
      { _id: 'u_client2', openid: clientOpenid2, roles: ['client'], phone: '13800000002', status: 'active' },
      { _id: 'u_staff', openid: staffOpenid, roles: ['staff'], phone: '13900000000', status: 'active' }
    ],
    pets: [
      { _id: 'pet_2', openid: clientOpenid2, name: '咪咪', species: 'cat' }
    ],
    staff_profiles: [
      {
        _id: 'sp_1',
        openid: staffOpenid,
        realName: '王宠托',
        auditStatus: 'approved',
        acceptDirectOrders: true,
        serviceAddress: '测试服务中心',
        serviceLatitude: 31.23,
        serviceLongitude: 121.47,
        serviceRadiusKm: 10,
        weeklySchedule: {
          '0': [{ start: 8, end: 20 }],
          '1': [{ start: 8, end: 20 }],
          '2': [{ start: 8, end: 20 }],
          '3': [{ start: 8, end: 20 }],
          '4': [{ start: 8, end: 20 }],
          '5': [{ start: 8, end: 20 }],
          '6': [{ start: 8, end: 20 }]
        }
      }
    ],
    orders: [
      {
        _id: 'order_locked_1',
        orderNo: 'ORD_LOCK_1',
        clientOpenid: clientOpenid1,
        requestedStaffOpenid: staffOpenid,
        requestedStaffProfileId: 'sp_1',
        staffOpenid: '',
        status: 'paid',
        paymentStatus: 'paid',
        publishMode: 'direct',
        startTime: '2099-10-01 10:00',
        endTime: '2099-10-01 11:00',
        serviceSessions: [{ index: 1, date: '2099-10-01', startTime: '2099-10-01 10:00', endTime: '2099-10-01 11:00', status: 'pending' }]
      }
    ],
    system_settings: [{
      _id: 'default',
      payment: { mode: 'mock' },
      settlement: { staffCommissionRate: 0.7, settlementDelayDays: 1 }
    }]
  })

  const client2Api = loadCloudFunction('api', db, clientOpenid2)

  const quoteRes = await client2Api.main({
    module: 'order',
    action: 'quoteOrder',
    data: {
      publishMode: 'direct',
      staffProfileId: 'sp_1',
      petIds: ['pet_2'],
      serviceType: 'feed',
      serviceTypes: ['visit_fee', 'feed'],
      serviceAddress: '测试服务中心',
      addressLatitude: 31.23,
      addressLongitude: 121.47,
      startTime: '2099-10-01 10:00',
      endTime: '2099-10-01 11:00'
    }
  })

  assert.equal(quoteRes.ok, false)
  assert.match(quoteRes.error, /已有订单，无法重复预约/)
})

test('due direct orders auto-accept after 1 hour', async () => {
  const staffOpenid = 'openid_staff_due'
  const oneHourAgo = new Date(Date.now() - 3605000)

  const db = createCollectionStore({
    users: [
      { _id: 'u_staff_1', openid: staffOpenid, roles: ['staff'], name: '王宠托', status: 'active' }
    ],
    staff_profiles: [
      {
        _id: 'sp_1',
        userId: 'u_staff_1',
        openid: staffOpenid,
        realName: '王宠托',
        phone: '13900000000',
        auditStatus: 'approved'
      }
    ],
    orders: [
      {
        _id: 'order_due_direct',
        orderNo: 'ORD_DUE_001',
        clientOpenid: 'client_1',
        requestedStaffOpenid: staffOpenid,
        requestedStaffProfileId: 'sp_1',
        requestedStaffName: '王宠托',
        staffOpenid: '',
        publishMode: 'direct',
        status: 'paid',
        paymentStatus: 'paid',
        createdAt: oneHourAgo,
        paidAt: oneHourAgo,
        startTime: '2026-10-15 10:00',
        endTime: '2026-10-15 11:00',
        serviceSessions: [{ index: 1, date: '2026-10-15', startTime: '2026-10-15 10:00', endTime: '2026-10-15 11:00', status: 'pending' }]
      }
    ],
    order_timeline: [],
    client_messages: []
  })

  const staffApi = loadCloudFunction('api', db, staffOpenid)

  // 宠托师拉取指定订单列表时，超时未接单的指定订单将自动执行 autoAcceptDueDirectOrders
  const listRes = await staffApi.main({
    module: 'staff',
    action: 'listDirectOrders',
    data: {}
  })
  assert.equal(listRes.ok, true, listRes.error || '')

  const updatedOrder = db.state.orders.find(o => o._id === 'order_due_direct')
  assert.equal(updatedOrder.status, 'assigned')
  assert.equal(updatedOrder.staffOpenid, staffOpenid)
  assert.equal(updatedOrder.assignmentSource, 'direct_auto_accept')
})

test('intern staff can configure service settings and acceptDirectOrders toggle', async () => {
  const staffOpenid = 'openid_staff_intern_config'

  const db = createCollectionStore({
    users: [
      { _id: 'u_intern', openid: staffOpenid, roles: ['staff'], name: '实习宠托师', status: 'active' }
    ],
    staff_profiles: [
      {
        _id: 'sp_intern_1',
        userId: 'u_intern',
        openid: staffOpenid,
        realName: '实习生',
        phone: '13811112222',
        gender: 'female',
        auditStatus: 'intern',
        acceptDirectOrders: true,
        serviceAddress: '原始服务点',
        serviceLatitude: 31.2,
        serviceLongitude: 121.4,
        serviceRadiusKm: 5
      }
    ]
  })

  const staffApi = loadCloudFunction('api', db, staffOpenid)

  const res = await staffApi.main({
    module: 'staff',
    action: 'updateStaffProfileConfig',
    data: {
      acceptDirectOrders: false,
      serviceAddress: '新实习服务中心',
      serviceLatitude: 31.25,
      serviceLongitude: 121.45,
      serviceRadiusKm: 8
    }
  })

  assert.equal(res.ok, true, res.error || '')
  const updated = db.state.staff_profiles.find(p => p._id === 'sp_intern_1')
  assert.equal(updated.acceptDirectOrders, false)
  assert.equal(updated.serviceAddress, '新实习服务中心')
  assert.equal(updated.serviceRadiusKm, 8)
})

