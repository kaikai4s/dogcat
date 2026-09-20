const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

function createTestDb(overrides = {}) {
  return createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', nickname: '管理员', roles: ['admin'], status: 'active' },
      { _id: 'u_staff', openid: 'openid_staff', nickname: '宠托师小李', phone: '13900001111', roles: ['client', 'staff'], status: 'active' },
      { _id: 'u_client', openid: 'openid_client', nickname: '客户小王', phone: '13800002222', roles: ['client'], status: 'active' }
    ],
    staff_profiles: [
      {
        _id: 'sp_1',
        openid: 'openid_staff',
        realName: '李小宠',
        phone: '13900001111',
        auditStatus: 'approved',
        staffLevel: 'intern',
        serviceCity: '上海',
        serviceAddress: '服务中心',
        serviceLatitude: 31.2,
        serviceLongitude: 121.5,
        depositStatus: 'unpaid',
        exitStatus: 'none'
      }
    ],
    staff_deposits: [],
    staff_deposit_events: [],
    staff_supply_reimbursements: [],
    finance_logs: [],
    admin_operation_logs: [],
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
            forfeitRulesText: '私单、虚假打卡等行为将按规定扣除或没收保证金'
          },
          staffSupplies: {
            reimbursementEnabled: true,
            requiredItems: ['一次性手套', '一次性口罩', '安全宠物消毒用品'],
            auditNotice: '严审提示：备齐物资不代表必然通过考核',
            serviceReminder: '服务前请自备并携带必备用品，并进行隔离病菌拍照打卡'
          },
          payment: { mode: 'mock' }
        }
      }
    ],
    orders: [],
    checkin_logs: [],
    order_timeline: [],
    ...overrides
  })
}

test('staff deposit: status, payment agreement requirement, pay, refund request and admin audit', async () => {
  const db = createTestDb()
  const staffFn = loadCloudFunction('api', db, 'openid_staff')
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 1. Get deposit status
  const statusBefore = await staffFn.main({ module: 'staff', action: 'getDepositStatus' })
  assert.equal(statusBefore.ok, true)
  assert.equal(statusBefore.data.canPay, true)
  assert.equal(statusBefore.data.config.amount, 500)
  assert.equal(statusBefore.data.deposit, null)

  // 2. Pay deposit without agreement should fail
  const payWithoutAgree = await staffFn.main({ module: 'staff', action: 'createDepositPayment', data: { agreed: false } })
  assert.equal(payWithoutAgree.ok, false)
  assert.match(payWithoutAgree.message, /阅读并同意/)

  // 3. Pay deposit with agreement should succeed (in mock mode)
  const payResult = await staffFn.main({ module: 'staff', action: 'createDepositPayment', data: { agreed: true } })
  assert.equal(payResult.ok, true)
  assert.equal(payResult.data.paid, true)

  const statusAfterPay = await staffFn.main({ module: 'staff', action: 'getDepositStatus' })
  assert.equal(statusAfterPay.data.deposit.status, 'paid')
  assert.equal(statusAfterPay.data.deposit.paidAmount, 500)
  assert.equal(statusAfterPay.data.deposit.availableRefundAmount, 500)
  assert.equal(statusAfterPay.data.canRequestRefund, true)

  // 4. Request refund (exit)
  const refundReq = await staffFn.main({ module: 'staff', action: 'requestDepositRefund', data: { reason: '自愿退出宠托师业务' } })
  assert.equal(refundReq.ok, true)
  assert.equal(refundReq.data.status, 'refund_requested')

  // 5. Admin lists deposits and audits refund
  const adminDeposits = await adminFn.main({ module: 'admin', action: 'listStaffDeposits', data: {} })
  assert.equal(adminDeposits.ok, true)
  assert.equal(adminDeposits.data.length, 1)
  assert.equal(adminDeposits.data[0].refundStatus, 'requested')

  const auditResult = await adminFn.main({ module: 'admin', action: 'auditDepositRefund', data: { id: adminDeposits.data[0]._id, approved: true, reason: '确认退出全额退还' } })
  assert.equal(auditResult.ok, true)
  assert.equal(auditResult.data.status, 'refunded')

  const statusAfterRefund = await staffFn.main({ module: 'staff', action: 'getDepositStatus' })
  assert.equal(statusAfterRefund.data.deposit.status, 'refunded')
  assert.equal(statusAfterRefund.data.deposit.availableRefundAmount, 0)
  assert.equal(statusAfterRefund.data.deposit.refundedAmount, 500)
})

test('staff deposit: admin forfeit deposit for non-compliant violations', async () => {
  const db = createTestDb()
  const staffFn = loadCloudFunction('api', db, 'openid_staff')
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // Sitter pays deposit
  await staffFn.main({ module: 'staff', action: 'createDepositPayment', data: { agreed: true } })

  const adminDeposits = await adminFn.main({ module: 'admin', action: 'listStaffDeposits', data: {} })
  const depositId = adminDeposits.data[0]._id

  // Forfeit without reason should fail
  const forfeitNoReason = await adminFn.main({ module: 'admin', action: 'forfeitStaffDeposit', data: { id: depositId, amount: 200, reason: '' } })
  assert.equal(forfeitNoReason.ok, false)

  // Forfeit exceeding balance should fail
  const forfeitExceed = await adminFn.main({ module: 'admin', action: 'forfeitStaffDeposit', data: { id: depositId, amount: 600, reason: '私单' } })
  assert.equal(forfeitExceed.ok, false)

  // Forfeit 200 for private order violation
  const forfeitResult = await adminFn.main({ module: 'admin', action: 'forfeitStaffDeposit', data: { id: depositId, amount: 200, reason: '发现存在私下交易违规行为，依规没收部分保证金' } })
  assert.equal(forfeitResult.ok, true)
  assert.equal(forfeitResult.data.availableRefundAmount, 300)

  const status = await staffFn.main({ module: 'staff', action: 'getDepositStatus' })
  assert.equal(status.data.deposit.forfeitedAmount, 200)
  assert.equal(status.data.deposit.availableRefundAmount, 300)
})

test('staff supplies reimbursement: intern rejected, certified accepted once only, admin audit and pay', async () => {
  const db = createTestDb()
  const staffFn = loadCloudFunction('api', db, 'openid_staff')
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 1. Intern sitter applies -> must be rejected
  const internStatus = await staffFn.main({ module: 'staff', action: 'getSupplyReimbursementStatus' })
  assert.equal(internStatus.data.canApply, false)

  const internSubmit = await staffFn.main({ module: 'staff', action: 'submitSupplyReimbursement', data: { mediaFileIds: ['cloud://receipt1.jpg'], amount: 98.5, remark: '购买手套、口罩、消毒液' } })
  assert.equal(internSubmit.ok, false)
  assert.match(internSubmit.message, /正式认证/)

  // 2. Upgrade sitter to certified
  db.state.staff_profiles[0].staffLevel = 'certified'

  const certifiedStatus = await staffFn.main({ module: 'staff', action: 'getSupplyReimbursementStatus' })
  assert.equal(certifiedStatus.data.canApply, true)

  // 3. Submit first-time reimbursement
  const submitResult = await staffFn.main({ module: 'staff', action: 'submitSupplyReimbursement', data: { mediaFileIds: ['cloud://receipt1.jpg'], amount: 98.5, remark: '购买防护用品' } })
  assert.equal(submitResult.ok, true)
  assert.equal(submitResult.data.status, 'pending')
  assert.equal(submitResult.data.amount, 98.5)

  // 4. Sitter tries to apply a second time -> blocked (only once per person)
  const submitAgain = await staffFn.main({ module: 'staff', action: 'submitSupplyReimbursement', data: { mediaFileIds: ['cloud://receipt2.jpg'], amount: 50 } })
  assert.equal(submitAgain.ok, false)
  assert.match(submitAgain.message, /仅限申请一次/)

  // 5. Admin audits and pays reimbursement
  const adminList = await adminFn.main({ module: 'admin', action: 'listSupplyReimbursements', data: {} })
  assert.equal(adminList.ok, true)
  assert.equal(adminList.data.length, 1)

  const auditRes = await adminFn.main({ module: 'admin', action: 'auditSupplyReimbursement', data: { id: adminList.data[0]._id, approved: true, approvedAmount: 98.5 } })
  assert.equal(auditRes.ok, true)
  assert.equal(auditRes.data.status, 'approved')

  const payRes = await adminFn.main({ module: 'admin', action: 'paySupplyReimbursement', data: { id: adminList.data[0]._id } })
  assert.equal(payRes.ok, true)
  assert.equal(payRes.data.status, 'paid')

  // Check finance log
  assert.equal(db.state.finance_logs.some((l) => l.action === 'supply_reimbursement_paid' && l.amountDelta === -98.5), true)
})

test('pre-service checkin: sanitization photo required before startService', async () => {
  const db = createTestDb({
    staff_profiles: [
      {
        _id: 'sp_1',
        openid: 'openid_staff',
        realName: '李小宠',
        phone: '13900001111',
        auditStatus: 'approved',
        staffLevel: 'intern',
        serviceCity: '上海',
        serviceAddress: '服务中心',
        serviceLatitude: 31.2,
        serviceLongitude: 121.5,
        depositStatus: 'paid',
        exitStatus: 'none'
      }
    ],
    pets: [{ _id: 'p1', openid: 'openid_client', name: '大黄', weight: 12 }],
    service_prices: [{ _id: 'sp_feed', key: 'feed', label: '上门喂养', price: 60, enabled: true }]
  })
  const clientFn = loadCloudFunction('api', db, 'openid_client')
  const staffFn = loadCloudFunction('api', db, 'openid_staff')

  // Client creates order
  const orderRes = await clientFn.main({
    module: 'order',
    action: 'createOrder',
    data: {
      petId: 'p1',
      serviceTypes: ['visit_fee', 'feed'],
      serviceAddress: '幸福小区',
      addressDetail: '2号楼',
      doorplate: '202',
      startTime: '2099-08-01 10:00',
      endTime: '2099-08-01 11:00',
      durationMinutes: 60
    }
  })
  const orderId = orderRes.data._id
  await clientFn.main({ module: 'payment', action: 'mockPayOrder', data: { orderId } })
  await staffFn.main({ module: 'staff', action: 'acceptOrder', data: { orderId } })
  await staffFn.main({ module: 'order', action: 'requestEarlyStart', data: { orderId, reason: '提前准备' } })
  await clientFn.main({ module: 'order', action: 'approveEarlyStart', data: { orderId } })

  // Trying to start service without sanitization checkin must fail
  const startWithoutSanitization = await staffFn.main({ module: 'order', action: 'startService', data: { id: orderId } })
  assert.equal(startWithoutSanitization.ok, false)
  assert.match(startWithoutSanitization.message, /消毒拍照打卡/)

  // Perform pre-service sanitization checkin
  const checkinRes = await staffFn.main({
    module: 'checkin',
    action: 'createCheckin',
    data: {
      orderId,
      eventType: 'sanitization',
      mediaFileId: 'cloud://test-env/checkins/sanitization_pic.jpg',
      latitude: 31.2,
      longitude: 121.5,
      remark: '已佩戴口罩手套并完成消毒准备'
    }
  })
  assert.equal(checkinRes.ok, true)

  // Now startService must succeed
  const startWithSanitization = await staffFn.main({ module: 'order', action: 'startService', data: { id: orderId } })
  assert.equal(startWithSanitization.ok, true)

  // Deleting sanitization checkin photo must be blocked to preserve evidence
  const deleteSanitizationRes = await staffFn.main({
    module: 'checkin',
    action: 'deleteCheckin',
    data: {
      orderId,
      checkinId: checkinRes.data._id
    }
  })
  assert.equal(deleteSanitizationRes.ok, false)
  assert.match(deleteSanitizationRes.message, /消毒凭证不可删除/)
})

test('staff deposit: refund blocked by unresolved incidents and active orders', async () => {
  const db = createTestDb({
    staff_deposits: [
      {
        _id: 'dep_1',
        staffOpenid: 'openid_staff',
        staffUserId: 'u_staff',
        amount: 500,
        paidAmount: 500,
        refundedAmount: 0,
        forfeitedAmount: 0,
        availableRefundAmount: 500,
        status: 'paid',
        statusText: '已缴纳',
        refundStatus: '',
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ],
    order_incidents: [
      {
        _id: 'inc_1',
        orderId: 'o_active_1',
        staffOpenid: 'openid_staff',
        clientOpenid: 'openid_client',
        type: 'complaint',
        status: 'open',
        title: '宠物安全纠纷',
        createdAt: new Date()
      }
    ]
  })
  const staffFn = loadCloudFunction('api', db, 'openid_staff')
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // Request refund while incident is open should fail
  const refundReqWithIncident = await staffFn.main({
    module: 'staff',
    action: 'requestDepositRefund',
    data: { reason: '退出并退还保证金' }
  })
  assert.equal(refundReqWithIncident.ok, false)
  assert.match(refundReqWithIncident.message, /客诉或纠纷/)

  // Close the incident
  db.state.order_incidents[0].status = 'closed'

  // Now refund request should succeed
  const refundReqSuccess = await staffFn.main({
    module: 'staff',
    action: 'requestDepositRefund',
    data: { reason: '纠纷已解决，自愿退出' }
  })
  assert.equal(refundReqSuccess.ok, true)

  // If another incident opens before admin audits, admin audit should also block approval
  db.state.order_incidents.push({
    _id: 'inc_2',
    orderId: 'o_active_2',
    staffOpenid: 'openid_staff',
    clientOpenid: 'openid_client',
    type: 'penalty',
    status: 'investigating',
    createdAt: new Date()
  })

  const adminApproveWithOpenIncident = await adminFn.main({
    module: 'admin',
    action: 'auditDepositRefund',
    data: { id: 'dep_1', approved: true }
  })
  assert.equal(adminApproveWithOpenIncident.ok, false)
  assert.match(adminApproveWithOpenIncident.message, /纠纷/)
})

test('staff supplies: reimbursement amount capped and admin cannot approve more than claimed', async () => {
  const db = createTestDb()
  db.state.staff_profiles[0].staffLevel = 'certified'
  const staffFn = loadCloudFunction('api', db, 'openid_staff')
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // Submit reimbursement exceeding max cap (default 200) should fail
  const overCapRes = await staffFn.main({
    module: 'staff',
    action: 'submitSupplyReimbursement',
    data: {
      mediaFileIds: ['cloud://receipt.jpg'],
      amount: 500,
      remark: '购买高级用品'
    }
  })
  assert.equal(overCapRes.ok, false)
  assert.match(overCapRes.message, /上限/)

  // Submit valid reimbursement within cap
  const validRes = await staffFn.main({
    module: 'staff',
    action: 'submitSupplyReimbursement',
    data: {
      mediaFileIds: ['cloud://receipt.jpg'],
      amount: 120,
      remark: '自购手套口罩消毒液'
    }
  })
  assert.equal(validRes.ok, true)

  // Admin tries to approve more than the claimed amount (120) should fail
  const overApproveRes = await adminFn.main({
    module: 'admin',
    action: 'auditSupplyReimbursement',
    data: {
      id: validRes.data._id,
      approved: true,
      approvedAmount: 150
    }
  })
  assert.equal(overApproveRes.ok, false)
  assert.match(overApproveRes.message, /不能大于宠托师申请金额/)
})

test('staff deposit: unpaid deposit strictly blocks grab order, direct order, client selection and admin assignment; paying deposit restores order eligibility', async () => {
  const db = createTestDb({
    pets: [{ _id: 'p1', openid: 'openid_client', name: '咪咪', weight: 4 }],
    service_prices: [{ _id: 'sp_feed', key: 'feed', label: '上门喂养', price: 60, enabled: true }]
  })
  const clientFn = loadCloudFunction('api', db, 'openid_client')
  const staffFn = loadCloudFunction('api', db, 'openid_staff')
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 1. Staff profile reflects deposit unpaid notice and inability to take orders
  const profileRes = await staffFn.main({ module: 'staff', action: 'getStaffProfile' })
  assert.equal(profileRes.ok, true)
  assert.equal(profileRes.data.canTakeOrders, false)
  assert.equal(profileRes.data.cannotTakeOrderReason, 'deposit_unpaid')
  assert.equal(profileRes.data.depositNotice?.needDeposit, true)
  assert.equal(profileRes.data.depositNotice?.amount, 500)

  // 2. Client sitter list filters out unpaid sitter
  const sittersRes = await clientFn.main({ module: 'staff', action: 'listApprovedSitters', data: {} })
  assert.equal(sittersRes.ok, true)
  assert.equal(sittersRes.data.list.some((s) => s._id === 'sp_1'), false)

  // 3. Client trying to create direct order specifying this unpaid sitter is rejected
  const directOrderAttempt = await clientFn.main({
    module: 'order',
    action: 'createOrder',
    data: {
      publishMode: 'direct',
      requestedStaffProfileId: 'sp_1',
      petId: 'p1',
      serviceTypes: ['visit_fee', 'feed'],
      serviceAddress: '幸福小区',
      addressDetail: '1号楼',
      doorplate: '101',
      startTime: '2099-08-01 10:00',
      endTime: '2099-08-01 11:00',
      durationMinutes: 60
    }
  })
  assert.equal(directOrderAttempt.ok, false)
  assert.match(directOrderAttempt.message, /未缴纳履约保证金/)

  // 4. Create an open order for test
  const openOrderRes = await clientFn.main({
    module: 'order',
    action: 'createOrder',
    data: {
      petId: 'p1',
      serviceTypes: ['visit_fee', 'feed'],
      serviceAddress: '幸福小区',
      addressDetail: '1号楼',
      doorplate: '101',
      startTime: '2099-08-01 10:00',
      endTime: '2099-08-01 11:00',
      durationMinutes: 60
    }
  })
  assert.equal(openOrderRes.ok, true)
  const orderId = openOrderRes.data._id
  await clientFn.main({ module: 'payment', action: 'mockPayOrder', data: { orderId } })

  // 5. Unpaid staff cannot view nearby orders or grab order
  const nearbyRes = await staffFn.main({ module: 'staff', action: 'listNearbyOrders', data: {} })
  assert.equal(nearbyRes.ok, false)
  assert.match(nearbyRes.message, /未缴纳宠托师履约保证金/)

  const grabRes = await staffFn.main({ module: 'staff', action: 'acceptOrder', data: { orderId } })
  assert.equal(grabRes.ok, false)
  assert.match(grabRes.message, /未缴纳宠托师履约保证金/)

  // 6. Admin cannot assign order to unpaid staff
  const assignRes = await adminFn.main({ module: 'admin', action: 'assignOrder', data: { orderId, staffProfileId: 'sp_1' } })
  assert.equal(assignRes.ok, false)
  assert.match(assignRes.message, /尚未缴纳履约保证金/)

  // 7. Staff pays deposit
  const payRes = await staffFn.main({ module: 'staff', action: 'createDepositPayment', data: { agreed: true } })
  assert.equal(payRes.ok, true)
  assert.equal(payRes.data.paid, true)

  // 8. Staff profile restored
  const profileAfter = await staffFn.main({ module: 'staff', action: 'getStaffProfile' })
  assert.equal(profileAfter.ok, true)
  assert.equal(profileAfter.data.canTakeOrders, true)
  assert.equal(profileAfter.data.depositNotice, null)

  // 9. Staff can now grab the order
  const grabAfter = await staffFn.main({ module: 'staff', action: 'acceptOrder', data: { orderId } })
  assert.equal(grabAfter.ok, true)
  assert.equal(grabAfter.data.status, 'assigned')
})

