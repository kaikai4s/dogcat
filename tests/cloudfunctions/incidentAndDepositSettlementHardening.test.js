const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')

test('incident status protection: closed/resolved incident cannot be reverted and frozen earnings must be resolved first', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin', 'client'], status: 'active' },
      { _id: 'u_staff', openid: 'openid_staff', roles: ['staff', 'client'], status: 'active' },
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active' }
    ],
    orders: [
      {
        _id: 'ord_1',
        orderNo: 'O_1',
        clientOpenid: 'openid_client',
        staffOpenid: 'openid_staff',
        status: 'completed',
        paymentStatus: 'paid',
        payAmount: 100
      }
    ],
    staff_earnings: [
      {
        _id: 'earn_1',
        orderId: 'ord_1',
        staffOpenid: 'openid_staff',
        amount: 80,
        status: 'frozen',
        frozenIncidentId: 'inc_frozen_1'
      }
    ],
    order_incidents: [
      {
        _id: 'inc_closed_1',
        orderId: 'ord_1',
        clientOpenid: 'openid_client',
        staffOpenid: 'openid_staff',
        status: 'closed',
        createdAt: '2026-09-01 10:00:00'
      },
      {
        _id: 'inc_frozen_1',
        orderId: 'ord_1',
        clientOpenid: 'openid_client',
        staffOpenid: 'openid_staff',
        status: 'processing',
        frozenEarningIds: ['earn_1'],
        earningResolution: null,
        createdAt: '2026-09-01 10:00:00'
      },
      {
        _id: 'inc_normal_1',
        orderId: 'ord_1',
        clientOpenid: 'openid_client',
        staffOpenid: 'openid_staff',
        status: 'open',
        createdAt: '2026-09-01 10:00:00'
      }
    ],
    incident_actions: []
  })

  const adminApi = loadCloudFunction('api', db, 'openid_admin')

  // 1. 已结案的纠纷禁止通过 updateIncidentStatus 变更回 open 或 processing
  const resRevertClosed = await adminApi.main({
    module: 'incident',
    action: 'updateIncidentStatus',
    data: {
      incidentId: 'inc_closed_1',
      status: 'open'
    }
  })
  assert.equal(resRevertClosed.ok, false)
  assert.match(resRevertClosed.message, /已结案纠纷不可变更状态/)

  // 2. 已结案纠纷若传入相同状态，幂等返回成功
  const resIdempotentClosed = await adminApi.main({
    module: 'incident',
    action: 'updateIncidentStatus',
    data: {
      incidentId: 'inc_closed_1',
      status: 'closed'
    }
  })
  assert.equal(resIdempotentClosed.ok, true)
  assert.equal(resIdempotentClosed.data.status, 'closed')

  // 3. 工单存在冻结收益且未结算时，直接 resolveIncident 结案被拦截
  const resResolveWithFrozen = await adminApi.main({
    module: 'incident',
    action: 'resolveIncident',
    data: {
      incidentId: 'inc_frozen_1',
      status: 'resolved'
    }
  })
  assert.equal(resResolveWithFrozen.ok, false)
  assert.match(resResolveWithFrozen.message, /纠纷存在未处理的冻结收益，请通过结案流程结算收益/)

  // 4. 工单正常流转 open -> processing 成功
  const resNormalUpdate = await adminApi.main({
    module: 'incident',
    action: 'updateIncidentStatus',
    data: {
      incidentId: 'inc_normal_1',
      status: 'processing'
    }
  })
  assert.equal(resNormalUpdate.ok, true)
  assert.equal(resNormalUpdate.data.status, 'processing')
  assert.equal(db.state.order_incidents.find((i) => i._id === 'inc_normal_1').status, 'processing')
})

test('deposit settlement: confirmDepositRefund syncs users roles by removing staff role and resetting activeRole', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin', 'client'], status: 'active' },
      { _id: 'u_staff', openid: 'openid_staff', roles: ['client', 'staff'], activeRole: 'staff', status: 'active' }
    ],
    staff_profiles: [
      {
        _id: 'prof_staff_1',
        userId: 'u_staff',
        openid: 'openid_staff',
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
        staffProfileId: 'prof_staff_1',
        status: 'paid',
        paidAmount: 500,
        amount: 500,
        availableRefundAmount: 500,
        refundedAmount: 0,
        forfeitedAmount: 0
      }
    ],
    staff_deposit_events: [],
    finance_logs: [],
    admin_operation_logs: [],
    orders: [],
    order_incidents: []
  })

  const context = createContext({ db, cloud: {} })
  const admin = { _id: 'u_admin', openid: 'openid_admin' }

  // 1. 宠托师申请退还保证金
  await context.requestStaffDepositRefund('openid_staff', 'dep_1', '自愿退出宠托师')
  assert.equal(db.state.staff_deposits[0].status, 'refund_requested')

  // 2. 管理员审核通过
  await context.settleStaffDeposit(admin, 'auditDepositRefund', { id: 'dep_1', approved: true })
  assert.equal(db.state.staff_deposits[0].status, 'refund_approved')

  // 3. 管理员确认打款退还
  const confirmRes = await context.settleStaffDeposit(admin, 'confirmDepositRefund', {
    id: 'dep_1',
    paymentConfirmed: true,
    paymentReference: 'transfer-ref-001'
  })
  assert.equal(confirmRes.status, 'refunded')

  // 4. 验证 staff_profiles 与 staff_deposits 状态
  const profile = db.state.staff_profiles[0]
  assert.equal(profile.exitStatus, 'exited')
  assert.equal(profile.depositStatus, 'refunded')
  assert.equal(profile.auditStatus, 'revoked')

  // 5. 重点验证：users 集合中的 roles 已同步移除 staff，且 activeRole 重置为 client
  const user = db.state.users.find((u) => u._id === 'u_staff')
  assert.deepEqual(user.roles, ['client'])
  assert.equal(user.activeRole, 'client')
})

test('mall after-sale refund transaction: rejects refund if order refundStatus is no longer applied (concurrency guard)', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin', 'client'], status: 'active' },
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active' }
    ],
    mall_orders: [
      {
        _id: 'mall_ord_1',
        orderNo: 'MO_1',
        clientOpenid: 'openid_client',
        status: 'shipped',
        preRefundStatus: 'shipped',
        paymentStatus: 'paid',
        paymentNo: 'MP_1',
        wxTransactionId: 'wx_tx_1',
        payAmount: 100,
        refundAmount: 0,
        refundStatus: 'rejected', // 已经被另一个管理员驳回
        items: [{ productId: 'p1', quantity: 1, unitPrice: 100, price: 100 }]
      }
    ],
    refunds: [],
    payment_events: [],
    system_settings: [{
      _id: 'global',
      payment: { mode: 'mock', refundEnabled: true }
    }]
  })

  const context = createContext({ db, cloud: {} })

  // 尝试对已处于 rejected 的商城订单发起 mall_after_sale 退款，应被事务原子拦截
  const order = db.state.mall_orders[0]
  await assert.rejects(
    context.createRefundForOrder(order, 100, '同意退款', 'mall_after_sale', 'openid_admin', 'req_after_sale_1'),
    /售后状态已变化，请刷新后重试/
  )
})
