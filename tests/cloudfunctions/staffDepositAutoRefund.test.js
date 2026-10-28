const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

function createTestDb(overrides = {}) {
  return createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', nickname: '管理员', roles: ['admin'], status: 'active' },
      { _id: 'u_staff_1', openid: 'openid_staff_1', nickname: '托师小李', phone: '13900001111', roles: ['client', 'staff'], activeRole: 'staff', status: 'active' },
      { _id: 'u_staff_2', openid: 'openid_staff_2', nickname: '托师小张', phone: '13900002222', roles: ['client', 'staff'], activeRole: 'staff', status: 'active' }
    ],
    staff_profiles: [
      {
        _id: 'sp_1',
        openid: 'openid_staff_1',
        userId: 'u_staff_1',
        realName: '李可退',
        phone: '13900001111',
        auditStatus: 'approved',
        staffLevel: 'certified',
        depositStatus: 'paid',
        exitStatus: 'none'
      },
      {
        _id: 'sp_2',
        openid: 'openid_staff_2',
        userId: 'u_staff_2',
        realName: '张有收益',
        phone: '13900002222',
        auditStatus: 'approved',
        staffLevel: 'certified',
        depositStatus: 'paid',
        exitStatus: 'none'
      }
    ],
    staff_deposits: [
      {
        _id: 'dep_1',
        staffOpenid: 'openid_staff_1',
        staffUserId: 'u_staff_1',
        staffProfileId: 'sp_1',
        amount: 500,
        paidAmount: 500,
        refundedAmount: 0,
        forfeitedAmount: 0,
        availableRefundAmount: 500,
        status: 'paid',
        paymentNo: 'P_DEP_TEST_001',
        createdAt: '2026-10-20T08:00:00.000Z'
      },
      {
        _id: 'dep_2',
        staffOpenid: 'openid_staff_2',
        staffUserId: 'u_staff_2',
        staffProfileId: 'sp_2',
        amount: 500,
        paidAmount: 500,
        refundedAmount: 0,
        forfeitedAmount: 0,
        availableRefundAmount: 500,
        status: 'paid',
        paymentNo: 'P_DEP_TEST_002',
        createdAt: '2026-10-20T08:00:00.000Z'
      }
    ],
    payments: [
      {
        _id: 'pay_dep_1',
        orderId: 'dep_1',
        depositId: 'dep_1',
        targetType: 'staff_deposit',
        paymentNo: 'P_DEP_TEST_001',
        amount: 500,
        channel: 'mock',
        status: 'success'
      },
      {
        _id: 'pay_dep_2',
        orderId: 'dep_2',
        depositId: 'dep_2',
        targetType: 'staff_deposit',
        paymentNo: 'P_DEP_TEST_002',
        amount: 500,
        channel: 'mock',
        status: 'success'
      }
    ],
    staff_earnings: [
      {
        _id: 'earn_2',
        staffOpenid: 'openid_staff_2',
        amount: 60.0,
        status: 'available'
      }
    ],
    withdraw_requests: [],
    orders: [],
    order_incidents: [],
    staff_deposit_events: [],
    finance_logs: [],
    refunds: [],
    admin_operation_logs: [],
    system_settings: [
      {
        _id: 'default',
        payment: {
          mode: 'mock',
          refundEnabled: true
        }
      }
    ]
  })
}

test('admin autoRefundStaffDeposit automatically refunds deposit, clears balance, and revokes staff role', async () => {
  const db = createTestDb()
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 管理员调用 autoRefundStaffDeposit 自动退还 dep_1
  const res = await adminFn.main({
    module: 'admin',
    action: 'autoRefundStaffDeposit',
    data: {
      id: 'dep_1',
      reason: '管理员自动退还入驻保证金'
    }
  })

  assert.equal(res.ok, true, 'autoRefundStaffDeposit must succeed')
  assert.equal(res.data.status, 'refunded')
  assert.equal(res.data.refundAmount, 500)
  assert.equal(res.data.exitCompleted, true)

  // 1. 验证 staff_deposits 状态与余额
  const deposit = db.state.staff_deposits.find((d) => d._id === 'dep_1')
  assert.equal(deposit.status, 'refunded')
  assert.equal(deposit.refundStatus, 'success')
  assert.equal(deposit.availableRefundAmount, 0)
  assert.equal(deposit.refundedAmount, 500)
  assert.ok(deposit.refundPaidAt)
  assert.equal(deposit.refundConfirmationSource, 'auto_mock')

  // 2. 验证 refunds 表生成了退款记录
  assert.equal(db.state.refunds.length, 1)
  const refundRec = db.state.refunds[0]
  assert.equal(refundRec.orderId, 'dep_1')
  assert.equal(refundRec.targetType, 'staff_deposit')
  assert.equal(refundRec.refundAmount, 500)
  assert.equal(refundRec.status, 'success')

  // 3. 验证 finance_logs 生成了扣减流水
  const financeLog = db.state.finance_logs.find((f) => f.targetId === 'dep_1')
  assert.ok(financeLog)
  assert.equal(financeLog.action, 'deposit_refunded')
  assert.equal(financeLog.amountDelta, -500)

  // 4. 验证 staff_profiles 与 users 角色完成退出
  const profile = db.state.staff_profiles.find((p) => p._id === 'sp_1')
  assert.equal(profile.exitStatus, 'exited')
  assert.equal(profile.depositStatus, 'refunded')
  assert.equal(profile.auditStatus, 'revoked')

  const user = db.state.users.find((u) => u._id === 'u_staff_1')
  assert.deepEqual(user.roles, ['client'])
  assert.equal(user.activeRole, 'client')
})

test('admin auditDepositRefund with autoRefund: true automatically settles deposit upon approval', async () => {
  const db = createTestDb()
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 先把 dep_1 标记为退款申请中
  db.state.staff_deposits[0].status = 'refund_requested'
  db.state.staff_deposits[0].refundStatus = 'requested'

  // 管理员审核通过并开启 autoRefund
  const res = await adminFn.main({
    module: 'admin',
    action: 'auditDepositRefund',
    data: {
      id: 'dep_1',
      approved: true,
      autoRefund: true,
      reason: '审核通过并原路退还'
    }
  })

  assert.equal(res.ok, true)
  assert.equal(res.data.status, 'refunded')

  const deposit = db.state.staff_deposits.find((d) => d._id === 'dep_1')
  assert.equal(deposit.status, 'refunded')
  assert.equal(deposit.availableRefundAmount, 0)
})

test('admin autoRefundStaffDeposit safely blocks refund when staff has unsettled earnings', async () => {
  const db = createTestDb()
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 张有收益 (sp_2) 还有 60 元未结清收益，直接退款应被拦截
  const res = await adminFn.main({
    module: 'admin',
    action: 'autoRefundStaffDeposit',
    data: {
      id: 'dep_2',
      reason: '直接退款'
    }
  })
  assert.equal(res.ok, false)
  assert.match(res.error || res.message, /尚有未结清收益/)

  const deposit = db.state.staff_deposits.find((d) => d._id === 'dep_2')
  assert.equal(deposit.availableRefundAmount, 500)
  assert.equal(deposit.status, 'paid')
})

test('staff requestDepositRefund correctly targets refundable deposit when multi records exist', async () => {
  const db = createTestDb()
  const staffFn = loadCloudFunction('api', db, 'openid_staff_1')

  // 给托师小李增加一条已退款的历史记录（0余额）和一条最新生成的待支付记录（0余额）
  // 夹在中间的 dep_1 是真正有 500 余额的记录
  db.state.staff_deposits.push({
    _id: 'dep_1_unpaid_new',
    staffOpenid: 'openid_staff_1',
    amount: 500,
    paidAmount: 0,
    availableRefundAmount: 0,
    status: 'unpaid',
    createdAt: '2026-10-25T08:00:00.000Z'
  })

  // 宠托师在端上申请退出
  const res = await staffFn.main({
    module: 'staff',
    action: 'requestDepositRefund',
    data: {
      reason: '个人原因自愿退出宠托师'
    }
  })

  assert.equal(res.ok, true)
  // 应该成功匹配到 dep_1
  const dep1 = db.state.staff_deposits.find((d) => d._id === 'dep_1')
  assert.equal(dep1.status, 'refund_requested')
  assert.equal(dep1.refundStatus, 'requested')
})
