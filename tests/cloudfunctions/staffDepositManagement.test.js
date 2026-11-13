const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const reapplicationData = {
  gender: 'male', realName: '张出险', phone: '13900002222', serviceCity: '上海', serviceAreas: '徐汇区', serviceAddress: '测试服务地址',
  serviceLatitude: 31.2, serviceLongitude: 121.5, idCardFrontFileId: 'cloud://id-front.png', idCardBackFileId: 'cloud://id-back.png', facePhotoFileId: 'cloud://face.png'
}

test('reapplication with a zero platform standard does not retain old repayment or exit restrictions', async () => {
  const db = createTestDb()
  const profile = db.state.staff_profiles[1]
  Object.assign(profile, { auditStatus: 'revoked', exitStatus: 'exited', depositStatus: 'refunded', depositRequired: true,
    requireDepositRepay: true, depositStandardAmount: 99, depositEntryStandardAmount: 99, exitRefundPaid: true })
  Object.assign(db.state.staff_deposits.find(row => row._id === 'dep_2'), { status: 'refunded', refundStatus: 'success', availableRefundAmount: 0, refundedAmount: 50 })
  db.state.users.find(row => row.openid === profile.openid).roles = ['client']
  db.state.platform_configs[0].value.staffDeposit = { enabled: false, amount: 0 }
  const staff = loadCloudFunction('api', db, profile.openid)
  const result = await staff.main({ module: 'staff', action: 'submitStaffProfile', data: reapplicationData })
  assert.equal(result.ok, true, result.message)
  const current = db.state.staff_profiles.find(row => row._id === profile._id)
  assert.equal(current.depositStandardAmount, 0)
  assert.equal(current.requireDepositRepay, false)
  assert.equal(current.depositRequired, false)
  assert.equal(current.exitStatus, 'none')
  // Represent completion of the new application and training cycle.
  Object.assign(current, { auditStatus: 'approved', staffLevel: 'intern' })
  const state = await staff.main({ module: 'staff', action: 'getStaffProfile' })
  assert.equal(state.ok, true, state.message)
  assert.equal(state.data.canTakeOrders, true)
  assert.equal(state.data.depositNotice, null)
})

test('reapplication cannot erase a prior deposit balance or unfinished exit', async () => {
  for (const unfinished of ['balance', 'refund', 'exit', 'payment']) {
    const db = createTestDb()
    const profile = db.state.staff_profiles[1]
    Object.assign(profile, { auditStatus: 'revoked', exitStatus: unfinished === 'exit' ? 'approved' : 'exited', depositStandardAmount: 99 })
    const deposit = db.state.staff_deposits.find(row => row._id === 'dep_2')
    if (unfinished === 'refund') Object.assign(deposit, { status: 'refunding', refundStatus: 'processing' })
    if (unfinished === 'exit') Object.assign(deposit, { status: 'refunded', availableRefundAmount: 0 })
    if (unfinished === 'payment') Object.assign(deposit, { status: 'unpaid', paidAmount: 0, availableRefundAmount: 0 })
    db.state.users.find(row => row.openid === profile.openid).roles = ['client']
    db.state.platform_configs[0].value.staffDeposit = { enabled: false, amount: 0 }
    const result = await loadCloudFunction('api', db, profile.openid).main({ module: 'staff', action: 'submitStaffProfile', data: reapplicationData })
    assert.equal(result.ok, false, unfinished)
    assert.match(result.message, /尚未结清/)
    const current = db.state.staff_profiles.find(row => row._id === profile._id)
    assert.equal(current.auditStatus, 'revoked')
    assert.equal(current.depositStandardAmount, 99)
  }
})

test('admin balance filtering includes every page of deposit records', async () => {
  const db = createTestDb()
  db.state.staff_deposits = Array.from({ length: 125 }, (_, index) => ({
    _id: `balance_${String(index).padStart(3, '0')}`, staffOpenid: 'openid_staff_1', staffProfileId: 'sp_1', staffUserId: 'u_staff_1',
    status: 'paid', amount: 1, paidAmount: 1, availableRefundAmount: 1, refundedAmount: 0, forfeitedAmount: 0
  }))
  const collection = db.collection.bind(db)
  db.collection = name => {
    const query = collection(name)
    const get = query.get.bind(query)
    if (name === 'staff_deposits') query.get = async () => {
      if (query._limit == null) query.limit(100)
      return get()
    }
    return query
  }
  const api = loadCloudFunction('api', db, 'openid_admin')
  const plain = await api.main({ module: 'admin', action: 'listStaffProfiles', data: {} })
  assert.equal(plain.ok, true, plain.message)
  assert.equal(plain.data.list.find(row => row._id === 'sp_1').depositBalance, 125)
  const filtered = await api.main({ module: 'admin', action: 'listStaffProfiles', data: { minDeposit: 120, maxDeposit: 130 } })
  assert.equal(filtered.ok, true, filtered.message)
  assert.deepEqual(filtered.data.list.map(row => row._id), ['sp_1'])
})

test('admin balance query failure does not turn a funded sitter into a zero balance', async () => {
  const db = createTestDb()
  const collection = db.collection.bind(db)
  db.collection = name => {
    const query = collection(name)
    if (name === 'staff_deposits') query.get = async () => { throw new Error('deposit ledger unavailable') }
    return query
  }
  const result = await loadCloudFunction('api', db, 'openid_admin').main({ module: 'admin', action: 'listStaffProfiles', data: { maxDeposit: 0 } })
  assert.equal(result.ok, false)
  assert.match(result.message, /deposit ledger unavailable/)
})

function createTestDb(overrides = {}) {
  return createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', nickname: '管理员', roles: ['admin'], status: 'active' },
      { _id: 'u_staff_1', openid: 'openid_staff_1', nickname: '托师小李', phone: '13900001111', roles: ['client', 'staff'], status: 'active' },
      { _id: 'u_staff_2', openid: 'openid_staff_2', nickname: '托师小张', phone: '13900002222', roles: ['client', 'staff'], status: 'active' },
      { _id: 'u_staff_3', openid: 'openid_staff_3', nickname: '托师小赵', phone: '13900003333', roles: ['client', 'staff'], status: 'active' },
      { _id: 'u_client', openid: 'openid_client', nickname: '客户王先生', phone: '13800001234', roles: ['client'], status: 'active' }
    ],
    staff_profiles: [
      {
        _id: 'sp_1',
        openid: 'openid_staff_1',
        realName: '李小宠',
        phone: '13900001111',
        auditStatus: 'approved',
        staffLevel: 'intern',
        serviceCity: '上海',
        serviceAddress: '浦东新区',
        serviceLatitude: 31.2,
        serviceLongitude: 121.5,
        depositStatus: 'paid',
        exitStatus: 'none',
        requireDepositRepay: false
      },
      {
        _id: 'sp_2',
        openid: 'openid_staff_2',
        realName: '张出险',
        phone: '13900002222',
        auditStatus: 'approved',
        staffLevel: 'intern',
        serviceCity: '上海',
        serviceAddress: '徐汇区',
        serviceLatitude: 31.2,
        serviceLongitude: 121.5,
        depositStatus: 'paid',
        exitStatus: 'none',
        requireDepositRepay: false
      },
      {
        _id: 'sp_3',
        openid: 'openid_staff_3',
        realName: '赵合规',
        phone: '13900003333',
        auditStatus: 'approved',
        staffLevel: 'intern',
        serviceCity: '上海',
        serviceAddress: '静安区',
        serviceLatitude: 31.2,
        serviceLongitude: 121.5,
        depositStatus: 'paid',
        exitStatus: 'none',
        requireDepositRepay: false
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
        statusText: '已缴纳',
        createdAt: new Date('2026-09-01T10:00:00Z')
      },
      {
        _id: 'dep_2',
        staffOpenid: 'openid_staff_2',
        staffUserId: 'u_staff_2',
        staffProfileId: 'sp_2',
        amount: 500,
        paidAmount: 500,
        refundedAmount: 0,
        forfeitedAmount: 450,
        availableRefundAmount: 50, // 仅剩50元
        status: 'paid',
        statusText: '部分没收（余¥50）',
        createdAt: new Date('2026-09-01T11:00:00Z')
      },
      {
        _id: 'dep_3',
        staffOpenid: 'openid_staff_3',
        staffUserId: 'u_staff_3',
        staffProfileId: 'sp_3',
        amount: 500,
        paidAmount: 500,
        refundedAmount: 0,
        forfeitedAmount: 0,
        availableRefundAmount: 500,
        status: 'paid',
        statusText: '已缴纳',
        createdAt: new Date('2026-09-01T12:00:00Z')
      }
    ],
    staff_deposit_events: [
      {
        _id: 'ev_1_pay',
        depositId: 'dep_1',
        staffOpenid: 'openid_staff_1',
        type: 'pay',
        amount: 500,
        reason: '缴纳宠托师入驻保证金',
        createdAt: new Date('2026-09-01T10:05:00Z')
      },
      {
        _id: 'ev_2_pay',
        depositId: 'dep_2',
        staffOpenid: 'openid_staff_2',
        type: 'pay',
        amount: 500,
        reason: '缴纳宠托师入驻保证金',
        createdAt: new Date('2026-09-01T11:05:00Z')
      },
      {
        _id: 'ev_2_forfeit_1',
        depositId: 'dep_2',
        staffOpenid: 'openid_staff_2',
        type: 'forfeit',
        amount: 450,
        reason: '订单严重迟到导致违约改派，扣除保证金450元',
        createdAt: new Date('2026-09-10T15:00:00Z')
      }
    ],
    staff_deposit_evidences: [
      {
        _id: 'evid_2',
        orderId: 'ord_problem_2',
        orderNo: 'O20260910001',
        serviceSummary: '上门遛狗',
        staffOpenid: 'openid_staff_2',
        reasonType: 'start_overdue',
        reasonTypeName: '超时未开始',
        reasonText: '严重迟到40分钟',
        deductAmount: 450,
        status: 'forfeited',
        createdAt: new Date('2026-09-10T14:30:00Z')
      }
    ],
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
            rulesText: '资料审核通过后缴纳保证金',
            refundRulesText: '退出全额退还',
            forfeitRulesText: '违规将扣除保证金'
          },
          payment: { mode: 'mock' }
        }
      }
    ],
    orders: [],
    order_timeline: [],
    ...overrides
  })
}

test('staff getDepositStatus returns available balance, needsRepay status and full events history with reasons', async () => {
  const db = createTestDb()
  const staffFn = loadCloudFunction('api', db, 'openid_staff_2')

  const res = await staffFn.main({
    module: 'staff',
    action: 'getDepositStatus'
  })

  assert.equal(res.ok, true)
  assert.equal(res.data.deposit.availableRefundAmount, 50)
  assert.equal(res.data.deposit.forfeitedAmount, 450)
  assert.ok(Array.isArray(res.data.events))
  assert.equal(res.data.events.length, 2)

  const forfeitEvent = res.data.events.find((e) => e.type === 'forfeit')
  assert.ok(forfeitEvent)
  assert.equal(forfeitEvent.amount, 450)
  assert.equal(forfeitEvent.amountText, '-¥450.00')
  assert.ok(forfeitEvent.reason.includes('订单严重迟到'))

  const payEvent = res.data.events.find((e) => e.type === 'pay')
  assert.ok(payEvent)
  assert.equal(payEvent.amount, 500)
  assert.equal(payEvent.amountText, '+¥500.00')
})

test('admin getStaffDepositDetail accurately returns sitter balance and detail for evidence modal', async () => {
  const db = createTestDb()
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  const res = await adminFn.main({
    module: 'admin',
    action: 'getStaffDepositDetail',
    data: { staffOpenid: 'openid_staff_2' }
  })

  assert.equal(res.ok, true)
  assert.equal(res.data.availableRefundAmount, 50)
  assert.equal(res.data.paidAmount, 500)
  assert.equal(res.data.forfeitedAmount, 450)
})

test('admin forfeitStaffDeposit correctly deducts available balance, records event and finance log', async () => {
  const db = createTestDb()
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 没收 50 元（刚好清空）
  const forfeitRes = await adminFn.main({
    module: 'admin',
    action: 'forfeitStaffDeposit',
    data: {
      id: 'dep_2',
      amount: 50,
      reason: '二次违规私自加收宠物主差价',
      clientRequestId: 'req_forfeit_test_1'
    }
  })

  assert.equal(forfeitRes.ok, true)
  assert.equal(forfeitRes.data.availableRefundAmount, 0)
  assert.equal(forfeitRes.data.status, 'forfeited')

  // 验证数据库中保证金记录与宠托师资料
  const updatedDep = db.state.staff_deposits.find((d) => d._id === 'dep_2')
  assert.equal(updatedDep.availableRefundAmount, 0)
  assert.equal(updatedDep.forfeitedAmount, 500)
  assert.equal(updatedDep.status, 'forfeited')

  const profile = db.state.staff_profiles.find((p) => p._id === 'sp_2')
  assert.equal(profile.depositStatus, 'forfeited')
  assert.equal(profile.requireDepositRepay, true, 'Fully forfeited sitter must be marked requireDepositRepay')

  // 验证 staff_deposit_events 写入
  const lastEvent = db.state.staff_deposit_events[db.state.staff_deposit_events.length - 1]
  assert.equal(lastEvent.type, 'forfeit')
  assert.equal(lastEvent.amount, 50)
  assert.equal(lastEvent.reason, '二次违规私自加收宠物主差价')
})

test('admin listStaffProfiles supports multi-criteria filter by deposit range, violations, and repay status', async () => {
  const db = createTestDb()
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 1. 仅筛选保证金在 0 到 100 之间且有违规订单的宠托师（应该只有 sp_2: 张出险，保证金 50，异常订单 1 笔）
  const filter1 = await adminFn.main({
    module: 'admin',
    action: 'listStaffProfiles',
    data: {
      minDeposit: 0,
      maxDeposit: 100,
      hasViolations: 'yes'
    }
  })

  assert.equal(filter1.ok, true)
  assert.equal(filter1.data.list.length, 1)
  assert.equal(filter1.data.list[0]._id, 'sp_2')
  assert.equal(filter1.data.list[0].realName, '张出险')
  assert.equal(filter1.data.list[0].depositBalance, 50)
  assert.equal(filter1.data.list[0].problemOrderCount, 1)

  // 2. 筛选保证金 >= 400 且无违规留证的宠托师（sp_1 和 sp_3）
  const filter2 = await adminFn.main({
    module: 'admin',
    action: 'listStaffProfiles',
    data: {
      minDeposit: 400,
      hasViolations: 'no'
    }
  })
  assert.equal(filter2.ok, true)
  assert.equal(filter2.data.list.length, 2)
  const names = filter2.data.list.map((p) => p.realName)
  assert.ok(names.includes('李小宠'))
  assert.ok(names.includes('赵合规'))
})

test('admin batchRequireDepositRepay flags selected sitters, blocking them from taking orders until repaid', async () => {
  const db = createTestDb()
  const serviceStart = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const serviceEnd = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 管理员对 sp_2 执行“要求重新足额缴纳保证金”
  const batchRes = await adminFn.main({
    module: 'admin',
    action: 'batchRequireDepositRepay',
    data: {
      staffProfileIds: ['sp_2'],
      reason: '保证金余额过低且存在违约记录，请重新足额缴纳'
    }
  })

  assert.equal(batchRes.ok, true)
  assert.equal(batchRes.data.count, 1)

  const profile2 = db.state.staff_profiles.find((p) => p._id === 'sp_2')
  assert.equal(profile2.requireDepositRepay, true)
  assert.equal(profile2.depositStatus, 'supplement_required')
  assert.equal(profile2.requireDepositRepayReason, '保证金余额过低且存在违约记录，请重新足额缴纳')

  // 验证接单强管控拦截：该宠托师尝试接单时被系统拒绝
  db.state.orders.push({
    _id: 'order_test_take_1',
    paymentStatus: 'paid',
    orderNo: 'O20260922888',
    status: 'paid',
    serviceType: 'walk',
    startTime: serviceStart,
    endTime: serviceEnd,
    clientOpenid: 'openid_client',
    serviceLatitude: 31.2,
    serviceLongitude: 121.5
  })

  const staffFn = loadCloudFunction('api', db, 'openid_staff_2')
  const acceptAttempt = await staffFn.main({
    module: 'staff',
    action: 'acceptOrder',
    data: {
      orderId: 'order_test_take_1',
      currentLatitude: 31.2,
      currentLongitude: 121.5,
      riskConfirmed: true
    }
  })

  assert.equal(acceptAttempt.ok, false)
  assert.ok(acceptAttempt.message.includes('请重新足额缴纳') || acceptAttempt.message.includes('重新缴纳'))

  // 验证宠托师端此时具备重新缴纳资格 canPay === true
  const depositStatusRes = await staffFn.main({
    module: 'staff',
    action: 'getDepositStatus'
  })
  assert.equal(depositStatusRes.ok, true)
  assert.equal(depositStatusRes.data.canPay, true)
  assert.equal(depositStatusRes.data.needsRepay, true)

  // 宠托师重新支付缴纳 500 元保证金
  const payRes = await staffFn.main({
    module: 'staff',
    action: 'createDepositPayment',
    data: { agreed: true }
  })
  assert.equal(payRes.ok, true)

  // 验证缴纳后解除管控限制，恢复正常接单资格
  const updatedProfile2 = db.state.staff_profiles.find((p) => p._id === 'sp_2')
  assert.equal(updatedProfile2.requireDepositRepay, false)
  assert.equal(updatedProfile2.depositStatus, 'paid')

  const acceptAfterRepay = await staffFn.main({
    module: 'staff',
    action: 'acceptOrder',
    data: {
      orderId: 'order_test_take_1',
      currentLatitude: 31.2,
      currentLongitude: 121.5,
      riskConfirmed: true
    }
  })
  assert.equal(acceptAfterRepay.ok, true)
  assert.equal(acceptAfterRepay.data.status, 'assigned')
})

test('personal deposit standards stay with each sitter and batch repayment charges only each shortfall', async () => {
  const db = createTestDb()
  const adminFn = loadCloudFunction('api', db, 'openid_admin')
  const firstDeposit = db.state.staff_deposits.find((deposit) => deposit._id === 'dep_1')
  const secondDeposit = db.state.staff_deposits.find((deposit) => deposit._id === 'dep_2')
  const firstProfile = db.state.staff_profiles.find((profile) => profile._id === 'sp_1')
  const secondProfile = db.state.staff_profiles.find((profile) => profile._id === 'sp_2')
  firstProfile.depositStandardAmount = 99
  secondProfile.depositStandardAmount = 100
  for (const deposit of [firstDeposit, secondDeposit]) {
    deposit.forfeitedAmount = 450
    deposit.availableRefundAmount = 50
    deposit.status = 'paid'
  }

  const filtered = await adminFn.main({
    module: 'admin',
    action: 'listStaffProfiles',
    data: { minDeposit: 50, maxDeposit: 50 }
  })
  assert.equal(filtered.ok, true)
  assert.equal(filtered.data.list.length, 2)
  assert.deepEqual(filtered.data.list.map((profile) => [profile.depositStandardAmount, profile.depositTopUpAmount]).sort((a, b) => a[0] - b[0]), [[99, 49], [100, 50]])

  const batch = await adminFn.main({
    module: 'admin',
    action: 'batchRequireDepositRepay',
    data: { staffProfileIds: ['sp_1', 'sp_2'], reason: '补足到个人标准' }
  })
  assert.equal(batch.ok, true)
  assert.equal(batch.data.count, 2)
  assert.equal(batch.data.totalTopUpAmount, 99)

  const firstStaffFn = loadCloudFunction('api', db, 'openid_staff_1')
  const firstStatus = await firstStaffFn.main({ module: 'staff', action: 'getDepositStatus' })
  assert.equal(firstStatus.data.depositStandardAmount, 99)
  assert.equal(firstStatus.data.depositBalance, 50)
  assert.equal(firstStatus.data.topUpAmount, 49)
  assert.equal(firstStatus.data.canPay, true)
  const firstPayment = await firstStaffFn.main({ module: 'staff', action: 'createDepositPayment', data: { agreed: true } })
  assert.equal(firstPayment.ok, true, firstPayment.message)
  const topUpRecord = db.state.staff_deposits.find((deposit) => deposit._id === firstPayment.data.depositId)
  assert.equal(topUpRecord.amount, 49)
  assert.equal(db.state.staff_profiles.find((profile) => profile._id === 'sp_1').requireDepositRepay, false)

  const secondStaffFn = loadCloudFunction('api', db, 'openid_staff_2')
  const secondStatus = await secondStaffFn.main({ module: 'staff', action: 'getDepositStatus' })
  assert.equal(secondStatus.data.depositStandardAmount, 100)
  assert.equal(secondStatus.data.depositBalance, 50)
  assert.equal(secondStatus.data.topUpAmount, 50)

  const changedStandard = await adminFn.main({
    module: 'admin',
    action: 'setStaffDepositStandard',
    data: { staffProfileId: 'sp_2', amount: '110' }
  })
  assert.equal(changedStandard.ok, true, changedStandard.message)
  assert.equal(changedStandard.data.depositStandardAmount, 110)
  assert.equal(changedStandard.data.topUpAmount, 60)
  assert.equal(db.state.staff_profiles.find((profile) => profile._id === 'sp_2').requireDepositRepay, true)
})

test('new sitter applications snapshot the current platform standard and legacy profiles keep their prior standard', async () => {
  const db = createTestDb()
  db.state.platform_configs[0].value.staffDeposit.amount = 99
  db.state.users.push(
    { _id: 'u_new_1', openid: 'openid_new_1', phone: '13800001112', roles: ['client'], status: 'active' },
    { _id: 'u_new_2', openid: 'openid_new_2', phone: '13800001113', roles: ['client'], status: 'active' }
  )
  const submitApplication = (openid, phone) => loadCloudFunction('api', db, openid).main({
    module: 'staff',
    action: 'submitStaffProfile',
    data: {
      gender: 'male',
      realName: '新宠托师',
      phone,
      serviceCity: '上海',
      serviceAreas: '浦东新区',
      serviceAddress: '测试服务地址',
      serviceLatitude: 31.2,
      serviceLongitude: 121.5,
      idCardFrontFileId: 'cloud://id-front.png',
      idCardBackFileId: 'cloud://id-back.png',
      facePhotoFileId: 'cloud://face.png'
    }
  })

  const first = await submitApplication('openid_new_1', '13800001112')
  assert.equal(first.ok, true, first.message)
  assert.equal(db.state.staff_profiles.find((profile) => profile.openid === 'openid_new_1').depositStandardAmount, 99)

  const adminFn = loadCloudFunction('api', db, 'openid_admin')
  const current = await adminFn.main({ module: 'admin', action: 'getSystemSettings' })
  const saved = await adminFn.main({
    module: 'admin',
    action: 'saveSystemSettings',
    data: { staffDeposit: { ...current.data.staffDeposit, amount: 100 } }
  })
  assert.equal(saved.ok, true, saved.message)
  assert.equal(db.state.staff_profiles.find((profile) => profile._id === 'sp_1').depositStandardAmount, 99)
  assert.equal(db.state.staff_profiles.find((profile) => profile.openid === 'openid_new_1').depositStandardAmount, 99)

  const second = await submitApplication('openid_new_2', '13800001113')
  assert.equal(second.ok, true, second.message)
  assert.equal(db.state.staff_profiles.find((profile) => profile.openid === 'openid_new_2').depositStandardAmount, 100)
})

test('personal standard edits retain entry standard and notice shows only the shortfall', async () => {
  const db = createTestDb()
  db.state.staff_profiles[1].depositStandardAmount = 99
  const admin = loadCloudFunction('api', db, 'openid_admin')
  for (const amount of ['100', '110']) {
    const result = await admin.main({ module: 'admin', action: 'setStaffDepositStandard', data: { staffProfileId: 'sp_2', amount } })
    assert.equal(result.ok, true, result.message)
    assert.equal(result.data.depositEntryStandardAmount, 99)
  }
  const staff = loadCloudFunction('api', db, 'openid_staff_2')
  const before = await staff.main({ module: 'staff', action: 'getStaffProfile' })
  assert.equal(before.data.depositNotice.amount, 60)
  assert.equal(before.data.canTakeOrders, false)
  const pay = await staff.main({ module: 'staff', action: 'createDepositPayment', data: { agreed: true } })
  assert.equal(pay.ok, true, pay.message)
  const status = await staff.main({ module: 'staff', action: 'getDepositStatus' })
  assert.equal(status.data.depositBalance, 110)
  assert.equal(status.data.depositTotals.paidAmount, 560)
  assert.equal(status.data.depositTotals.forfeitedAmount, 450)
  const after = await staff.main({ module: 'staff', action: 'getStaffProfile' })
  assert.equal(after.data.canTakeOrders, true)
  assert.equal(after.data.depositEntryStandardAmount, 99)
  const list = await admin.main({ module: 'admin', action: 'listStaffProfiles', data: {} })
  assert.equal(list.data.list.find(row => row._id === 'sp_2').depositEntryStandardAmount, 99)
})

test('batch repayment uses the latest standard when changed after target selection', async () => {
  const db = createTestDb()
  db.state.staff_profiles[1].depositStandardAmount = 99
  const runTransaction = db.runTransaction
  let changed = false
  db.runTransaction = callback => {
    if (!changed) {
      changed = true
      Object.assign(db.state.staff_profiles[1], { depositStandardAmount: 100, depositStandardSource: 'admin' })
    }
    return runTransaction(callback)
  }
  const result = await loadCloudFunction('api', db, 'openid_admin').main({ module: 'admin', action: 'batchRequireDepositRepay', data: { staffProfileIds: ['sp_2'] } })
  assert.equal(result.ok, true, result.message)
  assert.equal(result.data.totalTopUpAmount, 50)
  assert.equal(db.state.staff_profiles[1].depositStandardAmount, 100)
})

test('refund pending blocks payment even when the profile exit flag is missing', async () => {
  const db = createTestDb()
  Object.assign(db.state.staff_profiles[1], { depositStandardAmount: 99, requireDepositRepay: true, depositStatus: 'supplement_required' })
  db.state.staff_deposits[1].refundStatus = 'processing'
  const staff = loadCloudFunction('api', db, 'openid_staff_2')
  const status = await staff.main({ module: 'staff', action: 'getDepositStatus' })
  assert.equal(status.ok, true, status.message)
  assert.equal(status.data.canPay, false)
  const pay = await staff.main({ module: 'staff', action: 'createDepositPayment', data: { agreed: true } })
  assert.equal(pay.ok, false)
  assert.match(pay.message, /退还流程/)
})

test('remaining earlier deposits can still be refunded after the latest top-up is refunded', async () => {
  const db = createTestDb()
  db.state.staff_profiles[1].depositStatus = 'refunded'
  db.state.staff_profiles[1].exitStatus = 'exited'
  db.state.staff_profiles[1].currentDepositId = 'latest_refunded'
  db.state.staff_deposits.push({ _id: 'latest_refunded', staffOpenid: 'openid_staff_2', staffProfileId: 'sp_2', staffUserId: 'u_staff_2', amount: 49, paidAmount: 49, refundedAmount: 49, forfeitedAmount: 0, availableRefundAmount: 0, status: 'refunded', refundStatus: 'refunded', createdAt: '2026-11-01T00:00:00Z' })
  const staff = loadCloudFunction('api', db, 'openid_staff_2')
  const status = await staff.main({ module: 'staff', action: 'getDepositStatus' })
  assert.equal(status.ok, true, status.message)
  assert.equal(status.data.depositBalance, 50)
  assert.equal(status.data.canRequestRefund, true)
  assert.equal(status.data.refundDepositAmount, 50)
  const request = await staff.main({ module: 'staff', action: 'requestDepositRefund', data: { reason: '退还剩余保证金' } })
  assert.equal(request.ok, true, request.message)
  assert.equal(db.state.staff_deposits.find(row => row._id === 'dep_2').status, 'refund_requested')
  const pending = await staff.main({ module: 'staff', action: 'getDepositStatus' })
  assert.equal(pending.data.canRequestRefund, false)
  assert.equal(pending.data.canPay, false)
})

test('a saved zero personal standard is not replaced by a later global amount', async () => {
  const db = createTestDb()
  Object.assign(db.state.staff_profiles[1], { depositStandardAmount: 0, depositRequired: false, depositStatus: 'unpaid' })
  db.state.staff_deposits = db.state.staff_deposits.filter(row => row.staffOpenid !== 'openid_staff_2')
  const staff = loadCloudFunction('api', db, 'openid_staff_2')
  const profile = await staff.main({ module: 'staff', action: 'getStaffProfile' })
  assert.equal(profile.ok, true, profile.message)
  assert.equal(profile.data.depositStandardAmount, 0)
  assert.equal(profile.data.canTakeOrders, true)
  const status = await staff.main({ module: 'staff', action: 'getDepositStatus' })
  assert.equal(status.data.topUpAmount, 0)
  assert.equal(status.data.canPay, false)
})

test('exhausting one deposit does not block orders when other deposits still meet the personal standard', async () => {
  const db = createTestDb()
  Object.assign(db.state.staff_profiles[1], { depositStandardAmount: 50, currentDepositId: 'small_topup' })
  db.state.staff_deposits.push({ _id: 'small_topup', staffOpenid: 'openid_staff_2', staffUserId: 'u_staff_2', staffProfileId: 'sp_2', amount: 49, paidAmount: 49, refundedAmount: 0, forfeitedAmount: 0, availableRefundAmount: 49, status: 'paid', createdAt: '2026-11-01T00:00:00Z' })
  const result = await loadCloudFunction('api', db, 'openid_admin').main({ module: 'admin', action: 'forfeitStaffDeposit', data: { id: 'small_topup', amount: 49, reason: '扣除违规金额', clientRequestId: 'round2-forfeit' } })
  assert.equal(result.ok, true, result.message)
  assert.equal(db.state.staff_profiles[1].requireDepositRepay, false)
  const staff = loadCloudFunction('api', db, 'openid_staff_2')
  const status = await staff.main({ module: 'staff', action: 'getDepositStatus' })
  assert.equal(status.data.depositBalance, 50)
  assert.equal(status.data.needsRepay, false)
  const profile = await staff.main({ module: 'staff', action: 'getStaffProfile' })
  assert.equal(profile.data.canTakeOrders, true)
})

test('sitter management deducts across deposit records atomically and retries do not deduct twice', async () => {
  const db = createTestDb()
  Object.assign(db.state.staff_profiles[1], { depositStandardAmount: 99, currentDepositId: 'topup_49' })
  db.state.staff_deposits.push({ _id: 'topup_49', staffOpenid: 'openid_staff_2', staffUserId: 'u_staff_2', staffProfileId: 'sp_2', amount: 49, paidAmount: 49, refundedAmount: 0, forfeitedAmount: 0, availableRefundAmount: 49, status: 'paid', createdAt: '2026-11-01T00:00:00Z' })
  db.state.staff_deposit_evidences.push({ _id: 'round2_evidence', staffOpenid: 'openid_staff_2', deductAmount: 70, status: 'pending' })
  const admin = loadCloudFunction('api', db, 'openid_admin')
  const request = { module: 'admin', action: 'forfeitStaffDeposit', data: { id: 'topup_49', staffOpenid: 'openid_staff_2', allDeposits: true, amount: 70, reason: '跨记录扣除违规金额', clientRequestId: 'round2-cross-record', selectedEvidences: [{ evidenceId: 'round2_evidence', actualDeductAmount: 70 }] } }
  const result = await admin.main(request)
  assert.equal(result.ok, true, result.message)
  assert.equal(result.data.availableRefundAmount, 29)
  assert.equal(result.data.depositResults.length, 2)
  assert.equal(db.state.staff_deposits.find(row => row._id === 'topup_49').availableRefundAmount, 0)
  assert.equal(db.state.staff_deposits.find(row => row._id === 'dep_2').availableRefundAmount, 29)
  const evidence = db.state.staff_deposit_evidences.find(row => row._id === 'round2_evidence')
  assert.equal(evidence.actualDeductAmount, 70)
  assert.deepEqual(evidence.forfeitDepositIds, ['topup_49', 'dep_2'])
  const retry = await admin.main(request)
  assert.equal(retry.ok, true, retry.message)
  assert.equal(retry.data.availableRefundAmount, 29)
  assert.equal(db.state.staff_deposit_events.filter(row => row.type === 'forfeit' && row.reason === request.data.reason).reduce((sum, row) => sum + row.amount, 0), 70)
  const excessive = await admin.main({ ...request, data: { ...request.data, amount: 30, clientRequestId: 'too-much', selectedEvidences: [] } })
  assert.equal(excessive.ok, false)
  assert.equal(db.state.staff_deposits.find(row => row._id === 'dep_2').availableRefundAmount, 29)
})

test('cross-record deduction rolls back the first record if a later update fails', async () => {
  const db = createTestDb()
  Object.assign(db.state.staff_profiles[1], { depositStandardAmount: 99, currentDepositId: 'topup_49' })
  db.state.staff_deposits.push({ _id: 'topup_49', staffOpenid: 'openid_staff_2', staffUserId: 'u_staff_2', staffProfileId: 'sp_2', amount: 49, paidAmount: 49, refundedAmount: 0, forfeitedAmount: 0, availableRefundAmount: 49, status: 'paid' })
  const runTransaction = db.runTransaction
  db.runTransaction = callback => runTransaction(tx => callback({ collection(name) {
    const collection = tx.collection(name)
    if (name !== 'staff_deposits') return collection
    const doc = collection.doc.bind(collection)
    collection.doc = id => {
      const record = doc(id)
      if (id === 'dep_2') record.update = async () => { throw new Error('simulated second write failure') }
      return record
    }
    return collection
  } }))
  const result = await loadCloudFunction('api', db, 'openid_admin').main({ module: 'admin', action: 'forfeitStaffDeposit', data: { id: 'topup_49', staffOpenid: 'openid_staff_2', allDeposits: true, amount: 70, reason: '测试原子扣款', clientRequestId: 'round2-rollback' } })
  assert.equal(result.ok, false)
  assert.equal(db.state.staff_deposits.find(row => row._id === 'topup_49').availableRefundAmount, 49)
  assert.equal(db.state.staff_deposits.find(row => row._id === 'dep_2').availableRefundAmount, 50)
})

test('cross-record deduction evaluates order eligibility from the final total balance', async () => {
  const db = createTestDb()
  Object.assign(db.state.staff_profiles[1], { depositStandardAmount: 50, currentDepositId: 'topup_49' })
  db.state.staff_deposits.push({ _id: 'topup_49', staffOpenid: 'openid_staff_2', staffUserId: 'u_staff_2', staffProfileId: 'sp_2', amount: 49, paidAmount: 49, refundedAmount: 0, forfeitedAmount: 0, availableRefundAmount: 49, status: 'paid' })
  const result = await loadCloudFunction('api', db, 'openid_admin').main({ module: 'admin', action: 'forfeitStaffDeposit', data: { id: 'topup_49', staffOpenid: 'openid_staff_2', allDeposits: true, amount: 60, reason: '核对最终余额', clientRequestId: 'round3-final-balance' } })
  assert.equal(result.ok, true, result.message)
  assert.equal(result.data.availableRefundAmount, 39)
  assert.equal(db.state.staff_profiles[1].requireDepositRepay, true)
  const profile = await loadCloudFunction('api', db, 'openid_staff_2').main({ module: 'staff', action: 'getStaffProfile' })
  assert.equal(profile.data.canTakeOrders, false)
})
