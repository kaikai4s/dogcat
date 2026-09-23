const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

// 强制模拟微信云开发 .get() 限制单次最多返回 100 条的真实行为
function cappedStore(initial = {}) {
  const db = createCollectionStore(initial)
  const origCollection = db.collection.bind(db)
  db.collection = (name) => {
    const query = origCollection(name)
    const origGet = query.get.bind(query)
    query.get = async () => {
      const res = await origGet()
      return { data: (res.data || []).slice(0, 100) }
    }
    return query
  }
  return db
}

test('1. order list and staff order list break 100-item ceiling with pagination', async () => {
  const clientOpenid = 'openid_client_1'
  const staffOpenid = 'openid_staff_1'

  // 创建 150 笔客户订单
  const clientOrders = Array.from({ length: 150 }, (_, i) => ({
    _id: `ord_${String(i + 1).padStart(4, '0')}`,
    orderNo: `ORD_${String(i + 1).padStart(4, '0')}`,
    clientOpenid,
    staffOpenid,
    petName: `Pet_${i + 1}`,
    serviceType: 'catsitter',
    serviceAddress: '上海市浦东新区某路',
    status: 'completed',
    startTime: `2026-09-01 10:00`,
    createdAt: `2026-09-01 10:00:${String(i % 60).padStart(2, '0')}`
  }))

  const db = cappedStore({
    users: [
      { _id: 'u_client', openid: clientOpenid, roles: ['client'], activeRole: 'client', status: 'active' },
      { _id: 'u_staff', openid: staffOpenid, roles: ['staff'], activeRole: 'staff', status: 'active' }
    ],
    staff_profiles: [
      { _id: 'sp_1', openid: staffOpenid, realName: '测试托师', status: 'active' }
    ],
    orders: clientOrders
  })

  const clientFn = loadCloudFunction('api', db, clientOpenid)
  const staffFn = loadCloudFunction('api', db, staffOpenid)

  // 客户查列表第 1 页
  const clientRes = await clientFn.main({
    module: 'order',
    action: 'listOrders',
    data: { page: 1, pageSize: 20 }
  })
  assert.equal(clientRes.data.total, 150, '客户订单总数应准确为 150，未被 100 截断')
  assert.equal(clientRes.data.list.length, 20)
  assert.equal(clientRes.data.hasMore, true)

  // 宠托师查列表第 1 页
  const staffRes = await staffFn.main({
    module: 'staff',
    action: 'listStaffOrders',
    data: { page: 1, pageSize: 20 }
  })
  assert.equal(staffRes.data.total, 150, '宠托师订单总数应准确为 150，未被 100 截断')
  assert.equal(staffRes.data.list.length, 20)
  assert.equal(staffRes.data.hasMore, true)
})

test('2. admin count checks do not lock out admin deletion when user count > 100', async () => {
  // 120 个普通用户 + 2 个管理员（老管理员排在最前头，新管理员在最后）
  const users = [
    { _id: 'u_admin_old', openid: 'admin_old', roles: ['admin', 'client'], status: 'active' },
    ...Array.from({ length: 120 }, (_, i) => ({
      _id: `u_user_${i + 1}`,
      openid: `user_${i + 1}`,
      roles: ['client'],
      status: 'active'
    })),
    { _id: 'u_admin_new', openid: 'admin_new', roles: ['admin', 'client'], status: 'active' }
  ]

  const db = cappedStore({ users })
  const createContext = require('../../cloudfunctions/api/services/context')
  const createAdminUsersService = require('../../cloudfunctions/api/services/adminUsers')
  const ctx = createContext({ db, cloud: {} })
  const adminUsers = createAdminUsersService(ctx)

  // 有两个有效管理员时，允许降级其中一个管理员
  const targetAdmin = { openid: 'admin_new', roles: ['admin', 'client'] }
  await assert.doesNotReject(async () => {
    await adminUsers.assertAdminRoleChangeAllowed(targetAdmin, ['client'], 'admin_old')
  }, '有两个管理员时允许降级其中一个')

  // 若将另一个老管理员标记为 deleted，此时只剩 1 个管理员，尝试降级该管理员必须报错
  db.state.users.find(u => u._id === 'u_admin_old').status = 'deleted'
  await assert.rejects(async () => {
    await adminUsers.assertAdminRoleChangeAllowed(targetAdmin, ['client'], 'admin_old')
  }, /至少保留一个管理员/)
})

test('3. membership level rename and recalculation batch updates all users > 100', async () => {
  const users = Array.from({ length: 125 }, (_, i) => ({
    _id: `u_${i + 1}`,
    openid: `openid_${i + 1}`,
    memberLevel: 'lvl_gold',
    memberLevelName: '原黄金会员',
    totalPoints: 500,
    roles: ['client'],
    status: 'active'
  }))

  const db = cappedStore({
    users,
    member_levels: [
      { _id: 'lvl_gold', name: '原黄金会员', minPoints: 100, isDefault: false, status: 'active' },
      { _id: 'lvl_default', name: '普通会员', minPoints: 0, isDefault: true, status: 'active' }
    ]
  })

  const createContext = require('../../cloudfunctions/api/services/context')
  const createMembershipService = require('../../cloudfunctions/api/services/membership')
  const ctx = createContext({ db, cloud: {} })
  const membership = createMembershipService(ctx)

  // 同步新等级名称
  await membership.syncUsersMemberLevelName('lvl_gold', '尊贵黄金VIP')
  assert.ok(db.state.users.every(u => u.memberLevelName === '尊贵黄金VIP'), '所有用户等级名称统一更新')

  // 删除等级重算
  await membership.recalcUsersForDeletedLevel('lvl_gold')
  assert.ok(db.state.users.every(u => u.memberLevel === 'lvl_gold'), '用户根据积分重新匹配正确等级')
})

test('4. admin notifications markAdminNotificationRead processes > 100 unread records', async () => {
  const adminOpenid = 'admin_notification_test'
  const notifications = Array.from({ length: 130 }, (_, i) => ({
    _id: `notif_${String(i + 1).padStart(4, '0')}`,
    type: 'order_timeout',
    title: `测试通知_${i + 1}`,
    read: false,
    readBy: [],
    createdAt: '2026-09-01 12:00:00'
  }))

  const db = cappedStore({
    users: [{ _id: 'u_admin', openid: adminOpenid, roles: ['admin'], status: 'active' }],
    admin_notifications: notifications
  })

  const createContext = require('../../cloudfunctions/api/services/context')
  const createAdminNotifications = require('../../cloudfunctions/api/services/adminNotifications')
  const ctx = createContext({ db, cloud: {} })
  const adminNotifications = createAdminNotifications(ctx)

  // 一键全部已读
  const res = await adminNotifications.markAdminNotificationRead({ all: true }, adminOpenid)
  assert.equal(res.count, 130, '全部 130 条通知都被标为已读')
  assert.ok(db.state.admin_notifications.every(n => n.read === true), '所有通知状态均为 read: true')

  // 角标统计
  const badgeRes = await adminNotifications.getAdminNotificationBadge(adminOpenid)
  assert.equal(badgeRes.unreadCount, 0, '未读数清零')
})

test('5. penalty evidences list returns total > 100 in admin handler', async () => {
  const adminOpenid = 'admin_penalty_test'
  const evidences = Array.from({ length: 120 }, (_, i) => ({
    _id: `ev_${String(i + 1).padStart(4, '0')}`,
    orderId: `ord_${i + 1}`,
    orderNo: `ORD_${i + 1}`,
    staffOpenid: 'staff_1',
    reasonType: 'late',
    deductAmount: 20,
    status: 'pending',
    createdAt: '2026-09-01 10:00:00'
  }))

  const db = cappedStore({
    users: [{ _id: 'u_admin', openid: adminOpenid, roles: ['admin'], status: 'active' }],
    staff_deposit_evidences: evidences
  })

  const adminFn = loadCloudFunction('api', db, adminOpenid)
  const res = await adminFn.main({
    module: 'admin',
    action: 'listOrderDepositPenaltyEvidences',
    data: { page: 1, pageSize: 20 }
  })

  assert.equal(res.data.total, 120, '违规扣款凭证总数正确返回 120')
  assert.equal(res.data.list.length, 20)
  assert.equal(res.data.hasMore, true)
})

test('6. overdue order monitor scans > 100 active orders without omission', async () => {
  const nowStr = '2026-09-20 12:00:00'
  // 创建 120 笔超期未出发待处理订单（都在 7 天活跃窗口内，但开始时间早于当前时间且超期 30 分钟）
  const orders = Array.from({ length: 120 }, (_, i) => ({
    _id: `ord_${String(i + 1).padStart(4, '0')}`,
    orderNo: `ORD_${String(i + 1).padStart(4, '0')}`,
    status: 'assigned',
    staffOpenid: `staff_${i + 1}`,
    clientOpenid: `client_${i + 1}`,
    startTime: '2026-09-20 10:00',
    createdAt: '2026-09-18 10:00:00'
  }))

  const db = cappedStore({
    orders,
    admin_notifications: []
  })

  const createContext = require('../../cloudfunctions/api/services/context')
  const createOverdueOrdersService = require('../../cloudfunctions/api/services/overdueOrders')
  const ctx = createContext({
    db,
    cloud: {},
    now: () => nowStr
  })
  const overdueService = createOverdueOrdersService(ctx)

  const processed = await overdueService.processOverdueUnstartedOrders(nowStr)
  assert.equal(processed.length, 120, '全部 120 笔超期订单均被扫描处理')
})

test('7. reward mail unread count and list correctly retrieves > 100 mails', async () => {
  const userOpenid = 'openid_mail_user'
  const mails = Array.from({ length: 120 }, (_, i) => ({
    _id: `mail_${String(i + 1).padStart(4, '0')}`,
    openid: userOpenid,
    title: `福利邮件_${i + 1}`,
    status: 'sent',
    createdAt: '2026-09-01 10:00:00'
  }))

  const db = cappedStore({
    users: [{ _id: 'u_user', openid: userOpenid, roles: ['client'], status: 'active' }],
    reward_mails: mails
  })

  const mailFn = loadCloudFunction('api', db, userOpenid)

  const unreadRes = await mailFn.main({
    module: 'rewardMail',
    action: 'getUnreadCount'
  })
  assert.equal(unreadRes.data.unreadCount, 120, '未读邮件数量准确为 120')
  assert.equal(unreadRes.data.unclaimedCount, 120, '未领邮件数量准确为 120')

  const listRes = await mailFn.main({
    module: 'rewardMail',
    action: 'listMyMails',
    data: { page: 1, pageSize: 50 }
  })
  assert.equal(listRes.data.total, 120, '邮件列表总数准确为 120')
  assert.equal(listRes.data.list.length, 50)
  assert.equal(listRes.data.hasMore, true)
})

test('8. staff personal reviews list returns > 100 reviews with masking', async () => {
  const staffOpenid = 'openid_staff_review_test'
  const profileId = 'sp_review_test'
  const reviews = Array.from({ length: 120 }, (_, i) => ({
    _id: `rev_${String(i + 1).padStart(4, '0')}`,
    staffProfileId: profileId,
    status: 'visible',
    rating: 5,
    clientName: `张三_${i + 1}`,
    comment: '服务非常好！',
    createdAt: '2026-09-01 10:00:00'
  }))

  const db = cappedStore({
    users: [{ _id: 'u_staff', openid: staffOpenid, roles: ['staff'], status: 'active' }],
    staff_profiles: [{ _id: profileId, openid: staffOpenid, realName: '评价托师', status: 'approved' }],
    service_reviews: reviews
  })

  const staffFn = loadCloudFunction('api', db, staffOpenid)
  const res = await staffFn.main({
    module: 'staff',
    action: 'listStaffReviews',
    data: { staffOpenid }
  })

  assert.equal(res.data.length, 120, '返回全部 120 条评价')
  assert.ok(res.data[0].clientName.startsWith('张*'), '客户姓名已做脱敏')
})
