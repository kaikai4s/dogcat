const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

function createTestDb(overrides = {}) {
  return createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', nickname: '管理员', roles: ['admin'], status: 'active' },
      { _id: 'u_staff', openid: 'openid_staff', nickname: '宠托师小李', phone: '13900001111', roles: ['client', 'staff'], status: 'active' }
    ],
    staff_profiles: [
      {
        _id: 'sp_1',
        openid: 'openid_staff',
        realName: '李小宠',
        phone: '13900001111',
        auditStatus: 'approved',
        staffLevel: 'intern',
        depositStatus: 'unpaid',
        exitStatus: 'none'
      }
    ],
    staff_deposits: [],
    staff_deposit_events: [],
    staff_supply_reimbursements: [],
    finance_logs: [],
    admin_operation_logs: [],
    payments: [],
    platform_configs: [
      {
        _id: 'cfg_1',
        key: 'system_settings',
        value: {
          staffDeposit: {
            enabled: true,
            amount: 500,
            rulesText: '资料审核通过后缴纳保证金，退出全额退还，违规没收',
            refundRulesText: '自愿退出且无未结事项可申请全额退还',
            forfeitRulesText: '违规将没收保证金'
          },
          payment: { mode: 'mock' }
        }
      }
    ],
    orders: [],
    order_incidents: [],
    ...overrides
  })
}

test('repay deposit after full refund succeeds and clears exited status', async () => {
  const db = createTestDb()
  const staffFn = loadCloudFunction('api', db, 'openid_staff')
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 1. Initial pay deposit
  const pay1 = await staffFn.main({ module: 'staff', action: 'createDepositPayment', data: { agreed: true } })
  assert.equal(pay1.ok, true)
  assert.equal(pay1.data.paid, true)

  // 2. Request refund & admin confirms refund
  const refundReq = await staffFn.main({ module: 'staff', action: 'requestDepositRefund', data: { reason: '退出' } })
  assert.equal(refundReq.ok, true)

  const adminDeposits = await adminFn.main({ module: 'admin', action: 'listStaffDeposits', data: {} })
  const depositId = adminDeposits.data[0]._id

  await adminFn.main({ module: 'admin', action: 'auditDepositRefund', data: { id: depositId, approved: true, reason: '通过' } })
  await adminFn.main({ module: 'admin', action: 'confirmDepositRefund', data: { id: depositId, paymentConfirmed: true, paymentReference: 'ref-01' } })

  // Profile is now exited, but if sitter wants to rejoin and admin sets approved / requireDepositRepay:
  db.state.staff_profiles[0].auditStatus = 'approved'
  db.state.staff_profiles[0].requireDepositRepay = true
  db.state.staff_profiles[0].requireDepositRepayReason = '重新入驻需缴纳保证金'

  // 3. Check status: canPay and needsRepay must both be true
  const statusBeforeRepay = await staffFn.main({ module: 'staff', action: 'getDepositStatus' })
  assert.equal(statusBeforeRepay.ok, true)
  assert.equal(statusBeforeRepay.data.canPay, true)
  assert.equal(statusBeforeRepay.data.needsRepay, true)

  // 4. Repay deposit: should NOT fail with '当前资料状态不支持缴纳保证金' or '无需重复缴纳'
  const repayRes = await staffFn.main({ module: 'staff', action: 'createDepositPayment', data: { agreed: true } })
  assert.equal(repayRes.ok, true)
  assert.equal(repayRes.data.paid, true)
  assert.equal(repayRes.data.isMock, true)

  // 5. Verify deposit and profile status
  const statusAfterRepay = await staffFn.main({ module: 'staff', action: 'getDepositStatus' })
  assert.equal(statusAfterRepay.data.deposit.status, 'paid')
  assert.equal(statusAfterRepay.data.deposit.paidAmount, 500)
  assert.equal(statusAfterRepay.data.deposit.availableRefundAmount, 500)
  assert.equal(statusAfterRepay.data.profile.exitStatus, 'none')
  assert.equal(statusAfterRepay.data.profile.depositStatus, 'paid')
  assert.equal(statusAfterRepay.data.profile.requireDepositRepay, false)
})

test('multiple historical unpaid deposits do not block new payment creation', async () => {
  const db = createTestDb({
    staff_deposits: [
      {
        _id: 'dep_old_unpaid',
        staffOpenid: 'openid_staff',
        staffUserId: 'u_staff',
        staffProfileId: 'sp_1',
        amount: 500,
        paidAmount: 0,
        refundedAmount: 0,
        forfeitedAmount: 0,
        availableRefundAmount: 0,
        status: 'unpaid',
        statusText: '待支付',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z'
      }
    ],
    payments: [
      {
        _id: 'pay_old',
        orderId: 'dep_old_unpaid',
        depositId: 'dep_old_unpaid',
        targetType: 'staff_deposit',
        openid: 'openid_staff',
        paymentNo: 'Pold123',
        amount: 500,
        status: 'pending',
        channel: 'mock',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z'
      }
    ]
  })
  db.state.staff_profiles[0].currentDepositId = 'dep_old_unpaid'

  const staffFn = loadCloudFunction('api', db, 'openid_staff')

  // Calling createDepositPayment should succeed without throwing '存在多笔保证金记录，请先对账'
  const result = await staffFn.main({ module: 'staff', action: 'createDepositPayment', data: { agreed: true } })
  assert.equal(result.ok, true)
  assert.equal(result.data.paid, true)
})

test('creating deposit payment is blocked during active refund processing', async () => {
  const db = createTestDb({
    staff_deposits: [
      {
        _id: 'dep_ref_pending',
        staffOpenid: 'openid_staff',
        staffUserId: 'u_staff',
        staffProfileId: 'sp_1',
        amount: 500,
        paidAmount: 500,
        refundedAmount: 0,
        forfeitedAmount: 0,
        availableRefundAmount: 500,
        status: 'refund_requested',
        statusText: '退款审核中',
        refundStatus: 'requested',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z'
      }
    ]
  })
  db.state.staff_profiles[0].currentDepositId = 'dep_ref_pending'
  db.state.staff_profiles[0].exitStatus = 'requested'
  db.state.staff_profiles[0].depositStatus = 'refund_requested'

  const staffFn = loadCloudFunction('api', db, 'openid_staff')

  const result = await staffFn.main({ module: 'staff', action: 'createDepositPayment', data: { agreed: true } })
  assert.equal(result.ok, false)
  assert.match(result.message, /退还流程处理中/)
})
