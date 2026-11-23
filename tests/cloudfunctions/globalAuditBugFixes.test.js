const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const createFinanceAggregation = require('../../cloudfunctions/api/services/financeAggregation')
const createTransfers = require('../../cloudfunctions/api/services/wechatTransfers')

process.env.HOME_SECURITY_KEY = process.env.HOME_SECURITY_KEY || 'test-home-security-key'

test('Bug 1: zero-yuan coupon service and mall orders complete payment and expire/restore coupon properly', async () => {
  const nowTime = new Date()
  const futureStart = new Date(nowTime.getTime() + 48 * 3600 * 1000)
  const dateKey = new Date(futureStart.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
  const startTime = `${dateKey} 10:00`
  const endTime = `${dateKey} 10:30`

  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'client_0', roles: ['client'], status: 'active', phone: '13800001111', nickname: '零元客户' }
    ],
    pets: [
      { _id: 'pet_0', openid: 'client_0', name: '雪球', species: 'cat', weight: 4 }
    ],
    service_prices: [
      { _id: 'sp_visit', key: 'visit_fee', name: '基础上门费', price: 20, basePrice: 20, durationMinutes: 30, enabled: true, category: 'base' },
      { _id: 'sp_feed', key: 'feed', name: '上门喂养', price: 30, basePrice: 30, durationMinutes: 0, enabled: true, category: 'service' }
    ],
    user_coupons: [
      {
        _id: 'coupon_svc',
        openid: 'client_0',
        templateId: 'tpl_50',
        status: 'available',
        validFrom: '2020-01-01 00:00:00',
        validTo: '2099-12-31 23:59:59',
        templateSnapshot: { templateId: 'tpl_50', name: '50元立减券', discountAmount: 50, minOrderAmount: 0, usageScope: 'all' }
      },
      {
        _id: 'coupon_mall',
        openid: 'client_0',
        templateId: 'tpl_50',
        status: 'available',
        validFrom: '2020-01-01 00:00:00',
        validTo: '2099-12-31 23:59:59',
        templateSnapshot: { templateId: 'tpl_50', name: '50元商城券', discountAmount: 50, minOrderAmount: 0, usageScope: 'mall' }
      }
    ],
    mall_products: [
      {
        _id: 'prod_1',
        name: '猫粮试吃装',
        status: 'on_sale',
        specMode: 'single',
        price: 50,
        stock: 5,
        shippingFee: 0,
        skus: [{ skuId: 'default', price: 50, stock: 5, salesCount: 0, status: 'on_sale' }]
      }
    ],
    platform_configs: [
      { _id: 'cfg_sys', key: 'system_settings', value: { payment: { enabled: true, mode: 'wechat' } } }
    ],
    orders: [],
    mall_orders: [],
    payments: [],
    refunds: [],
    finance_logs: [],
    payment_events: [],
    order_timeline: [],
    order_home_security: [],
    client_messages: []
  })

  const api = loadCloudFunction('api', db, 'client_0')

  const createdSvc = await api.main({
    module: 'order',
    action: 'createOrder',
    data: {
      petId: 'pet_0',
      serviceTypes: ['visit_fee', 'feed'],
      startTime,
      endTime,
      serviceAddress: '测试路100号',
      addressDetail: '1号楼',
      doorplate: '101',
      addressLatitude: 31.2,
      addressLongitude: 121.5,
      couponId: 'coupon_svc',
      clientRequestId: 'zero_svc_1'
    }
  })
  assert.equal(createdSvc.ok, true, createdSvc.message)
  assert.equal(createdSvc.data.payAmount, 0)

  const paidSvc = await api.main({
    module: 'payment',
    action: 'createPayment',
    data: { orderId: createdSvc.data._id }
  })
  assert.equal(paidSvc.ok, true, paidSvc.message)
  assert.equal(paidSvc.data.paid, true)
  assert.equal(paidSvc.data.status, 'paid')
  const svcDoc = db.state.orders.find(o => o._id === createdSvc.data._id)
  assert.equal(svcDoc.status, 'paid')
  assert.equal(svcDoc.paymentStatus, 'paid')
  assert.equal(svcDoc.paymentChannel, 'coupon')
  assert.equal(db.state.user_coupons.find(c => c._id === 'coupon_svc').status, 'used')

  const createdMall = await api.main({
    module: 'mall',
    action: 'createOrder',
    data: {
      productId: 'prod_1',
      skuId: 'default',
      quantity: 1,
      couponId: 'coupon_mall',
      shippingAddress: {
        contactName: '张三',
        contactPhone: '13800001111',
        serviceAddress: '测试路100号',
        addressDetail: '1号楼',
        doorplate: '101'
      },
      clientRequestId: 'zero_mall_1'
    }
  })
  assert.equal(createdMall.ok, true, createdMall.message)
  assert.equal(createdMall.data.payAmount, 0)

  const paidMall = await api.main({
    module: 'payment',
    action: 'mockPayOrder',
    data: { orderId: createdMall.data._id }
  })
  assert.equal(paidMall.ok, false) // payment.mode is wechat, mockPayOrder rejects mock mode; use createPayment
  const paidMallReal = await api.main({
    module: 'payment',
    action: 'createPayment',
    data: { orderId: createdMall.data._id }
  })
  assert.equal(paidMallReal.ok, true, paidMallReal.message)
  assert.equal(paidMallReal.data.paid, true)
  assert.equal(paidMallReal.data.status, 'pending_ship')
  assert.equal(db.state.mall_orders.find(o => o._id === createdMall.data._id).status, 'pending_ship')
  assert.equal(db.state.user_coupons.find(c => c._id === 'coupon_mall').status, 'used')
  assert.equal(db.state.mall_products[0].skus[0].salesCount, 1)

  // Verify expired zero-yuan paid service order transitions to expired and restores coupon
  const currentSvcDoc = db.state.orders.find(o => o._id === createdSvc.data._id)
  currentSvcDoc.startTime = '2020-01-01 10:00'
  currentSvcDoc.endTime = '2020-01-01 10:30'
  currentSvcDoc.serviceSessions = [{ index: 1, date: '2020-01-01', startTime: '2020-01-01 10:00', endTime: '2020-01-01 10:30', status: 'pending' }]
  const ctx = createContext({ db, cloud: {} })
  await ctx.expireDueUnacceptedOrders()
  const expiredSvcDoc = db.state.orders.find(o => o._id === createdSvc.data._id)
  assert.equal(expiredSvcDoc.status, 'expired')
  assert.equal(db.state.user_coupons.find(c => c._id === 'coupon_svc').status, 'available')

  // Also verify mockPayOrder settles zero-yuan order cleanly in mock payment mode
  db.state.platform_configs[0].value.payment.mode = 'mock'
  const createdMockFree = await api.main({
    module: 'order',
    action: 'createOrder',
    data: {
      petId: 'pet_0',
      serviceTypes: ['visit_fee', 'feed'],
      startTime,
      endTime,
      serviceAddress: '测试路100号',
      addressDetail: '1号楼',
      doorplate: '101',
      addressLatitude: 31.2,
      addressLongitude: 121.5,
      couponId: 'coupon_svc',
      clientRequestId: 'zero_svc_mock_1'
    }
  })
  assert.equal(createdMockFree.ok, true, createdMockFree.message)
  const mockPaidRes = await api.main({
    module: 'payment',
    action: 'mockPayOrder',
    data: { orderId: createdMockFree.data._id }
  })
  assert.equal(mockPaidRes.ok, true, mockPaidRes.message)
  assert.equal(mockPaidRes.data.paid, true)
  assert.equal(db.state.orders.find(o => o._id === createdMockFree.data._id).status, 'paid')
  assert.equal(db.state.user_coupons.find(c => c._id === 'coupon_svc').status, 'used')
})

test('Bug 2: userAssets.bindInviteCode marks eligibleForSupplyReimbursement and grants retro card + beauty bonus vote', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_sitter', openid: 'sitter_1', inviteCode: 'SIT888', roles: ['client', 'staff'], status: 'active', retroCardCount: 2 },
      { _id: 'u_friend', openid: 'friend_1', roles: ['client'], status: 'active', retroCardCount: 0 }
    ],
    staff_profiles: [
      {
        _id: 'sp_1',
        openid: 'sitter_1',
        auditStatus: 'approved',
        staffLevel: 'certified',
        depositRequired: true,
        depositStatus: 'paid',
        certifiedAt: '2026-10-01 10:00:00'
      }
    ],
    staff_deposits: [
      { _id: 'dep_1', staffOpenid: 'sitter_1', status: 'paid', paidAmount: 500 }
    ],
    platform_configs: [
      {
        _id: 'cfg_1',
        key: 'system_settings',
        value: {
          invitation: { enabled: true, rewardAmount: 5 },
          staffSupplies: { reimbursementEnabled: true, reimbursementMode: 'invite_count', reimbursementInviteCount: 1, reimbursementOrderCount: 0, purchaseRequired: false }
        }
      }
    ],
    user_invites: [],
    retro_card_logs: [],
    pet_beauty_bonus_votes: [],
    staff_supply_reimbursements: [],
    orders: [],
    mall_orders: []
  })

  const friendApi = loadCloudFunction('api', db, 'friend_1')
  const bindRes = await friendApi.main({
    module: 'finance',
    action: 'bindInviteCode',
    data: { inviteCode: 'SIT888', bindingSource: 'share' }
  })
  assert.equal(bindRes.ok, true, bindRes.message)
  assert.equal(db.state.user_invites.length, 1)
  assert.equal(db.state.user_invites[0].eligibleForSupplyReimbursement, true)
  assert.ok(db.state.user_invites[0].inviterStaffEligibleAt)
  assert.equal(db.state.users.find(u => u._id === 'u_sitter').retroCardCount, 3)
  assert.equal(db.state.retro_card_logs.length, 1)
  assert.equal(db.state.pet_beauty_bonus_votes.length, 1)

  const sitterApi = loadCloudFunction('api', db, 'sitter_1')
  const supplyStatus = await sitterApi.main({ module: 'staff', action: 'getSupplyReimbursementStatus', data: {} })
  assert.equal(supplyStatus.ok, true, supplyStatus.message)
  assert.equal(supplyStatus.data.qualification.eligibleInviteCount, 1)
  assert.equal(supplyStatus.data.canApply, true)
})

test('Bug 3: admin.updateOrderStatus completes in_service/day_completed orders with full rewards while still blocking rollbacks/reassignments', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'admin_1', roles: ['admin'], status: 'active' },
      { _id: 'u_client', openid: 'client_1', roles: ['client'], status: 'active', points: 0, totalPoints: 0, completedOrderCount: 0 },
      { _id: 'u_staff', openid: 'staff_1', roles: ['client', 'staff'], status: 'active' }
    ],
    staff_profiles: [
      { _id: 'sp_1', openid: 'staff_1', auditStatus: 'approved', staffLevel: 'intern', internCompletedOrderCount: 0 }
    ],
    orders: [
      {
        _id: 'ord_in_svc',
        orderNo: 'O_IN_SVC',
        clientOpenid: 'client_1',
        staffOpenid: 'staff_1',
        staffProfileId: 'sp_1',
        status: 'in_service',
        paymentStatus: 'paid',
        paymentChannel: 'wechat',
        payAmount: 100,
        startTime: '2026-10-10 10:00',
        endTime: '2026-10-10 11:00',
        serviceSessions: [{ index: 1, date: '2026-10-10', startTime: '2026-10-10 10:00', endTime: '2026-10-10 11:00', status: 'in_service' }],
        hasDoorLockCode: true,
        orderHomeSecurity: { type: 'one_time_code', oneTimeCode: { cipher: 'abc', iv: 'iv', tag: 'tag' } }
      }
    ],
    order_home_security: [
      { _id: 'sec_1', orderId: 'ord_in_svc', type: 'one_time_code', oneTimeCode: { cipher: 'abc', iv: 'iv', tag: 'tag' } }
    ],
    staff_earnings: [],
    point_logs: [],
    retro_card_logs: [],
    order_timeline: [],
    client_messages: [],
    admin_operation_logs: [],
    admin_dispatch_notifications: [{ _id: 'disp_1', orderId: 'ord_in_svc', resolved: false }],
    platform_configs: [{ _id: 'cfg', key: 'system_settings', value: { settlement: { staffCommissionRate: 0.7, settlementDelayDays: 0 } } }]
  })

  const adminApi = loadCloudFunction('api', db, 'admin_1')

  // Rolling back an in_service order to paid must still be rejected
  const rollbackRes = await adminApi.main({
    module: 'admin',
    action: 'updateOrderStatus',
    data: { orderId: 'ord_in_svc', status: 'paid', remark: '尝试回退' }
  })
  assert.equal(rollbackRes.ok, false)
  assert.match(rollbackRes.message, /不允许修改状态/)

  // Forward completion from in_service succeeds and triggers rewards, session updates, and secret destruction
  const compRes = await adminApi.main({
    module: 'admin',
    action: 'updateOrderStatus',
    data: { orderId: 'ord_in_svc', status: 'completed', remark: '线下确认已完成' }
  })
  assert.equal(compRes.ok, true, compRes.message)
  assert.equal(compRes.data.status, 'completed')

  const updatedOrder = db.state.orders[0]
  assert.equal(updatedOrder.status, 'completed')
  assert.equal(updatedOrder.serviceSessions[0].status, 'completed')
  assert.equal(updatedOrder.pointsAwarded, true)
  assert.equal(updatedOrder.clientOrderCounted, true)
  assert.equal(updatedOrder.isDoorLockCodeDestroyed, true)
  assert.equal(db.state.users.find(u => u._id === 'u_client').completedOrderCount, 1)
  assert.equal(db.state.users.find(u => u._id === 'u_client').points, 10)
  assert.equal(db.state.staff_earnings.length, 1)
  assert.equal(db.state.staff_earnings[0].amount, 70)
  assert.equal(db.state.staff_profiles[0].internCompletedOrderCount, 1)
})

test('Bug 4: financeAggregation excludes deposit refunds & mock records and includes mall_orders & on_the_way in GMV', async () => {
  const db = createCollectionStore({
    orders: [
      { _id: 'o1', status: 'on_the_way', paymentStatus: 'paid', payAmount: 100, paymentChannel: 'wechat', createdAt: new Date('2026-10-01T10:00:00Z') },
      { _id: 'o_mock', status: 'completed', paymentStatus: 'paid', payAmount: 999, isMockPayment: true, paymentChannel: 'mock', createdAt: new Date('2026-10-01T10:00:00Z') }
    ],
    mall_orders: [
      { _id: 'm1', status: 'pending_ship', paymentStatus: 'paid', payAmount: 60, paymentChannel: 'wechat', createdAt: new Date('2026-10-01T10:00:00Z') },
      { _id: 'm_mock', status: 'pending_ship', paymentStatus: 'paid', payAmount: 500, isMockPayment: true, paymentChannel: 'mock', createdAt: new Date('2026-10-01T10:00:00Z') }
    ],
    payments: [
      { _id: 'p1', status: 'success', amount: 100, channel: 'wechat', paidAt: new Date('2026-10-01T10:00:00Z') },
      { _id: 'p2', status: 'success', amount: 60, channel: 'wechat', targetType: 'mall_order', paidAt: new Date('2026-10-01T10:00:00Z') },
      { _id: 'p_mock', status: 'success', amount: 999, channel: 'mock', paidAt: new Date('2026-10-01T10:00:00Z') }
    ],
    refunds: [
      { _id: 'r_order', status: 'success', refundAmount: 20, channel: 'wechat', succeededAt: new Date('2026-10-01T11:00:00Z') },
      { _id: 'r_deposit', status: 'success', targetType: 'staff_deposit', collectionName: 'staff_deposits', refundAmount: 500, succeededAt: new Date('2026-10-01T11:00:00Z') },
      { _id: 'r_mock', status: 'success', refundAmount: 88, channel: 'mock', succeededAt: new Date('2026-10-01T11:00:00Z') }
    ],
    staff_earnings: [
      { _id: 'e1', status: 'available', amount: 70, paymentChannel: 'wechat', createdAt: new Date('2026-10-01T12:00:00Z') }
    ]
  })
  const rawCollection = db.collection
  db.collection = name => ({ aggregate: () => rawCollection(name).aggregate() })
  const result = await createFinanceAggregation({ db, safeText: v => String(v || '') }).aggregateFinanceDashboard({})
  assert.equal(result.metrics.gmv, 160)
  assert.equal(result.metrics.received, 160)
  assert.equal(result.metrics.refundAmount, 20)
  assert.equal(result.metrics.netRevenue, 140)
  assert.equal(result.metrics.platformGrossProfit, 70)
  assert.equal(result.counts.paidOrders, 2)
})

test('Bug 5: reconcileWechatTransfers skips gateway-confirmed transfer_failed and markWechatWithdrawalFailed is idempotent', async () => {
  const calls = []
  const db = createCollectionStore({
    withdraw_requests: [
      {
        _id: 'w_confirmed_fail',
        staffOpenid: 'staff_1',
        payoutChannel: 'wechat_wallet',
        status: 'transfer_failed',
        transferStatus: 'failed',
        gatewayFailureConfirmed: true,
        outBillNo: 'OUT_CONFIRMED_FAIL',
        amount: 20,
        transferFailedAt: '2026-10-01 10:00:00',
        lastTransferCheckedAt: new Date('2026-10-01T10:00:00Z')
      },
      {
        _id: 'w_user_confirmed_fail',
        assetType: 'user',
        userOpenid: 'client_1',
        payoutChannel: 'wechat_wallet',
        status: 'transfer_failed',
        transferStatus: 'failed',
        gatewayFailureConfirmed: true,
        outBillNo: 'OUT_USER_FAIL',
        amount: 10
      }
    ],
    finance_logs: [],
    subscription_logs: []
  })

  const service = createTransfers({
    db,
    crypto,
    now: () => new Date('2026-10-02T10:00:00Z'),
    safeText: v => String(v || ''),
    getSystemSettings: async () => ({}),
    getWechatTransferConfig: () => ({ mchId: 'mch', appId: 'app', transferMaxAmount: 200 }),
    wechatPayRequest: async (method, path) => { calls.push({ method, path }); return { state: 'FAIL' } },
    encryptWechatTransferUserName: () => '',
    sanitizeWechatTransferPayload: v => v,
    markWechatWithdrawalPaid: async () => ({ changed: false }),
    markWechatWithdrawalFailed: async () => ({ changed: false }),
    prepareWechatSubmissionQuota: async () => {}
  })

  const reconcileRes = await service.reconcileWechatTransfers(10)
  assert.equal(reconcileRes.checked, 0)
  assert.equal(calls.length, 0)

  const ctx = createContext({ db, cloud: {} })
  const staffRes = await ctx.markWechatWithdrawalFailed('w_confirmed_fail', { state: 'FAIL', gatewayTerminalConfirmed: true })
  assert.equal(staffRes.changed, false)
  assert.equal(db.state.withdraw_requests[0].transferFailedAt, '2026-10-01 10:00:00')
  assert.equal(db.state.finance_logs.length, 0)

  const userRes = await ctx.markWechatWithdrawalFailed('w_user_confirmed_fail', { state: 'FAIL', gatewayTerminalConfirmed: true })
  assert.equal(userRes.changed, false)
})

test('Bug 6: withdrawals.createWithdrawRequest resolves exact subset even when greedy order misses', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u_s', openid: 'staff_1', roles: ['staff'], status: 'active' }],
    staff_earnings: [
      { _id: 'e1', staffOpenid: 'staff_1', status: 'available', amount: 100, paymentChannel: 'wechat' },
      { _id: 'e2', staffOpenid: 'staff_1', status: 'available', amount: 120, paymentChannel: 'wechat' },
      { _id: 'e3', staffOpenid: 'staff_1', status: 'available', amount: 80, paymentChannel: 'wechat' }
    ],
    withdraw_requests: [],
    finance_logs: [],
    wechat_transfer_quota_ledger: [],
    platform_configs: [{ _id: 'cfg', key: 'system_settings', value: { settlement: { minWithdrawAmount: 10 } } }]
  })

  const staffApi = loadCloudFunction('api', db, 'staff_1')
  const res = await staffApi.main({
    module: 'finance',
    action: 'createWithdrawRequest',
    data: { amount: 200, payoutChannel: 'wechat_wallet', clientRequestId: 'subset_200' }
  })
  assert.equal(res.ok, true, res.message)
  assert.equal(res.data.amount, 200)
  assert.deepEqual(res.data.earningIds, ['e2', 'e3'])
})

test('Bug 7: deleteUser blocks pending_ship mall orders, open incidents, unsettled staff earnings, and unrefunded staff deposits', async () => {
  const baseDb = (extra) => createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'admin_1', roles: ['admin'], status: 'active' },
      { _id: 'u_admin_2', openid: 'admin_2', roles: ['admin'], status: 'active' },
      { _id: 'u_target', openid: 'target_1', roles: ['client', 'staff'], status: 'active' }
    ],
    orders: [],
    mall_orders: [],
    order_incidents: [],
    withdraw_requests: [],
    staff_earnings: [],
    staff_deposits: [],
    ...extra
  })

  for (const [extra, pattern] of [
    [{ mall_orders: [{ _id: 'mo1', clientOpenid: 'target_1', status: 'pending_ship' }] }, /商城订单/],
    [{ order_incidents: [{ _id: 'inc1', clientOpenid: 'target_1', status: 'open' }] }, /纠纷/],
    [{ staff_earnings: [{ _id: 'se1', staffOpenid: 'target_1', status: 'available', amount: 50, paymentChannel: 'wechat' }] }, /未结清收益/],
    [{ staff_deposits: [{ _id: 'sd1', staffOpenid: 'target_1', status: 'paid', paidAmount: 500, availableRefundAmount: 500 }] }, /保证金/]
  ]) {
    const api = loadCloudFunction('api', baseDb(extra), 'admin_1')
    const res = await api.main({ module: 'admin', action: 'deleteUser', data: { openid: 'target_1' } })
    assert.equal(res.ok, false)
    assert.match(res.message, pattern)
  }
})

test('Bug 8: cloud runtime rejects mock phone code when test mode is disabled', async () => {
  const prevTcbEnv = process.env.TCB_ENV
  process.env.TCB_ENV = 'cloud1-dev-env'
  try {
    const db = createCollectionStore({
      users: [],
      platform_configs: [{ _id: 'cfg', key: 'system_settings', value: { enableTestAddressMode: false } }]
    })
    const api = loadCloudFunction('api', db, 'user_mock_probe')
    const blocked = await api.main({ module: 'auth', action: 'loginByPhoneCode', data: { code: 'mock_123' } })
    assert.equal(blocked.ok, false)
    assert.match(blocked.message, /模拟手机号/)
  } finally {
    if (prevTcbEnv === undefined) delete process.env.TCB_ENV
    else process.env.TCB_ENV = prevTcbEnv
  }
})

test('Bug 9: delegated admin can access own participant incident and petBeauty.listDisqualifiedPetBeautyCandidates', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_sub', openid: 'sub_admin', roles: ['client', 'admin'], status: 'active' },
      { _id: 'u_other', openid: 'other_client', roles: ['client'], status: 'active' }
    ],
    admin_access_config: [{ _id: 'policy', enabled: true, ownerOpenid: 'owner_1' }],
    admin_groups: [{ _id: 'g_pets', name: '宠物组', enabled: true, permissions: ['admin.listPets'] }],
    admin_memberships: [{ _id: 'u_sub', groupIds: ['g_pets'] }],
    orders: [
      { _id: 'ord_own', orderNo: 'OWN1', clientOpenid: 'sub_admin', serviceSummary: '喂养', doorLockCode: 'SECRET', payAmount: 50 }
    ],
    order_incidents: [
      { _id: 'inc_own', orderId: 'ord_own', clientOpenid: 'sub_admin', staffOpenid: 'staff_x', status: 'open' },
      { _id: 'inc_other', orderId: 'ord_x', clientOpenid: 'other_client', staffOpenid: 'staff_x', status: 'open' }
    ],
    incident_comments: [],
    incident_actions: [],
    pets: [
      { _id: 'pet_disq', name: '二哈', beautyContestDisqualified: true, disqualifiedReason: '刷票' }
    ]
  })

  const subApi = loadCloudFunction('api', db, 'sub_admin')

  const ownDetail = await subApi.main({ module: 'incident', action: 'getIncidentDetail', data: { id: 'inc_own' } })
  assert.equal(ownDetail.ok, true, ownDetail.message)
  assert.equal(ownDetail.data.order.doorLockCode, undefined)

  const commentRes = await subApi.main({ module: 'incident', action: 'appendIncidentComment', data: { incidentId: 'inc_own', content: '我方补充说明' } })
  assert.equal(commentRes.ok, true, commentRes.message)
  assert.equal(commentRes.data.actorRole, 'client')

  const otherDetail = await subApi.main({ module: 'incident', action: 'getIncidentDetail', data: { id: 'inc_other' } })
  assert.equal(otherDetail.ok, false)

  const disqRes = await subApi.main({ module: 'petBeauty', action: 'listDisqualifiedPetBeautyCandidates', data: {} })
  assert.equal(disqRes.ok, true, disqRes.message)
  assert.equal(disqRes.data.length, 1)
  assert.equal(disqRes.data[0].petId, 'pet_disq')
})

test('Bug 10: homeSecurity allows day_completed password update, resets destroyed flags, and allows in_service unlock past scheduled endTime', async () => {
  const nowMs = Date.now()
  const db = createCollectionStore({
    users: [
      { _id: 'uc', openid: 'client_1', roles: ['client'], status: 'active' },
      { _id: 'us', openid: 'staff_1', roles: ['staff'], status: 'active' }
    ],
    orders: [
      {
        _id: 'ord_multi',
        clientOpenid: 'client_1',
        staffOpenid: 'staff_1',
        status: 'day_completed',
        isDoorLockCodeDestroyed: true,
        orderHomeSecurity: { type: 'one_time_code', destroyed: true, isPasswordDestroyed: true },
        serviceSessions: [
          { index: 1, date: 'day1', startTime: new Date(nowMs - 86400000).toISOString(), endTime: new Date(nowMs - 82800000).toISOString(), status: 'completed' },
          { index: 2, date: 'day2', startTime: new Date(nowMs - 3600000).toISOString(), endTime: new Date(nowMs - 60000).toISOString(), status: 'in_service' }
        ],
        activeSessionIndex: 2
      }
    ],
    order_home_security: [{ _id: 'sec_1', orderId: 'ord_multi', type: 'one_time_code', destroyed: true, isPasswordDestroyed: true }],
    unlock_code_logs: [],
    order_messages: []
  })

  const clientApi = loadCloudFunction('homeSecurity', db, 'client_1')
  const staffApi = loadCloudFunction('homeSecurity', db, 'staff_1')

  const updateRes = await clientApi.main({
    action: 'updateOrderOneTimeCode',
    data: {
      orderId: 'ord_multi',
      sessionIndex: 2,
      date: 'day2',
      code: '789012',
      effectiveStart: new Date(nowMs - 7200000).toISOString(),
      effectiveEnd: new Date(nowMs + 1800000).toISOString()
    }
  })
  assert.equal(updateRes.ok, true, updateRes.message)
  assert.equal(db.state.orders[0].isDoorLockCodeDestroyed, false)

  // Move order into active session 2 which already passed scheduled endTime, within password effectiveEnd
  db.state.orders[0].status = 'in_service'
  const unlockRes = await staffApi.main({
    action: 'getUnlockCode',
    data: { orderId: 'ord_multi', sessionIndex: 2 }
  })
  assert.equal(unlockRes.ok, true, unlockRes.message)
  assert.equal(unlockRes.data.doorLockCode, '789012')
})

test('Bug 11: scheduling merges contiguous slots across weeklySchedule and exceptions', async () => {
  const db = createCollectionStore({
    staff_profiles: [],
    orders: []
  })
  const ctx = createContext({ db, cloud: {} })
  const normalized = ctx.normalizeWeeklySchedule({ '1': [{ start: 12, end: 18 }, { start: 8, end: 12 }] })
  assert.deepEqual(normalized['1'], [{ start: 8, end: 18 }])
  // 2026-11-23 is Monday (day 1)
  ctx.validateSitterScheduleTime(normalized, '2026-11-23 11:00', '2026-11-23 13:00')
  ctx.validateSlotsForDate([{ start: 8, end: 12 }, { start: 12, end: 18 }], '2026-11-23 11:00', '2026-11-23 13:00', '2026-11-23', '无排班')
})

test('Bug 12: pet.deletePet blocks on_the_way orders; petBeauty.vote supports avatar-only candidate; deleteBeautyPhoto validates and matches properly', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u1', openid: 'owner_1', roles: ['client'], status: 'active' },
      { _id: 'u2', openid: 'voter_1', roles: ['client'], status: 'active' }
    ],
    pets: [
      {
        _id: 'pet_1',
        openid: 'owner_1',
        name: '花卷',
        avatarFileId: 'cloud://avatar_1.jpg',
        beautyPhotos: []
      },
      {
        _id: 'pet_2',
        openid: 'owner_1',
        name: '汤圆',
        avatarFileId: 'cloud://p1.jpg',
        beautyPhotos: [
          { id: 'bp_1', fileId: 'cloud://p1.jpg' },
          { id: 'bp_2', fileId: 'cloud://p2.jpg' }
        ]
      }
    ],
    orders: [
      { _id: 'ord_way', clientOpenid: 'owner_1', petId: 'pet_1', petIds: ['pet_1'], status: 'on_the_way' }
    ],
    pet_beauty_votes: [],
    pet_beauty_month_locks: []
  })

  const ownerApi = loadCloudFunction('api', db, 'owner_1')
  const voterApi = loadCloudFunction('api', db, 'voter_1')

  const delPet = await ownerApi.main({ module: 'pet', action: 'deletePet', data: { id: 'pet_1' } })
  assert.equal(delPet.ok, false)
  assert.match(delPet.message, /不可删除/)

  const voteRes = await voterApi.main({ module: 'petBeauty', action: 'vote', data: { petId: 'pet_1' } })
  assert.equal(voteRes.ok, true, voteRes.message)

  // Empty photoId & fileId must fail without clearing all photos
  if (new Date(Date.now() + 8 * 3600 * 1000).getUTCDate() === 1) {
    const emptyDel = await ownerApi.main({ module: 'petBeauty', action: 'deleteBeautyPhoto', data: { petId: 'pet_2' } })
    assert.equal(emptyDel.ok, false)
    assert.match(emptyDel.message, /请选择要删除的美照/)
  } else {
    // Directly verify handler filter behavior by passing toCstParts returning the 1st of month
    const ctx = createContext({ db, cloud: {} })
    const handler = require('../../cloudfunctions/api/handlers/petBeauty')({
      ...ctx,
      toCstParts: () => ({ dayNumber: 1, dateKey: '2026-11-01', monthKey: '2026-11' })
    })
    await assert.rejects(() => handler('owner_1', 'deleteBeautyPhoto', { petId: 'pet_2' }), /请选择要删除的美照/)
    const deletedRes = await handler('owner_1', 'deleteBeautyPhoto', { petId: 'pet_2', photoId: 'bp_2', fileId: 'cloud://different.jpg' })
    assert.equal(deletedRes.beautyPhotos.length, 1)
    assert.equal(deletedRes.beautyPhotos[0].id, 'bp_1')
  }
})

test('Bug 13: publicOrderGrabNotifications checks adminDeletedAt and dynamic vaccine expiry', async () => {
  const db = createCollectionStore({ staff_profiles: [], orders: [] })
  const ctx = createContext({ db, cloud: {} })
  ctx.now = () => new Date('2026-11-23T02:00:00Z')

  assert.equal(ctx.isOrderEligibleForGrab({
    _id: 'o_del',
    status: 'paid',
    paymentStatus: 'paid',
    publishMode: 'open',
    adminDeletedAt: '2026-11-20 10:00:00',
    startTime: '2026-11-24 10:00:00'
  }), false)

  const eligibility = await ctx.checkSitterEligibilityForOrder(
    {
      openid: 'staff_1',
      auditStatus: 'approved',
      staffLevel: 'certified',
      serviceAddress: '地址',
      serviceLatitude: 31.2,
      serviceLongitude: 121.5,
      serviceRadiusKm: 10,
      rejectUnvaccinatedPets: true
    },
    {
      _id: 'o_expired_vax',
      clientOpenid: 'client_1',
      status: 'paid',
      paymentStatus: 'paid',
      publishMode: 'open',
      serviceLatitude: 31.2,
      serviceLongitude: 121.5,
      startTime: '2026-11-24 10:00',
      endTime: '2026-11-24 11:00',
      petSnapshots: [{
        name: '旺财',
        vaccineCertified: true,
        vaccineCertification: { status: 'approved', validUntil: '2026-11-01' }
      }]
    },
    { staffDeposit: { required: false } },
    []
  )
  assert.equal(eligibility.eligible, false)
  assert.equal(eligibility.reason, 'unvaccinated_pet_rejected')
})

test('Bug 14: memorialLifecycle.cleanupMemorials removes orphaned cleanup jobs instead of starving later jobs', async () => {
  const orphans = Array.from({ length: 12 }, (_, i) => ({
    _id: `job_${String(i).padStart(2, '0')}`,
    key: 'memorial_cleanup',
    applicationId: `missing_app_${i}`,
    fileIds: []
  }))
  const db = createCollectionStore({
    platform_configs: [
      ...orphans,
      { _id: 'app_real', key: 'memorial_demolished', status: 'demolished' },
      { _id: 'job_real', key: 'memorial_cleanup', applicationId: 'app_real', fileIds: ['cloud://mem/old.jpg'] },
      { _id: 'media_real', key: 'memorial_media', applicationId: 'app_real', fileId: 'cloud://mem/old.jpg' }
    ]
  })
  const deleted = []
  const cloud = {
    deleteFile: async ({ fileList }) => {
      deleted.push(...fileList)
      return { fileList: fileList.map(fileID => ({ fileID, status: 0 })) }
    }
  }
  const ctx = createContext({ db, cloud })
  await ctx.cleanupMemorials()
  await ctx.cleanupMemorials()
  await ctx.cleanupMemorials()
  assert.equal(db.state.platform_configs.some(r => r.key === 'memorial_cleanup'), false)
  assert.equal(db.state.platform_configs.some(r => r._id === 'media_real'), false)
  assert.deepEqual(deleted, ['cloud://mem/old.jpg'])
})
