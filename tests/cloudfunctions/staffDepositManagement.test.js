const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

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
    orderNo: 'O20260922888',
    status: 'paid',
    serviceType: 'walk',
    startTime: '2026-09-22 18:00',
    endTime: '2026-09-22 19:00',
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
      currentLongitude: 121.5
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
      currentLongitude: 121.5
    }
  })
  assert.equal(acceptAfterRepay.ok, true)
  assert.equal(acceptAfterRepay.data.status, 'assigned')
})
