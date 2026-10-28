const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

const address = { name: '李小宠', phone: '13900001111', province: '上海市', city: '上海市', district: '浦东新区', detail: '幸福路 18 号' }

function setup() {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'admin', roles: ['admin'], status: 'active' },
      { _id: 'u_staff', openid: 'staff', roles: ['client', 'staff'], status: 'active' }
    ],
    staff_profiles: [{ _id: 'profile', openid: 'staff', userId: 'u_staff', auditStatus: 'approved', staffLevel: 'certified', exitStatus: 'none', depositStatus: 'unpaid' }],
    staff_deposits: [], staff_deposit_events: [], staff_supply_reimbursements: [],
    finance_logs: [], admin_operation_logs: [], orders: [], order_incidents: [], user_invites: [], mall_orders: [],
    platform_configs: [{ _id: 'cfg', key: 'system_settings', value: {
      staffDeposit: { enabled: true, amount: 500 },
      staffSupplies: { shippingEnabled: true, supplyFeeAmount: 120, reimbursementEnabled: true,
        reimbursementMode: 'order_count', reimbursementOrderCount: 0, purchaseRequired: true },
      payment: { mode: 'mock' }
    } }]
  })
  return { db, staff: loadCloudFunction('api', db, 'staff'), admin: loadCloudFunction('api', db, 'admin') }
}

async function paid(fixture) {
  const result = await fixture.staff.main({ module: 'staff', action: 'createDepositPayment', data: {
    agreed: true, acceptSupplyPolicy: true, supplyAddress: address
  } })
  assert.equal(result.ok, true, result.message)
  const deposit = fixture.db.state.staff_deposits[0]
  assert.equal(deposit.supplyFeeAmount, 120)
  assert.deepEqual(deposit.supplyAddress, address)
  return deposit._id
}

async function ship(fixture, id) {
  const result = await fixture.admin.main({ module: 'admin', action: 'shipStaffSupplies', data: {
    id, expressCompany: '顺丰速运', trackingNo: 'SF123456789'
  } })
  assert.equal(result.ok, true, result.message)
}

async function refund(fixture, id) {
  const requested = await fixture.staff.main({ module: 'staff', action: 'requestDepositRefund', data: { reason: '退出服务' } })
  assert.equal(requested.ok, true, requested.message)
  return fixture.admin.main({ module: 'admin', action: 'auditDepositRefund', data: { id, approved: true } })
}

test('unconfirmed existing deposit and accepted-but-unshipped deposit keep full refund', async () => {
  const f = setup()
  // Simulate an existing paid deposit under the old agreement.
  const legacy = { _id: 'legacy', staffOpenid: 'staff', staffUserId: 'u_staff', staffProfileId: 'profile',
    status: 'paid', paidAmount: 500, amount: 500, refundedAmount: 0, forfeitedAmount: 0, availableRefundAmount: 500 }
  f.db.state.staff_deposits.push(legacy)
  const status = await f.staff.main({ module: 'staff', action: 'getDepositStatus' })
  assert.equal(status.data.deposit.supplyPolicyAcceptedAt, undefined)
  const rejected = await f.admin.main({ module: 'admin', action: 'shipStaffSupplies', data: { id: 'legacy', expressCompany: '顺丰速运', trackingNo: 'SF123' } })
  assert.equal(rejected.ok, false)
  let audit = await refund(f, 'legacy')
  assert.equal(audit.ok, true, audit.message)
  assert.equal(audit.data.approvedRefundAmount, 500)

  const g = setup()
  const id = await paid(g)
  audit = await refund(g, id)
  assert.equal(audit.ok, true, audit.message)
  assert.equal(audit.data.approvedRefundAmount, 500)
  assert.equal(g.db.state.staff_deposits[0].supplyFeeDeductedAmount, 0)
})

test('existing paid staff must actively accept the fee before shipping, then sees the original fee snapshot', async () => {
  const f = setup()
  const old = { _id: 'old', staffOpenid: 'staff', staffUserId: 'u_staff', staffProfileId: 'profile',
    status: 'paid', paidAmount: 500, amount: 500, refundedAmount: 0, forfeitedAmount: 0, availableRefundAmount: 500 }
  f.db.state.staff_deposits.push(old)
  const declined = await f.staff.main({ module: 'staff', action: 'confirmSupplyDelivery', data: { supplyAddress: address } })
  assert.equal(declined.ok, false)
  const accepted = await f.staff.main({ module: 'staff', action: 'confirmSupplyDelivery', data: {
    acceptSupplyPolicy: true, supplyAddress: address
  } })
  assert.equal(accepted.ok, true, accepted.message)
  assert.equal(f.db.state.staff_deposits[0].supplyFeeAmount, 120)
  f.db.state.platform_configs[0].value.staffSupplies.supplyFeeAmount = 180
  await ship(f, 'old')
  assert.equal(f.db.state.staff_deposits[0].supplyFeeAmount, 120)
  const audit = await refund(f, 'old')
  assert.equal(audit.ok, true, audit.message)
  assert.equal(audit.data.approvedRefundAmount, 380)
})

test('shipped supplies are charged once at refund audit, separately from forfeit; auto refund cannot bypass', async () => {
  const f = setup()
  const id = await paid(f)
  await ship(f, id)
  const duplicate = await f.admin.main({ module: 'admin', action: 'shipStaffSupplies', data: { id, expressCompany: '顺丰速运', trackingNo: 'SF999' } })
  assert.equal(duplicate.ok, false)
  const tracking = await f.staff.main({ module: 'staff', action: 'querySupplyDeliveryLogistics', data: { depositId: id } })
  assert.equal(tracking.ok, true, tracking.message)
  assert.equal(tracking.data.trackingNo, 'SF123456789')
  const bypass = await f.admin.main({ module: 'admin', action: 'autoRefundStaffDeposit', data: { id } })
  assert.equal(bypass.ok, false)
  const audit = await refund(f, id)
  assert.equal(audit.ok, true, audit.message)
  assert.equal(audit.data.approvedRefundAmount, 380)
  assert.equal(f.db.state.staff_deposits[0].supplyFeeDeductedAmount, 120)
  assert.equal(f.db.state.staff_deposits[0].forfeitedAmount, 0)
  assert.equal(f.db.state.staff_deposit_events.filter(event => event.type === 'supply_fee').length, 1)
  const confirmed = await f.admin.main({ module: 'admin', action: 'confirmDepositRefund', data: {
    id, paymentConfirmed: true, paymentReference: 'refund-proof'
  } })
  assert.equal(confirmed.ok, true, confirmed.message)
  assert.equal(f.db.state.staff_deposits[0].refundedAmount, 380)
  assert.equal(f.db.state.staff_deposits[0].supplyFeeDeductedAmount, 120)
})

test('automatic refund after fee audit uses the net amount and never charges a second time', async () => {
  const f = setup()
  const id = await paid(f)
  await ship(f, id)
  const audit = await refund(f, id)
  assert.equal(audit.ok, true, audit.message)
  const paidBack = await f.admin.main({ module: 'admin', action: 'autoRefundStaffDeposit', data: { id } })
  assert.equal(paidBack.ok, true, paidBack.message)
  assert.equal(paidBack.data.refundAmount, 380)
  const deposit = f.db.state.staff_deposits[0]
  assert.equal(deposit.refundedAmount, 380)
  assert.equal(deposit.supplyFeeDeductedAmount, 120)
  assert.equal(f.db.state.refunds[0].refundAmount, 380)
})

test('pending supply waiver blocks deposit settlement; approved waiver avoids fee and separate payout', async () => {
  const f = setup()
  const id = await paid(f)
  await ship(f, id)
  // A later settings change must not erase the qualification promised at consent.
  const config = f.db.state.platform_configs[0].value.staffSupplies
  config.shippingEnabled = false
  config.reimbursementEnabled = false
  config.reimbursementOrderCount = 50
  const eligibility = await f.staff.main({ module: 'staff', action: 'getSupplyReimbursementStatus' })
  assert.equal(eligibility.data.canApply, true)
  assert.equal(eligibility.data.deliveryMode, true)
  const withoutConsent = await f.staff.main({ module: 'staff', action: 'submitSupplyReimbursement', data: { remark: '申请减免' } })
  assert.equal(withoutConsent.ok, false)
  assert.match(withoutConsent.message, /勾选/)
  const submit = await f.staff.main({ module: 'staff', action: 'submitSupplyReimbursement', data: { remark: '申请减免', rulesConfirmed: true } })
  assert.equal(submit.ok, true, submit.message)
  assert.equal(submit.data.benefitType, 'supply_fee_waiver')
  assert.ok(submit.data.rulesConfirmedAt)
  const pending = await refund(f, id)
  assert.equal(pending.ok, false)
  assert.match(pending.message, /正在审核/)
  const approve = await f.admin.main({ module: 'admin', action: 'auditSupplyReimbursement', data: { id: submit.data._id, approved: true } })
  assert.equal(approve.ok, true, approve.message)
  const pay = await f.admin.main({ module: 'admin', action: 'paySupplyReimbursement', data: { id: submit.data._id, paymentConfirmed: true, paymentReference: 'proof' } })
  assert.equal(pay.ok, false)
  const audit = await f.admin.main({ module: 'admin', action: 'auditDepositRefund', data: { id, approved: true } })
  assert.equal(audit.ok, true, audit.message)
  assert.equal(audit.data.approvedRefundAmount, 500)
  assert.equal(f.db.state.staff_deposits[0].supplyFeeDeductedAmount, 0)
})

test('the server rejects enabling supply shipping with an invalid fee, including direct admin configuration calls', async () => {
  const f = setup()
  const original = f.db.state.platform_configs[0].value
  for (const supplyFeeAmount of [0, 500, 600]) {
    const result = await f.admin.main({ module: 'admin', action: 'saveSystemSettings', data: { settings: {
      ...original, staffSupplies: { ...original.staffSupplies, supplyFeeAmount }
    } } })
    assert.equal(result.ok, false, `fee ${supplyFeeAmount} must be rejected`)
    assert.match(result.message, /用品费用/)
    assert.equal(f.db.state.platform_configs[0].value.staffSupplies.supplyFeeAmount, 120)
  }
})

test('both configured reimbursement paths remain available under the consent snapshot', async () => {
  const f = setup()
  const config = f.db.state.platform_configs[0].value.staffSupplies
  config.reimbursementMode = 'either'
  config.reimbursementOrderCount = 3
  config.reimbursementInviteCount = 2
  const id = await paid(f)
  await ship(f, id)
  config.reimbursementMode = 'order_count'
  config.reimbursementOrderCount = 50
  const depositStatus = await f.staff.main({ module: 'staff', action: 'getDepositStatus' })
  assert.equal(depositStatus.ok, true, depositStatus.message)
  assert.equal(depositStatus.data.supplyQualification.mode, 'either')
  assert.deepEqual(depositStatus.data.supplyQualification.conditions.map(item => item.requiredCount), [3, 2])
  f.db.state.user_invites.push(
    { _id: 'invite_1', inviterOpenid: 'staff', eligibleForSupplyReimbursement: true },
    { _id: 'invite_2', inviterOpenid: 'staff', eligibleForSupplyReimbursement: true }
  )
  const eligibility = await f.staff.main({ module: 'staff', action: 'getSupplyReimbursementStatus' })
  assert.equal(eligibility.ok, true, eligibility.message)
  assert.equal(eligibility.data.qualification.mode, 'either')
  assert.deepEqual(eligibility.data.qualification.conditions.map(item => item.met), [false, true])
  assert.equal(eligibility.data.canApply, true)
})

test('admin refund preview shows full refund before shipment and net refund when supplies are shipped', async () => {
  const f = setup()
  const id = await paid(f)
  const preview = () => f.admin.main({ module: 'admin', action: 'getStaffDepositRefundPreview', data: { id } })
  let result = await preview()
  assert.equal(result.ok, true, result.message)
  assert.equal(result.data.estimatedRefundAmount, 500)
  assert.equal(result.data.reimbursementStatus, 'not_shipped')
  await ship(f, id)
  result = await preview()
  assert.equal(result.data.availableRefundAmount, 500)
  assert.equal(result.data.supplyFeeDue, 120)
  assert.equal(result.data.estimatedRefundAmount, 380)
  assert.equal(f.db.state.staff_deposits[0].availableRefundAmount, 500, 'preview must leave the ledger unchanged')
  await refund(f, id)
  result = await preview()
  assert.equal(result.data.supplyFeeDue, 0)
  assert.equal(result.data.supplyFeeDeductedAmount, 120)
  assert.equal(result.data.estimatedRefundAmount, 380)
})

test('admin preview waits for a pending waiver and uses the matching approved application', async () => {
  const f = setup()
  const id = await paid(f)
  await ship(f, id)
  // Isolated synthetic records describe this staff member's reimbursement history.
  f.db.state.staff_supply_reimbursements.push(
    { _id: 'older_1', staffOpenid: 'staff', depositId: 'older', benefitType: 'supply_fee_waiver', status: 'rejected' },
    { _id: 'older_2', staffOpenid: 'staff', depositId: 'older_2', benefitType: 'supply_fee_waiver', status: 'approved' },
    { _id: 'current', staffOpenid: 'staff', depositId: id, benefitType: 'supply_fee_waiver', status: 'pending' }
  )
  const preview = () => f.admin.main({ module: 'admin', action: 'getStaffDepositRefundPreview', data: { id } })
  let result = await preview()
  assert.equal(result.data.blocked, true)
  assert.equal(result.data.estimatedRefundAmount, null)
  const request = await f.admin.main({ module: 'admin', action: 'requestStaffDepositRefund', data: { id, reason: '退出服务' } })
  assert.equal(request.ok, false)
  f.db.state.staff_supply_reimbursements.at(-1).status = 'approved'
  result = await preview()
  assert.equal(result.data.blocked, false)
  assert.equal(result.data.reimbursementCompleted, true)
  assert.equal(result.data.supplyFeeDue, 0)
  assert.equal(result.data.estimatedRefundAmount, 500)
  const audit = await refund(f, id)
  assert.equal(audit.data.approvedRefundAmount, 500)
})

test('checkout requests an updated agreement when supply fees or reimbursement conditions change', async () => {
  const f = setup()
  const initial = await f.staff.main({ module: 'staff', action: 'getDepositStatus' })
  assert.equal(initial.ok, true, initial.message)
  const checkoutPolicyKey = initial.data.checkoutPolicyKey
  assert.ok(checkoutPolicyKey)
  f.db.state.platform_configs[0].value.staffSupplies.reimbursementOrderCount = 5
  const result = await f.staff.main({ module: 'staff', action: 'createDepositPayment', data: {
    agreed: true, acceptSupplyPolicy: true, supplyAddress: address, checkoutPolicyKey
  } })
  assert.equal(result.ok, false)
  assert.match(result.message, /规则已更新/)
  assert.equal(f.db.state.staff_deposits.length, 0)
  const updated = await f.staff.main({ module: 'staff', action: 'getDepositStatus' })
  const payment = await f.staff.main({ module: 'staff', action: 'createDepositPayment', data: {
    agreed: true, acceptSupplyPolicy: true, supplyAddress: address, checkoutPolicyKey: updated.data.checkoutPolicyKey
  } })
  assert.equal(payment.ok, true, payment.message)
})

test('refund preview marks an already requested deposit as unavailable for another request', async () => {
  const f = setup()
  const id = await paid(f)
  const request = await f.admin.main({ module: 'admin', action: 'requestStaffDepositRefund', data: { id, reason: '退出服务' } })
  assert.equal(request.ok, true, request.message)
  const result = await f.admin.main({ module: 'admin', action: 'getStaffDepositRefundPreview', data: { id } })
  assert.equal(result.data.canRequestRefund, false)
  assert.equal(result.data.status, 'refund_requested')
})
