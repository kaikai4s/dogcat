const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('admin dashboard returns platform pending commission, pending staff earnings, and expired commission', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active', createdAt: '2026-11-01 10:00:00' }
    ],
    orders: [],
    user_asset_earnings: [
      { _id: 'e1', userOpenid: 'u1', amount: 15.5, status: 'available' },
      { _id: 'e2', userOpenid: 'u2', amount: 20.0, status: 'available' },
      { _id: 'e3', userOpenid: 'u3', amount: 12.3, status: 'expired' },
      { _id: 'e4', userOpenid: 'u1', amount: 50.0, status: 'withdrawn' }
    ],
    staff_earnings: [
      { _id: 'se1', staffOpenid: 's1', amount: 120.0, status: 'available' },
      { _id: 'se2', staffOpenid: 's2', amount: 80.5, status: 'available' },
      { _id: 'se3', staffOpenid: 's1', amount: 300.0, status: 'withdrawn' }
    ]
  })

  const fn = loadCloudFunction('api', db, 'openid_admin')
  const result = await fn.main({ module: 'admin', action: 'dashboard', data: {} })

  assert.equal(result.ok, true)
  assert.equal(result.data.pendingCommission, 35.5) // 15.5 + 20.0
  assert.equal(result.data.expiredCommission, 12.3) // 12.3
  assert.equal(result.data.pendingStaffEarnings, 200.5) // 120.0 + 80.5
  assert.equal(result.data.platformFinance.pendingCommission, 35.5)
  assert.equal(result.data.platformFinance.expiredCommission, 12.3)
  assert.equal(result.data.platformFinance.pendingStaffEarnings, 200.5)
})

test('admin listWithdrawRequests includes applicantOpenid and allows searching by openid', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' },
      { _id: 'u1', openid: 'wx_user_open_123', nickname: '爱宠小张', phone: '13800000001' },
      { _id: 's1', openid: 'wx_staff_open_456', nickname: '宠托小李', phone: '13800000002' }
    ],
    withdraw_requests: [
      { _id: 'w1', assetType: 'user', userOpenid: 'wx_user_open_123', amount: 50, status: 'pending', createdAt: '2026-11-01 12:00:00' },
      { _id: 'w2', assetType: 'staff', staffOpenid: 'wx_staff_open_456', amount: 100, status: 'approved', createdAt: '2026-11-01 13:00:00' }
    ],
    staff_profiles: [
      { _id: 'sp1', openid: 'wx_staff_open_456', realName: '李托师' }
    ],
    user_asset_earnings: [],
    staff_earnings: []
  })

  const fn = loadCloudFunction('api', db, 'openid_admin')
  const resAll = await fn.main({ module: 'admin', action: 'listWithdrawRequests', data: {} })

  assert.equal(resAll.ok, true)
  assert.equal(resAll.data.length, 2)
  const userWithdraw = resAll.data.find(r => r._id === 'w1')
  const staffWithdraw = resAll.data.find(r => r._id === 'w2')

  assert.equal(userWithdraw.applicantOpenid, 'wx_user_open_123')
  assert.equal(staffWithdraw.applicantOpenid, 'wx_staff_open_456')

  // 搜索关键字匹配 openid
  const resSearch = await fn.main({ module: 'admin', action: 'listWithdrawRequests', data: { keyword: 'wx_user_open_123' } })
  assert.equal(resSearch.ok, true)
  assert.equal(resSearch.data.length, 1)
  assert.equal(resSearch.data[0]._id, 'w1')
})

test('admin getUserDetail returns user commission summary and getUserRelatedDetails drills down into coupons, points, addresses, pets and commission', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' },
      { _id: 'u_target', openid: 'target_user_openid', nickname: '测试用户', phone: '13911112222', points: 280, totalPoints: 500, status: 'active', createdAt: '2026-10-01' }
    ],
    user_coupons: [
      { _id: 'uc1', openid: 'target_user_openid', templateSnapshot: { name: '新人专享券', discountAmount: 20, minOrderAmount: 100, usageScopeText: '全场通用' }, sourceType: 'register_grant', status: 'available', validTo: '2099-12-31', createdAt: '2026-10-01 10:00:00' },
      { _id: 'uc2', openid: 'target_user_openid', templateSnapshot: { name: '洗护立减券', discountAmount: 15, minOrderAmount: 50, usageScopeText: '洗护服务' }, sourceType: 'admin_manual_grant', status: 'used', usedOrderId: 'ord_123', validTo: '2026-10-10', createdAt: '2026-10-05 10:00:00' }
    ],
    point_logs: [
      { _id: 'pl1', openid: 'target_user_openid', delta: 50, balance: 280, reason: '邀请好友奖励', createdAt: '2026-11-01 09:00:00' },
      { _id: 'pl2', openid: 'target_user_openid', delta: -10, balance: 230, reason: '积分商城兑换', createdAt: '2026-10-20 09:00:00' }
    ],
    user_addresses: [
      { _id: 'addr1', openid: 'target_user_openid', contactName: '张三', contactPhone: '13911112222', serviceAddress: '阳光花园一期', addressDetail: '3号楼', doorplate: '502室', isDefault: true, createdAt: '2026-10-02 11:00:00' }
    ],
    pets: [
      { _id: 'pet1', openid: 'target_user_openid', name: '旺财', species: 'dog', breed: '柯基', age: '2岁', gender: 'male', sterilized: true, weight: 11, createdAt: '2026-10-02 12:00:00' }
    ],
    user_asset_earnings: [
      { _id: 'ue1', userOpenid: 'target_user_openid', amount: 18.5, status: 'available', sourceType: 'invite_binding', invitedOpenid: 'friend_001', createdAt: '2026-10-15 10:00:00', expiresAt: '2026-12-15' },
      { _id: 'ue2', userOpenid: 'target_user_openid', amount: 5.0, status: 'expired', sourceType: 'order_commission', orderId: 'ord_999', createdAt: '2026-08-01 10:00:00', expiresAt: '2026-09-01' },
      { _id: 'ue3', userOpenid: 'target_user_openid', amount: 30.0, status: 'withdrawn', sourceType: 'invite_binding', createdAt: '2026-09-01 10:00:00' }
    ],
    withdraw_requests: [
      { _id: 'wr1', assetType: 'user', userOpenid: 'target_user_openid', amount: 30.0, status: 'paid', payoutChannel: 'wechat_wallet', paymentReference: 'wx_bill_112233', createdAt: '2026-09-02 10:00:00', paidAt: '2026-09-02 11:00:00' }
    ]
  })

  const fn = loadCloudFunction('api', db, 'openid_admin')

  // 1. getUserDetail
  const detailRes = await fn.main({ module: 'admin', action: 'getUserDetail', data: { openid: 'target_user_openid' } })
  assert.equal(detailRes.ok, true)
  assert.equal(detailRes.data.commission.available, 18.5)
  assert.equal(detailRes.data.commission.expired, 5.0)
  assert.equal(detailRes.data.commission.withdrawn, 30.0)

  // 2. getUserRelatedDetails: all
  const relatedAll = await fn.main({ module: 'admin', action: 'getUserRelatedDetails', data: { openid: 'target_user_openid', type: 'all' } })
  assert.equal(relatedAll.ok, true)
  assert.equal(relatedAll.data.coupons.length, 2)
  const couponNew = relatedAll.data.coupons.find(c => c.name === '新人专享券')
  const couponCare = relatedAll.data.coupons.find(c => c.name === '洗护立减券')
  assert.ok(couponNew)
  assert.ok(couponCare)
  assert.equal(couponNew.discountAmount, 20)
  assert.equal(couponNew.sourceText, '新用户注册赠送')
  assert.equal(couponNew.status, 'available')
  assert.equal(couponCare.status, 'used')

  assert.equal(relatedAll.data.pointLogs.length, 2)
  assert.equal(relatedAll.data.pointLogs[0].delta, 50)
  assert.equal(relatedAll.data.pointLogs[0].reason, '邀请好友奖励')

  assert.equal(relatedAll.data.addresses.length, 1)
  assert.equal(relatedAll.data.addresses[0].contactName, '张三')
  assert.ok(relatedAll.data.addresses[0].fullAddress.includes('阳光花园一期'))

  assert.equal(relatedAll.data.pets.length, 1)
  assert.equal(relatedAll.data.pets[0].name, '旺财')
  assert.equal(relatedAll.data.pets[0].species, '狗狗')

  assert.equal(relatedAll.data.commission.available, 18.5)
  assert.equal(relatedAll.data.commission.earnings.length, 3)
  assert.equal(relatedAll.data.commission.withdraws.length, 1)
  assert.equal(relatedAll.data.commission.expiredRecords.length, 1)
  assert.equal(relatedAll.data.commission.expiredRecords[0].amount, 5.0)

  // 3. 按单个分类查询 getUserRelatedDetails: coupons
  const couponsOnly = await fn.main({ module: 'admin', action: 'getUserRelatedDetails', data: { openid: 'target_user_openid', type: 'coupons' } })
  assert.equal(couponsOnly.ok, true)
  assert.equal(couponsOnly.data.coupons.length, 2)
  assert.equal(couponsOnly.data.pointLogs, undefined)
})
