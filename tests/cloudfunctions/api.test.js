const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('api dispatches auth login through unified cloud function', async () => {
  const db = createCollectionStore({ users: [] })
  const fn = loadCloudFunction('api', db, 'openid_1')

  const result = await fn.main({ module: 'auth', action: 'login' })

  assert.equal(result.ok, true)
  assert.equal(result.data.openid, 'openid_1')
  assert.deepEqual(result.data.roles, ['client'])
})

test('auth loginByPhoneCode creates user with verified phone', async () => {
  const db = createCollectionStore({ users: [] })
  const fn = loadCloudFunction('api', db, 'openid_phone')

  const result = await fn.main({ module: 'auth', action: 'loginByPhoneCode', data: { code: 'phone_code' } })

  assert.equal(result.ok, true)
  assert.equal(result.data.openid, 'openid_phone')
  assert.equal(result.data.phone, '19900006302')
  assert.equal(db.state.users[0].phone, '19900006302')
})

test('guest can browse approved sitters', async () => {
  const db = createCollectionStore({
    users: [],
    staff_profiles: [
      { _id: 's1', openid: 'staff_openid', auditStatus: 'approved', realName: '王小明', serviceCity: '上海', serviceAreas: '浦东,徐汇', updatedAt: '2026-07-28' },
      { _id: 's2', openid: 'staff_pending', auditStatus: 'pending', realName: '李小明', serviceCity: '上海', serviceAreas: '静安' }
    ]
  })
  const fn = loadCloudFunction('api', db, 'guest_openid')

  const result = await fn.main({ module: 'staff', action: 'listApprovedSitters', data: { pageSize: 50 } })

  assert.equal(result.ok, true)
  assert.equal(result.data.total, 1)
  assert.equal(result.data.list[0]._id, 's1')
  assert.equal(result.data.list[0].displayName, '王* 宠托师')
})

test('guest can view public sitter detail without favorite state', async () => {
  const db = createCollectionStore({
    users: [],
    staff_profiles: [{ _id: 's1', openid: 'staff_openid', auditStatus: 'approved', realName: '王小明', serviceCity: '上海', serviceAreas: '浦东', updatedAt: '2026-07-28' }],
    service_reviews: [],
    sitter_favorites: [{ _id: 'f1', openid: 'guest_openid', staffProfileId: 's1' }]
  })
  const fn = loadCloudFunction('api', db, 'guest_openid')

  const result = await fn.main({ module: 'staff', action: 'getPublicSitterDetail', data: { staffProfileId: 's1' } })

  assert.equal(result.ok, true)
  assert.equal(result.data._id, 's1')
  assert.equal(result.data.favorite, false)
})

test('guest cannot favorite sitters or create orders', async () => {
  const db = createCollectionStore({
    users: [],
    staff_profiles: [{ _id: 's1', openid: 'staff_openid', auditStatus: 'approved', realName: '王小明' }],
    sitter_favorites: [],
    orders: []
  })
  const fn = loadCloudFunction('api', db, 'guest_openid')

  const favorite = await fn.main({ module: 'staff', action: 'favoriteSitter', data: { staffProfileId: 's1' } })
  const order = await fn.main({ module: 'order', action: 'createOrder', data: { petId: 'p1' } })

  assert.equal(favorite.ok, false)
  assert.equal(favorite.message, '请先登录')
  assert.equal(order.ok, false)
  assert.equal(order.message, '请先登录')
})

test('api dispatches order createOrder through unified cloud function', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active' }],
    pets: [{ _id: 'p1', openid: 'openid_client', name: '可乐', weight: 12 }],
    orders: [],
    user_addresses: []
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const result = await fn.main({
    module: 'order',
    action: 'createOrder',
    data: {
      petId: 'p1',
      serviceTypes: ['walk'],
      serviceAddress: '测试地址',
      addressDetail: '3栋2单元',
      doorplate: '1802',
      startTime: '2026-07-28 10:00',
      endTime: '2026-07-28 11:00',
      durationMinutes: 60,
      saveAddress: true
    }
  })

  assert.equal(result.ok, true)
  assert.equal(result.data.status, 'pending_pay')
  assert.equal(db.state.orders.length, 1)
  assert.equal(db.state.user_addresses.length, 1)
  assert.equal(db.state.user_addresses[0].openid, 'openid_client')
  assert.equal(db.state.user_addresses[0].isDefault, true)
})

test('auth updateProfile saves editable nickname avatar and phone', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active', nickname: '旧昵称', avatarUrl: '', phone: '' }]
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const result = await fn.main({ module: 'auth', action: 'updateProfile', data: { nickname: '豆豆家长', avatarUrl: 'cloud://avatar', phone: '13800000000' } })

  assert.equal(result.ok, true)
  assert.equal(result.data.nickname, '豆豆家长')
  assert.equal(result.data.avatarUrl, 'cloud://avatar')
  assert.equal(db.state.users[0].phone, '13800000000')
})

test('pet profile stores photo birthday breed and AI interaction fields', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active' }],
    pets: []
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const created = await fn.main({
    module: 'pet',
    action: 'createPet',
    data: {
      name: '可乐',
      avatarFileId: 'cloud://pet-photo',
      species: 'dog',
      breed: '金毛',
      gender: '弟弟',
      birthday: '2024-05-01',
      weight: 12,
      personality: '活泼粘人',
      favoriteFood: '鸡胸肉',
      dislikes: '打雷',
      healthNotes: '无过敏',
      specialNotes: '出门需要牵引',
      aiInteractionEnabled: true,
      aiPersona: '可乐用第一视角和主人互动',
      aiGreeting: '我是可乐'
    }
  })
  const fetched = await fn.main({ module: 'pet', action: 'getPet', data: { id: created.data._id } })

  assert.equal(created.ok, true)
  assert.equal(fetched.data.avatarFileId, 'cloud://pet-photo')
  assert.equal(typeof fetched.data.createdAt, 'string')
  assert.equal(fetched.data.birthday, '2024-05-01')
  assert.equal(fetched.data.breed, '金毛')
  assert.equal(fetched.data.aiInteractionEnabled, true)
  assert.equal(fetched.data.aiGreeting, '我是可乐')
})

test('api quoteOrder supports multiple services and price details', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active' }],
    pets: [{ _id: 'p1', openid: 'openid_client', name: '可乐', weight: 12 }],
    service_prices: []
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const result = await fn.main({
    module: 'order',
    action: 'quoteOrder',
    data: { petId: 'p1', serviceTypes: ['walk', 'feed'], durationMinutes: 60 }
  })

  assert.equal(result.ok, true)
  assert.equal(result.data.payAmount, 148)
  assert.equal(result.data.serviceSummary, '上门遛狗、上门喂养')
  assert.deepEqual(result.data.priceItems.map((item) => item.key), ['walk', 'feed'])
})

test('api createOrder requires detailed address and doorplate', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active' }],
    pets: [{ _id: 'p1', openid: 'openid_client', name: '可乐', weight: 12 }],
    orders: []
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const result = await fn.main({
    module: 'order',
    action: 'createOrder',
    data: {
      petId: 'p1',
      serviceTypes: ['feed'],
      serviceAddress: '测试小区',
      startTime: '2026-07-28 10:00',
      endTime: '2026-07-28 11:00',
      durationMinutes: 60
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.message, '请填写详细地址')
})

test('api createOrder stores compatible and extended service fields', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active' }],
    pets: [{ _id: 'p1', openid: 'openid_client', name: '可乐', weight: 8 }],
    orders: []
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const result = await fn.main({
    module: 'order',
    action: 'createOrder',
    data: {
      petId: 'p1',
      serviceTypes: ['feed', 'litter'],
      serviceAddress: '测试小区',
      addressDetail: '1栋101',
      doorplate: '101',
      startTime: '2026-07-28 10:00',
      endTime: '2026-07-28 11:00',
      durationMinutes: 60
    }
  })

  assert.equal(result.ok, true)
  assert.equal(result.data.serviceType, 'feed')
  assert.deepEqual(result.data.serviceTypes, ['feed', 'litter'])
  assert.equal(result.data.serviceSummary, '上门喂养、清理宠物厕所')
  assert.equal(result.data.addressDetail, '1栋101')
  assert.equal(result.data.doorplate, '101')
  assert.equal(result.data.durationMinutes, 60)
})

test('admin can save and public can read system settings', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' }],
    platform_configs: [],
    admin_operation_logs: []
  })
  const adminFn = loadCloudFunction('api', db, 'openid_admin')
  const guestFn = loadCloudFunction('api', db, 'openid_guest')

  const saved = await adminFn.main({ module: 'admin', action: 'saveSystemSettings', data: { enableTestAddressMode: true } })
  const fetched = await guestFn.main({ module: 'system', action: 'getSettings' })

  assert.equal(saved.ok, true)
  assert.equal(saved.data.enableTestAddressMode, true)
  assert.equal(fetched.ok, true)
  assert.equal(fetched.data.enableTestAddressMode, true)
})

test('admin dashboard includes monthly order and registration trends', async () => {
  const nowDate = new Date()
  const monthKey = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, '0')}`
  const makeDate = (day) => `${monthKey}-${String(day).padStart(2, '0')} 10:00:00`
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active', createdAt: makeDate(1) },
      { _id: 'client_a', openid: 'openid_client_a', roles: ['client'], status: 'active', createdAt: makeDate(2) },
      { _id: 'client_b', openid: 'openid_client_b', roles: ['client'], status: 'active', createdAt: '2020-01-01 10:00:00' }
    ],
    orders: [
      { _id: 'o1', status: 'paid', paymentStatus: 'paid', payAmount: 88, createdAt: makeDate(2), paidAt: makeDate(2) },
      { _id: 'o2', status: 'in_service', paymentStatus: 'paid', payAmount: 128, createdAt: makeDate(2), paidAt: makeDate(3) },
      { _id: 'o3', status: 'completed', paymentStatus: 'paid', payAmount: 68, createdAt: '2020-01-01 10:00:00', paidAt: '2020-01-01 10:00:00' }
    ],
    staff_profiles: [{ _id: 'sp1', auditStatus: 'pending' }],
    order_incidents: [{ _id: 'i1', status: 'open' }]
  })
  const fn = loadCloudFunction('api', db, 'openid_admin')

  const result = await fn.main({ module: 'admin', action: 'dashboard', data: {} })

  assert.equal(result.ok, true)
  assert.equal(result.data.orders.paid, 1)
  assert.equal(result.data.orders.in_service, 1)
  assert.equal(result.data.staffPending, 1)
  assert.equal(result.data.incidentsOpen, 1)
  assert.equal(result.data.monthly.monthKey, monthKey)
  assert.equal(result.data.monthly.totals.orders, 2)
  assert.equal(result.data.monthly.totals.registrations, 2)
  assert.equal(result.data.monthly.totals.revenue, 216)
  assert.equal(result.data.monthly.totals.paidOrders, 2)
  assert.equal(result.data.monthly.totals.averageOrderValue, 108)
  assert.equal(result.data.monthly.days[1].orders, 2)
  assert.equal(result.data.monthly.days[1].registrations, 1)
  assert.equal(result.data.monthly.days[1].revenue, 88)
  assert.equal(result.data.monthly.days[2].revenue, 128)
  assert.ok(result.data.monthly.days[1].orderHeight > 0)
  assert.ok(result.data.monthly.days[2].revenueHeight > 0)
})

test('admin listUsers supports role status and keyword filters', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active', nickname: '后台管理员', phone: '13000000000', createdAt: '2026-08-03' },
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', nickname: '豆豆家长', phone: '13800000000', memberLevelName: '银卡会员', points: 20, totalPoints: 100, createdAt: '2026-08-02' },
      { _id: 'staff', openid: 'openid_staff', roles: ['client', 'staff'], status: 'disabled', nickname: '宠托姐姐', phone: '13900000000', createdAt: '2026-08-01' }
    ]
  })
  const fn = loadCloudFunction('api', db, 'openid_admin')

  const staffResult = await fn.main({ module: 'admin', action: 'listUsers', data: { role: 'staff' } })
  const keywordResult = await fn.main({ module: 'admin', action: 'listUsers', data: { keyword: '豆豆' } })
  const disabledResult = await fn.main({ module: 'admin', action: 'listUsers', data: { status: 'disabled' } })

  assert.equal(staffResult.ok, true)
  assert.deepEqual(staffResult.data.map((user) => user.openid), ['openid_staff'])
  assert.deepEqual(keywordResult.data.map((user) => user.openid), ['openid_client'])
  assert.equal(keywordResult.data[0].memberLevelName, '银卡会员')
  assert.deepEqual(disabledResult.data.map((user) => user.openid), ['openid_staff'])
})

test('admin listStaffProfiles filters status and attaches user display fields', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' },
      { _id: 'staff', openid: 'openid_staff', roles: ['client', 'staff'], status: 'active', nickname: '豆豆姐姐', avatarUrl: 'cloud://avatar', phone: '13800000000' }
    ],
    staff_profiles: [
      { _id: 'sp1', openid: 'openid_staff', realName: '王小花', phone: '', serviceCity: '上海', serviceAreas: '浦东', auditStatus: 'approved', updatedAt: '2026-08-03' },
      { _id: 'sp2', openid: 'openid_pending', realName: '李小狗', phone: '13900000000', serviceCity: '杭州', serviceAreas: '西湖', auditStatus: 'pending', updatedAt: '2026-08-02' }
    ]
  })
  const fn = loadCloudFunction('api', db, 'openid_admin')

  const approvedResult = await fn.main({ module: 'admin', action: 'listStaffProfiles', data: { auditStatus: 'approved' } })
  const keywordResult = await fn.main({ module: 'admin', action: 'listStaffProfiles', data: { keyword: '豆豆' } })

  assert.equal(approvedResult.ok, true)
  assert.deepEqual(approvedResult.data.map((profile) => profile._id), ['sp1'])
  assert.equal(approvedResult.data[0].phone, '13800000000')
  assert.equal(approvedResult.data[0].userNickname, '豆豆姐姐')
  assert.equal(approvedResult.data[0].auditStatusText, '已通过')
  assert.deepEqual(keywordResult.data.map((profile) => profile._id), ['sp1'])
})

test('admin can list grant and revoke admin roles safely', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], activeRole: 'admin', status: 'active', nickname: '当前管理员' },
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', nickname: '豆豆家长' },
      { _id: 'other_admin', openid: 'openid_other_admin', roles: ['client', 'admin'], activeRole: 'admin', status: 'active', nickname: '备用管理员' }
    ],
    admin_operation_logs: []
  })
  const fn = loadCloudFunction('api', db, 'openid_admin')

  const listResult = await fn.main({ module: 'admin', action: 'listAdmins', data: {} })
  const grantResult = await fn.main({ module: 'admin', action: 'grantAdmin', data: { openid: 'openid_client' } })
  const revokeResult = await fn.main({ module: 'admin', action: 'revokeAdmin', data: { openid: 'openid_other_admin' } })
  const selfRevokeResult = await fn.main({ module: 'admin', action: 'revokeAdmin', data: { openid: 'openid_admin' } })

  assert.equal(listResult.ok, true)
  assert.equal(listResult.data.find((user) => user.openid === 'openid_admin').isSelf, true)
  assert.equal(grantResult.ok, true)
  assert.deepEqual(db.state.users.find((user) => user._id === 'client').roles, ['client', 'admin'])
  assert.equal(revokeResult.ok, true)
  assert.deepEqual(db.state.users.find((user) => user._id === 'other_admin').roles, ['client'])
  assert.equal(db.state.users.find((user) => user._id === 'other_admin').activeRole, 'client')
  assert.equal(selfRevokeResult.ok, false)
  assert.equal(selfRevokeResult.message, '不能移除自己的管理员权限')
  assert.equal(db.state.admin_operation_logs.length, 2)
})

test('admin revokeAdmin keeps at least one administrator', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' },
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active' }
    ],
    admin_operation_logs: []
  })
  const fn = loadCloudFunction('api', db, 'openid_admin')

  const result = await fn.main({ module: 'admin', action: 'revokeAdmin', data: { openid: 'openid_client' } })

  assert.equal(result.ok, false)
  assert.equal(result.message, '至少保留一个管理员')
})

test('admin can manage service prices and quote uses configured price', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' },
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active' }
    ],
    pets: [{ _id: 'p1', openid: 'openid_client', name: '可乐', weight: 8 }],
    service_prices: [],
    admin_operation_logs: []
  })
  const adminFn = loadCloudFunction('api', db, 'openid_admin')
  const clientFn = loadCloudFunction('api', db, 'openid_client')

  const listResult = await adminFn.main({ module: 'admin', action: 'listServicePrices' })
  const saveResult = await adminFn.main({ module: 'admin', action: 'saveServicePrice', data: { key: 'feed', price: 88, enabled: true } })
  const quoteResult = await clientFn.main({ module: 'order', action: 'quoteOrder', data: { petId: 'p1', serviceTypes: ['feed'], durationMinutes: 60 } })

  assert.equal(listResult.ok, true)
  assert.ok(listResult.data.some((item) => item.key === 'walk'))
  assert.equal(saveResult.ok, true)
  assert.equal(quoteResult.ok, true)
  assert.equal(quoteResult.data.payAmount, 88)
})

test('non-admin cannot save service prices', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active' }],
    service_prices: []
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const result = await fn.main({ module: 'admin', action: 'saveServicePrice', data: { key: 'feed', price: 88 } })

  assert.equal(result.ok, false)
  assert.equal(result.message, '仅管理员可操作')
})

test('admin audit approval grants staff role', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' },
      { _id: 'staff', openid: 'openid_staff', roles: ['client'], status: 'active' }
    ],
    staff_profiles: [{ _id: 'sp1', openid: 'openid_staff', auditStatus: 'pending' }],
    admin_operation_logs: []
  })
  const fn = loadCloudFunction('api', db, 'openid_admin')

  const result = await fn.main({
    module: 'admin',
    action: 'auditStaff',
    data: { staffProfileId: 'sp1', auditStatus: 'approved' }
  })

  assert.equal(result.ok, true)
  assert.deepEqual(db.state.users.find((user) => user._id === 'staff').roles, ['client', 'staff'])
})

test('admin audit rejection removes staff role and returns active role to client', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' },
      { _id: 'staff', openid: 'openid_staff', roles: ['client', 'staff'], activeRole: 'staff', status: 'active' }
    ],
    staff_profiles: [{ _id: 'sp1', openid: 'openid_staff', auditStatus: 'approved' }],
    admin_operation_logs: []
  })
  const fn = loadCloudFunction('api', db, 'openid_admin')

  const result = await fn.main({
    module: 'admin',
    action: 'auditStaff',
    data: { staffProfileId: 'sp1', auditStatus: 'rejected', auditRemark: '资料不完整' }
  })
  const user = db.state.users.find((item) => item._id === 'staff')

  assert.equal(result.ok, true)
  assert.deepEqual(user.roles, ['client'])
  assert.equal(user.activeRole, 'client')
})

test('client can list only approved sitters with safe public fields', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active' }],
    staff_profiles: [
      { _id: 'sp1', userId: 'u1', openid: 'openid_staff_1', realName: '王小花', phone: '13800000000', serviceCity: '上海', serviceAreas: '浦东、徐汇', auditStatus: 'approved', auditRemark: 'ok', currentLatitude: 31.2, currentLongitude: 121.5, updatedAt: '2026-07-29 10:00' },
      { _id: 'sp2', userId: 'u2', openid: 'openid_staff_2', realName: '李小狗', phone: '13900000000', serviceCity: '北京', serviceAreas: '朝阳', auditStatus: 'pending', updatedAt: '2026-07-29 11:00' },
      { _id: 'sp3', userId: 'u3', openid: 'openid_staff_3', realName: '赵小猫', phone: '13700000000', serviceCity: '上海', serviceAreas: '静安', auditStatus: 'rejected', updatedAt: '2026-07-29 12:00' }
    ]
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const result = await fn.main({ module: 'staff', action: 'listApprovedSitters' })

  assert.equal(result.ok, true)
  assert.equal(result.data.total, 1)
  assert.equal(result.data.list[0]._id, 'sp1')
  assert.equal(result.data.list[0].displayName, '王* 宠托师')
  assert.deepEqual(result.data.list[0].areaTags, ['浦东', '徐汇'])
  assert.equal(Object.hasOwn(result.data.list[0], 'phone'), false)
  assert.equal(Object.hasOwn(result.data.list[0], 'openid'), false)
  assert.equal(Object.hasOwn(result.data.list[0], 'userId'), false)
  assert.equal(Object.hasOwn(result.data.list[0], 'currentLatitude'), false)
  assert.equal(Object.hasOwn(result.data.list[0], 'currentLongitude'), false)
  assert.equal(Object.hasOwn(result.data.list[0], 'auditRemark'), false)
})

test('client sitter list and detail display current nickname first', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active' },
      { _id: 'staff', openid: 'openid_staff', roles: ['client', 'staff'], status: 'active', nickname: '豆豆姐姐' }
    ],
    staff_profiles: [{ _id: 'sp1', openid: 'openid_staff', realName: '王小花', serviceCity: '上海', serviceAreas: '浦东', auditStatus: 'approved' }],
    service_reviews: [],
    sitter_favorites: []
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const listResult = await fn.main({ module: 'staff', action: 'listApprovedSitters' })
  const detailResult = await fn.main({ module: 'staff', action: 'getPublicSitterDetail', data: { staffProfileId: 'sp1' } })
  const keywordResult = await fn.main({ module: 'staff', action: 'listApprovedSitters', data: { keyword: '豆豆' } })

  assert.equal(listResult.ok, true)
  assert.equal(listResult.data.list[0].displayName, '豆豆姐姐')
  assert.equal(detailResult.data.displayName, '豆豆姐姐')
  assert.deepEqual(keywordResult.data.list.map((item) => item._id), ['sp1'])
})

test('client sitter list supports city area and keyword filters', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active' }],
    staff_profiles: [
      { _id: 'sp1', realName: '王小花', serviceCity: '上海', serviceAreas: '浦东、徐汇', auditStatus: 'approved', updatedAt: '2026-07-29 10:00' },
      { _id: 'sp2', realName: '陈小猫', serviceCity: '杭州', serviceAreas: '西湖,滨江', auditStatus: 'approved', updatedAt: '2026-07-29 11:00' },
      { _id: 'sp3', realName: '周小狗', serviceCity: '上海', serviceAreas: '静安', auditStatus: 'approved', updatedAt: '2026-07-29 12:00' }
    ]
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const cityResult = await fn.main({ module: 'staff', action: 'listApprovedSitters', data: { serviceCity: '上海', sortBy: 'city' } })
  const areaResult = await fn.main({ module: 'staff', action: 'listApprovedSitters', data: { serviceArea: '滨江' } })
  const keywordResult = await fn.main({ module: 'staff', action: 'listApprovedSitters', data: { keyword: '小狗' } })

  assert.equal(cityResult.ok, true)
  assert.deepEqual(cityResult.data.list.map((item) => item._id).sort(), ['sp1', 'sp3'])
  assert.deepEqual(areaResult.data.list.map((item) => item._id), ['sp2'])
  assert.deepEqual(keywordResult.data.list.map((item) => item._id), ['sp3'])
})

test('createOrder defaults to open publish mode', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active' }],
    pets: [{ _id: 'p1', openid: 'openid_client', name: '可乐', weight: 8 }],
    orders: []
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const result = await fn.main({
    module: 'order',
    action: 'createOrder',
    data: {
      petId: 'p1',
      serviceTypes: ['feed'],
      serviceAddress: '测试小区',
      addressDetail: '1栋101',
      doorplate: '101',
      startTime: '2026-07-28 10:00',
      endTime: '2026-07-28 11:00',
      durationMinutes: 60
    }
  })

  assert.equal(result.ok, true)
  assert.equal(result.data.publishMode, 'open')
  assert.equal(result.data.requestedStaffOpenid, '')
  assert.equal(result.data.assignmentSource, '')
})

test('direct createOrder requires approved sitter and keeps requested staff after payment', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active' },
      { _id: 'staff', openid: 'openid_staff', roles: ['client', 'staff'], status: 'active' },
      { _id: 'pending_staff', openid: 'openid_pending_staff', roles: ['client'], status: 'active' }
    ],
    pets: [{ _id: 'p1', openid: 'openid_client', name: '可乐', weight: 8 }],
    staff_profiles: [
      { _id: 'sp1', openid: 'openid_staff', realName: '王小花', serviceCity: '上海', serviceAreas: '浦东', auditStatus: 'approved' },
      { _id: 'sp2', openid: 'openid_pending_staff', realName: '李小狗', serviceCity: '上海', serviceAreas: '徐汇', auditStatus: 'pending' }
    ],
    orders: [],
    payments: []
  })
  const fn = loadCloudFunction('api', db, 'openid_client')
  const baseData = {
    petId: 'p1',
    serviceTypes: ['feed'],
    serviceAddress: '测试小区',
    addressDetail: '1栋101',
    doorplate: '101',
    startTime: '2026-07-28 10:00',
    endTime: '2026-07-28 11:00',
    durationMinutes: 60,
    publishMode: 'direct'
  }

  const missingResult = await fn.main({ module: 'order', action: 'createOrder', data: baseData })
  const pendingResult = await fn.main({ module: 'order', action: 'createOrder', data: { ...baseData, staffProfileId: 'sp2' } })
  const result = await fn.main({ module: 'order', action: 'createOrder', data: { ...baseData, staffProfileId: 'sp1' } })
  const payResult = await fn.main({ module: 'payment', action: 'mockPayOrder', data: { orderId: result.data._id } })
  const stored = db.state.orders.find((order) => order._id === result.data._id)

  assert.equal(missingResult.ok, false)
  assert.equal(missingResult.message, '请选择指定宠托师')
  assert.equal(pendingResult.ok, false)
  assert.equal(pendingResult.message, '指定宠托师未审核通过')
  assert.equal(result.ok, true)
  assert.equal(result.data.publishMode, 'direct')
  assert.equal(result.data.requestedStaffProfileId, 'sp1')
  assert.equal(result.data.requestedStaffUserId, 'staff')
  assert.equal(result.data.requestedStaffOpenid, 'openid_staff')
  assert.equal(result.data.requestedStaffName, '王* 宠托师')
  assert.equal(payResult.ok, true)
  assert.equal(stored.status, 'paid')
  assert.equal(stored.requestedStaffOpenid, 'openid_staff')
})

test('staff visibility and accept permissions respect open and direct publish modes', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'staff_a', openid: 'openid_staff_a', roles: ['client', 'staff'], status: 'active' },
      { _id: 'staff_b', openid: 'openid_staff_b', roles: ['client', 'staff'], status: 'active' }
    ],
    staff_profiles: [
      { _id: 'sp_a', openid: 'openid_staff_a', auditStatus: 'approved', serviceAddress: '基准服务地址', serviceLatitude: 31.2, serviceLongitude: 121.5, currentLatitude: 31.2, currentLongitude: 121.5 },
      { _id: 'sp_b', openid: 'openid_staff_b', auditStatus: 'approved', serviceAddress: '基准服务地址', serviceLatitude: 31.2, serviceLongitude: 121.5, currentLatitude: 31.2, currentLongitude: 121.5 }
    ],
    pets: [{ _id: 'pet1', openid: 'openid_client', name: '可乐', breed: '金毛', weight: 12, birthday: '2024-05-01', personality: '活泼' }],
    orders: [
      { _id: 'open_order', petId: 'pet1', petName: '可乐', status: 'paid', publishMode: 'open', staffOpenid: '', requestedStaffOpenid: '', startTime: '2026-07-28 10:00', addressLatitude: 31.2, addressLongitude: 121.5 },
      { _id: 'direct_order', petId: 'pet1', petName: '可乐', status: 'paid', publishMode: 'direct', staffOpenid: '', requestedStaffOpenid: 'openid_staff_a', startTime: '2026-07-28 11:00', addressLatitude: 31.2, addressLongitude: 121.5 }
    ]
  })
  const staffAFn = loadCloudFunction('api', db, 'openid_staff_a')
  const staffBFn = loadCloudFunction('api', db, 'openid_staff_b')

  const nearbyResult = await staffAFn.main({ module: 'staff', action: 'listNearbyOrders', data: { latitude: 31.2, longitude: 121.5 } })
  const directResult = await staffAFn.main({ module: 'staff', action: 'listDirectOrders' })
  const openDetailResult = await staffAFn.main({ module: 'order', action: 'getOrderDetail', data: { id: 'open_order' } })
  const directDetailResult = await staffAFn.main({ module: 'order', action: 'getOrderDetail', data: { id: 'direct_order' } })
  const deniedDetailResult = await staffBFn.main({ module: 'order', action: 'getOrderDetail', data: { id: 'direct_order' } })
  const deniedResult = await staffBFn.main({ module: 'staff', action: 'acceptOrder', data: { orderId: 'direct_order' } })
  const directAcceptResult = await staffAFn.main({ module: 'staff', action: 'acceptOrder', data: { orderId: 'direct_order' } })
  const openAcceptResult = await staffBFn.main({ module: 'staff', action: 'acceptOrder', data: { orderId: 'open_order' } })

  assert.equal(nearbyResult.ok, true)
  assert.deepEqual(nearbyResult.data.map((order) => order._id), ['open_order'])
  assert.equal(directResult.ok, true)
  assert.deepEqual(directResult.data.map((order) => order._id), ['direct_order'])
  assert.equal(directResult.data[0].distanceText, '0m')
  assert.equal(openDetailResult.ok, true)
  assert.equal(openDetailResult.data.petSnapshot.breed, '金毛')
  assert.equal(directDetailResult.ok, true)
  assert.equal(directDetailResult.data.petSnapshot.personality, '活泼')
  assert.equal(deniedDetailResult.ok, false)
  assert.equal(deniedDetailResult.message, '无权访问订单')
  assert.equal(deniedResult.ok, false)
  assert.equal(deniedResult.message, '该订单指定了其他宠托师')
  assert.equal(directAcceptResult.ok, true)
  assert.equal(db.state.orders.find((order) => order._id === 'direct_order').assignmentSource, 'direct_accept')
  assert.equal(openAcceptResult.ok, true)
  assert.equal(db.state.orders.find((order) => order._id === 'open_order').assignmentSource, 'open_grab')
})

test('admin assignOrder writes staff profile and admin assignment source', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' },
      { _id: 'staff', openid: 'openid_staff', roles: ['client', 'staff'], status: 'active' }
    ],
    staff_profiles: [{ _id: 'sp1', openid: 'openid_staff', auditStatus: 'approved' }],
    orders: [{ _id: 'order1', status: 'paid', publishMode: 'direct', requestedStaffOpenid: 'other_staff', staffOpenid: '' }],
    admin_operation_logs: []
  })
  const fn = loadCloudFunction('api', db, 'openid_admin')

  const result = await fn.main({ module: 'admin', action: 'assignOrder', data: { orderId: 'order1', staffProfileId: 'sp1' } })
  const order = db.state.orders.find((item) => item._id === 'order1')

  assert.equal(result.ok, true)
  assert.equal(order.staffUserId, 'staff')
  assert.equal(order.staffOpenid, 'openid_staff')
  assert.equal(order.staffProfileId, 'sp1')
  assert.equal(order.assignmentSource, 'admin_assign')
})

test('client can favorite and list approved sitters without private fields', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active' }],
    staff_profiles: [{ _id: 'sp1', openid: 'openid_staff', realName: '王小花', phone: '13800000000', auditStatus: 'approved', serviceCity: '上海', serviceAreas: '浦东' }],
    sitter_favorites: [],
    service_reviews: []
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const favoriteResult = await fn.main({ module: 'staff', action: 'favoriteSitter', data: { staffProfileId: 'sp1' } })
  const detailResult = await fn.main({ module: 'staff', action: 'getPublicSitterDetail', data: { staffProfileId: 'sp1' } })
  const listResult = await fn.main({ module: 'staff', action: 'listFavoriteSitters' })
  const unfavoriteResult = await fn.main({ module: 'staff', action: 'unfavoriteSitter', data: { staffProfileId: 'sp1' } })

  assert.equal(favoriteResult.ok, true)
  assert.equal(detailResult.data.favorite, true)
  assert.equal(detailResult.data.displayName, '王* 宠托师')
  assert.equal(Object.hasOwn(detailResult.data, 'phone'), false)
  assert.equal(listResult.data.length, 1)
  assert.equal(listResult.data[0]._id, 'sp1')
  assert.equal(unfavoriteResult.data.favorite, false)
  assert.equal(db.state.sitter_favorites.length, 0)
})

test('client address CRUD is scoped to owner and default is unique', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active' },
      { _id: 'other', openid: 'openid_other', roles: ['client'], status: 'active' }
    ],
    user_addresses: [{ _id: 'other_addr', openid: 'openid_other', serviceAddress: '别人小区', addressDetail: '1栋', doorplate: '101', isDefault: true, updatedAt: '2026-07-29 09:00' }]
  })
  const clientFn = loadCloudFunction('api', db, 'openid_client')
  const otherFn = loadCloudFunction('api', db, 'openid_other')

  const first = await clientFn.main({ module: 'client', action: 'saveAddress', data: { label: '家', serviceAddress: '测试小区', addressDetail: '1栋', doorplate: '101' } })
  const second = await clientFn.main({ module: 'client', action: 'saveAddress', data: { label: '公司', serviceAddress: '办公楼', addressDetail: '2栋', doorplate: '202', isDefault: true } })
  const denied = await clientFn.main({ module: 'client', action: 'deleteAddress', data: { id: 'other_addr' } })
  const list = await clientFn.main({ module: 'client', action: 'listAddresses' })
  const remove = await otherFn.main({ module: 'client', action: 'deleteAddress', data: { id: 'other_addr' } })

  assert.equal(first.ok, true)
  assert.equal(first.data.isDefault, true)
  assert.equal(second.ok, true)
  assert.equal(db.state.user_addresses.find((item) => item._id === first.data._id).isDefault, false)
  assert.equal(db.state.user_addresses.find((item) => item._id === second.data._id).isDefault, true)
  assert.equal(denied.ok, false)
  assert.equal(denied.message, '无权操作地址')
  assert.equal(list.data.length, 2)
  assert.equal(remove.ok, true)
})

test('rebook template is owner-only and preserves direct sitter only when approved', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active' },
      { _id: 'other', openid: 'openid_other', roles: ['client'], status: 'active' }
    ],
    staff_profiles: [{ _id: 'sp1', openid: 'openid_staff', auditStatus: 'approved' }],
    orders: [{ _id: 'order1', clientOpenid: 'openid_client', petId: 'p1', serviceType: 'feed', serviceTypes: ['feed', 'litter'], serviceAddress: '测试小区', addressDetail: '1栋', doorplate: '101', addressLatitude: 31.2, addressLongitude: 121.5, durationMinutes: 90, publishMode: 'direct', requestedStaffProfileId: 'sp1', status: 'completed' }]
  })
  const clientFn = loadCloudFunction('api', db, 'openid_client')
  const otherFn = loadCloudFunction('api', db, 'openid_other')

  const result = await clientFn.main({ module: 'order', action: 'prepareRebook', data: { orderId: 'order1' } })
  const denied = await otherFn.main({ module: 'order', action: 'prepareRebook', data: { orderId: 'order1' } })

  assert.equal(result.ok, true)
  assert.equal(result.data.sourceOrderId, 'order1')
  assert.deepEqual(result.data.serviceTypes, ['feed', 'litter'])
  assert.equal(result.data.publishMode, 'direct')
  assert.equal(result.data.staffProfileId, 'sp1')
  assert.equal(denied.ok, false)
})

test('order lifecycle writes timeline and completed order can be reviewed once', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'client', openid: 'openid_client', nickname: '小明', roles: ['client'], status: 'active' },
      { _id: 'staff', openid: 'openid_staff', roles: ['client', 'staff'], status: 'active' }
    ],
    pets: [{ _id: 'p1', openid: 'openid_client', name: '可乐', weight: 8 }],
    staff_profiles: [{ _id: 'sp1', openid: 'openid_staff', realName: '王小花', auditStatus: 'approved', serviceAddress: '基准服务地址', serviceLatitude: 31.2, serviceLongitude: 121.5 }],
    orders: [],
    payments: [],
    order_timeline: [],
    service_reviews: []
  })
  const clientFn = loadCloudFunction('api', db, 'openid_client')
  const staffFn = loadCloudFunction('api', db, 'openid_staff')

  const created = await clientFn.main({ module: 'order', action: 'createOrder', data: { petId: 'p1', serviceTypes: ['feed'], serviceAddress: '测试小区', addressDetail: '1栋', doorplate: '101', startTime: '2099-07-28 10:00', endTime: '2099-07-28 11:00', durationMinutes: 60 } })
  await clientFn.main({ module: 'payment', action: 'mockPayOrder', data: { orderId: created.data._id } })
  await staffFn.main({ module: 'staff', action: 'acceptOrder', data: { orderId: created.data._id } })
  await staffFn.main({ module: 'order', action: 'startService', data: { id: created.data._id } })
  for (const eventType of ['enter_door', 'pet_status', 'feed', 'water', 'leave_door']) {
    await staffFn.main({ module: 'checkin', action: 'createCheckin', data: { orderId: created.data._id, eventType, note: '已完成打卡' } })
  }
  await staffFn.main({ module: 'order', action: 'finishService', data: { id: created.data._id } })
  const review = await clientFn.main({ module: 'order', action: 'createReview', data: { orderId: created.data._id, rating: 5, tags: ['服务细心'], content: '很好' } })
  const duplicate = await clientFn.main({ module: 'order', action: 'createReview', data: { orderId: created.data._id, rating: 4 } })
  const timeline = await clientFn.main({ module: 'order', action: 'getOrderTimeline', data: { orderId: created.data._id } })

  assert.equal(review.ok, true)
  assert.equal(duplicate.ok, false)
  assert.equal(duplicate.message, '该订单已评价')
  assert.deepEqual(timeline.data.map((item) => item.type), ['created', 'paid', 'assigned', 'started', 'checkin', 'checkin', 'checkin', 'checkin', 'checkin', 'completed', 'reviewed'])
})

test('client cancel order returns MVP refund quote and writes cancelled timeline', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active' }],
    orders: [{ _id: 'order1', clientOpenid: 'openid_client', status: 'assigned', payAmount: 100, startTime: '2000-07-28 10:00' }],
    order_timeline: []
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const quote = await fn.main({ module: 'order', action: 'getCancelQuote', data: { orderId: 'order1' } })
  const cancel = await fn.main({ module: 'order', action: 'cancelOrder', data: { orderId: 'order1', reason: '行程变化' } })
  const order = db.state.orders.find((item) => item._id === 'order1')

  assert.equal(quote.ok, true)
  assert.equal(quote.data.refundAmount, 80)
  assert.equal(cancel.ok, true)
  assert.equal(order.status, 'cancelled')
  assert.equal(order.refundStatus, 'mock_refunded')
  assert.equal(db.state.order_timeline[0].type, 'cancelled')
})


test('coupon quote auto applies best available coupon', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active' }],
    pets: [{ _id: 'p1', openid: 'openid_client', name: '可乐', weight: 12 }],
    user_coupons: [
      { _id: 'c1', openid: 'openid_client', userId: 'u1', templateId: 't1', status: 'available', validFrom: '2026-01-01T00:00:00.000Z', validTo: '2099-01-01T00:00:00.000Z', templateSnapshot: { name: '满80减20', type: 'fixed', discountAmount: 20, minOrderAmount: 80, applicableServiceTypes: [] } },
      { _id: 'c2', openid: 'openid_client', userId: 'u1', templateId: 't2', status: 'available', validFrom: '2026-01-01T00:00:00.000Z', validTo: '2099-01-01T00:00:00.000Z', templateSnapshot: { name: '满80减10', type: 'fixed', discountAmount: 10, minOrderAmount: 80, applicableServiceTypes: [] } }
    ]
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const result = await fn.main({ module: 'order', action: 'quoteOrder', data: { petId: 'p1', serviceTypes: ['walk'], durationMinutes: 60, autoApplyCoupon: true } })

  assert.equal(result.ok, true)
  assert.equal(result.data.amount, 89)
  assert.equal(result.data.discountAmount, 20)
  assert.equal(result.data.payAmount, 69)
  assert.equal(result.data.coupon.couponId, 'c1')
  assert.equal(result.data.priceItems.some((item) => item.key === 'coupon' && item.price === -20), true)
})

test('coupon quote rejects explicit inapplicable coupon but auto apply ignores it', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active' }],
    pets: [{ _id: 'p1', openid: 'openid_client', name: '可乐', weight: 8 }],
    user_coupons: [
      { _id: 'c1', openid: 'openid_client', userId: 'u1', templateId: 't1', status: 'available', validFrom: '2026-01-01T00:00:00.000Z', validTo: '2099-01-01T00:00:00.000Z', templateSnapshot: { name: '满200减20', type: 'fixed', discountAmount: 20, minOrderAmount: 200, applicableServiceTypes: [] } }
    ]
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const explicit = await fn.main({ module: 'order', action: 'quoteOrder', data: { petId: 'p1', serviceTypes: ['feed'], durationMinutes: 60, couponId: 'c1' } })
  const auto = await fn.main({ module: 'order', action: 'quoteOrder', data: { petId: 'p1', serviceTypes: ['feed'], durationMinutes: 60, autoApplyCoupon: true } })

  assert.equal(explicit.ok, false)
  assert.equal(explicit.message, '订单满 ¥200 可用')
  assert.equal(auto.ok, true)
  assert.equal(auto.data.discountAmount, 0)
  assert.equal(auto.data.payAmount, 59)
})

test('coupon create order locks coupon and prevents reuse', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active' }],
    pets: [{ _id: 'p1', openid: 'openid_client', name: '可乐', weight: 12 }],
    orders: [],
    user_coupons: [
      { _id: 'c1', openid: 'openid_client', userId: 'u1', templateId: 't1', status: 'available', validFrom: '2026-01-01T00:00:00.000Z', validTo: '2099-01-01T00:00:00.000Z', templateSnapshot: { name: '满80减20', type: 'fixed', discountAmount: 20, minOrderAmount: 80, applicableServiceTypes: [] } }
    ],
    order_timeline: []
  })
  const fn = loadCloudFunction('api', db, 'openid_client')
  const data = { petId: 'p1', serviceTypes: ['walk'], serviceAddress: '测试地址', addressDetail: '1栋101', doorplate: '101', startTime: '2026-07-28 10:00', endTime: '2026-07-28 11:00', durationMinutes: 60, couponId: 'c1' }

  const created = await fn.main({ module: 'order', action: 'createOrder', data })
  const reused = await fn.main({ module: 'order', action: 'createOrder', data })

  assert.equal(created.ok, true)
  assert.equal(created.data.amount, 89)
  assert.equal(created.data.discountAmount, 20)
  assert.equal(created.data.payAmount, 69)
  assert.equal(created.data.couponId, 'c1')
  assert.equal(db.state.user_coupons[0].status, 'locked')
  assert.equal(db.state.user_coupons[0].lockedOrderId, created.data._id)
  assert.equal(reused.ok, false)
  assert.equal(reused.message, '已锁定')
})

test('coupon payment marks coupon used and cancel unpaid releases coupon', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active' }],
    pets: [{ _id: 'p1', openid: 'openid_client', name: '可乐', weight: 12 }],
    orders: [],
    payments: [],
    user_coupons: [
      { _id: 'c1', openid: 'openid_client', userId: 'u1', templateId: 't1', status: 'available', validFrom: '2026-01-01T00:00:00.000Z', validTo: '2099-01-01T00:00:00.000Z', templateSnapshot: { name: '满80减20', type: 'fixed', discountAmount: 20, minOrderAmount: 80, applicableServiceTypes: [] } },
      { _id: 'c2', openid: 'openid_client', userId: 'u1', templateId: 't1', status: 'available', validFrom: '2026-01-01T00:00:00.000Z', validTo: '2099-01-01T00:00:00.000Z', templateSnapshot: { name: '满80减20', type: 'fixed', discountAmount: 20, minOrderAmount: 80, applicableServiceTypes: [] } }
    ],
    order_timeline: []
  })
  const fn = loadCloudFunction('api', db, 'openid_client')
  const base = { petId: 'p1', serviceTypes: ['walk'], serviceAddress: '测试地址', addressDetail: '1栋101', doorplate: '101', startTime: '2026-07-28 10:00', endTime: '2026-07-28 11:00', durationMinutes: 60 }

  const paidOrder = await fn.main({ module: 'order', action: 'createOrder', data: { ...base, couponId: 'c1' } })
  const paid = await fn.main({ module: 'payment', action: 'mockPayOrder', data: { orderId: paidOrder.data._id } })
  const cancelOrder = await fn.main({ module: 'order', action: 'createOrder', data: { ...base, couponId: 'c2' } })
  const cancelled = await fn.main({ module: 'order', action: 'cancelOrder', data: { orderId: cancelOrder.data._id, reason: '暂不需要' } })

  assert.equal(paid.ok, true)
  assert.equal(db.state.payments[0].amount, 69)
  assert.equal(db.state.user_coupons.find((item) => item._id === 'c1').status, 'used')
  assert.equal(cancelled.ok, true)
  assert.equal(db.state.user_coupons.find((item) => item._id === 'c2').status, 'available')
})

test('admin can save coupon template issue coupon and per-user limit applies', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' },
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active' }
    ],
    coupon_templates: [],
    user_coupons: [],
    admin_operation_logs: []
  })
  const adminFn = loadCloudFunction('api', db, 'openid_admin')
  const clientFn = loadCloudFunction('api', db, 'openid_client')

  const saved = await adminFn.main({ module: 'admin', action: 'saveCouponTemplate', data: { name: '满80减20', discountAmount: 20, minOrderAmount: 80, validDays: 30, perUserLimit: 1, enabled: true } })
  const issued = await adminFn.main({ module: 'admin', action: 'issueCouponToUser', data: { templateId: saved.data._id, openid: 'openid_client' } })
  const issuedAgain = await adminFn.main({ module: 'admin', action: 'issueCouponToUser', data: { templateId: saved.data._id, openid: 'openid_client' } })
  const wallet = await clientFn.main({ module: 'coupon', action: 'listMyCoupons', data: { status: 'available' } })

  assert.equal(saved.ok, true)
  assert.equal(issued.ok, true)
  assert.equal(issued.data.templateSnapshot.name, '满80减20')
  assert.equal(issuedAgain.ok, false)
  assert.equal(issuedAgain.message, '该用户已达到领取上限')
  assert.equal(wallet.ok, true)
  assert.equal(wallet.data.length, 1)
  assert.equal(wallet.data[0].ruleText, '满80减20')
})

test('invite login rewards inviter with retro card once', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'inviter', openid: 'openid_inviter', roles: ['client'], status: 'active', retroCardCount: 0, inviteCode: 'INVITER01' }
    ],
    retro_card_logs: [],
    user_invites: []
  })
  const invitedFn = loadCloudFunction('api', db, 'openid_new')

  const result = await invitedFn.main({ module: 'auth', action: 'login', data: { inviterOpenid: 'openid_inviter' } })

  assert.equal(result.ok, true)
  assert.equal(result.data.inviterOpenid, 'openid_inviter')
  assert.equal(db.state.users.find((item) => item.openid === 'openid_inviter').retroCardCount, 1)
  assert.equal(db.state.user_invites.length, 1)
  assert.equal(db.state.user_invites[0].invitedOpenid, 'openid_new')
})

test('checkin supports monthly rewards and retro card consumption', async () => {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  const todayDay = now.getUTCDate()
  const retroDay = Math.max(todayDay - 1, 1)
  const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getDate()
  const days = Array.from({ length: daysInMonth }, (_, index) => ({ day: index + 1, rewardType: 'points', points: 5, couponTemplateId: '', couponSnapshot: null, title: `第${index + 1}天奖励`, desc: '签到奖励' }))
  days[todayDay - 1] = { day: todayDay, rewardType: 'points', points: 7, couponTemplateId: '', couponSnapshot: null, title: '今日奖励', desc: '双倍签到积分' }
  days[retroDay - 1] = { day: retroDay, rewardType: 'coupon', points: 0, couponTemplateId: 'tpl1', couponSnapshot: { templateId: 'tpl1', name: '补签奖励券', discountAmount: 10, minOrderAmount: 50 }, title: '补签奖励', desc: '补签送券' }
  const db = createCollectionStore({
    users: [{ _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', points: 0, totalPoints: 0, retroCardCount: 1 }],
    checkin_month_configs: [{ _id: 'cfg1', monthKey, days, status: 'active' }],
    user_checkins: [],
    coupon_templates: [{ _id: 'tpl1', name: '补签奖励券', discountAmount: 10, minOrderAmount: 50, validDays: 30, validType: 'relative_days', enabled: true, perUserLimit: 5, totalIssueLimit: 0, issuedCount: 0 }],
    user_coupons: [],
    point_logs: [],
    retro_card_logs: []
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const todayResult = await fn.main({ module: 'checkin', action: 'checkinToday', data: {} })
  const retroResult = await fn.main({ module: 'checkin', action: 'retroCheckin', data: { monthKey, day: retroDay } })
  const calendar = await fn.main({ module: 'checkin', action: 'getMonthCalendar', data: { monthKey } })

  assert.equal(todayResult.ok, true)
  assert.equal(todayResult.data.pointsDelta, 7)
  assert.equal(retroResult.ok, true)
  assert.equal(db.state.user_coupons.length, 1)
  assert.equal(db.state.users[0].retroCardCount, 0)
  assert.equal(db.state.user_checkins.length, 2)
  assert.equal(calendar.ok, true)
  assert.equal(calendar.data.days.find((item) => item.day === todayDay).checked, true)
  assert.equal(calendar.data.days.find((item) => item.day === retroDay).checkinType, retroDay === todayDay ? 'normal' : 'retro')
})

test('reward mail unread count and claim are idempotent', async () => {
  const now = new Date().toISOString()
  const db = createCollectionStore({
    users: [{ _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', points: 0, totalPoints: 0 }],
    reward_mails: [{ _id: 'mail1', userId: 'client', openid: 'openid_client', title: '积分到账', content: '请领取奖励', reward: { type: 'points', points: 20 }, readAt: null, claimedAt: null, createdAt: now, updatedAt: now }],
    point_logs: []
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const unreadBefore = await fn.main({ module: 'rewardMail', action: 'getUnreadCount', data: {} })
  const marked = await fn.main({ module: 'rewardMail', action: 'markRead', data: { id: 'mail1' } })
  const claimed = await fn.main({ module: 'rewardMail', action: 'claimReward', data: { id: 'mail1' } })
  const claimedAgain = await fn.main({ module: 'rewardMail', action: 'claimReward', data: { id: 'mail1' } })
  const unreadAfter = await fn.main({ module: 'rewardMail', action: 'getUnreadCount', data: {} })

  assert.equal(unreadBefore.ok, true)
  assert.equal(unreadBefore.data.unreadCount, 1)
  assert.equal(marked.ok, true)
  assert.equal(marked.data.unread, false)
  assert.equal(claimed.ok, true)
  assert.equal(db.state.users[0].points, 20)
  assert.equal(db.state.point_logs.length, 1)
  assert.equal(claimedAgain.ok, true)
  assert.equal(db.state.point_logs.length, 1)
  assert.equal(unreadAfter.data.unreadCount, 0)
  assert.equal(unreadAfter.data.unclaimedCount, 0)
})

test('finishService applies member multiplier and grants retro card on third completed order', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', points: 0, totalPoints: 100, memberLevel: 'gold', memberLevelName: '黄金会员', completedOrderCount: 2, retroCardCount: 0 },
      { _id: 'staff', openid: 'openid_staff', roles: ['client', 'staff'], status: 'active' }
    ],
    member_levels: [{ _id: 'gold', name: '黄金会员', minPoints: 100, pointMultiplier: 2 }],
    orders: [{ _id: 'order1', clientOpenid: 'openid_client', clientUserId: 'client', staffOpenid: 'openid_staff', status: 'in_service', payAmount: 50, requiredCheckins: [] }],
    checkin_logs: [],
    point_logs: [],
    retro_card_logs: [],
    order_timeline: []
  })
  const fn = loadCloudFunction('api', db, 'openid_staff')

  const result = await fn.main({ module: 'order', action: 'finishService', data: { id: 'order1' } })

  assert.equal(result.ok, true)
  assert.equal(db.state.point_logs[0].baseDelta, 5)
  assert.equal(db.state.point_logs[0].delta, 10)
  assert.equal(db.state.users.find((item) => item.openid === 'openid_client').completedOrderCount, 3)
  assert.equal(db.state.users.find((item) => item.openid === 'openid_client').retroCardCount, 1)
  assert.equal(db.state.retro_card_logs.length, 1)
})

test('admin can save rich member level and coupon template settings', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' }],
    member_levels: [],
    coupon_templates: [],
    admin_operation_logs: []
  })
  const fn = loadCloudFunction('api', db, 'openid_admin')

  const level = await fn.main({ module: 'admin', action: 'saveMemberLevel', data: { name: '钻石会员', minPoints: 300, pointMultiplier: 3, description: '高阶会员', benefits: ['专属券', '高倍积分'] } })
  const coupon = await fn.main({ module: 'admin', action: 'saveCouponTemplate', data: { name: '月度券', discountAmount: 20, minOrderAmount: 80, validType: 'fixed_range', validFromFixed: '2026-08-01', validToFixed: '2026-08-31', displayTag: '月度奖励', claimNotice: '限时领取', useNotice: '按规则使用', perUserLimit: 2, enabled: true } })

  assert.equal(level.ok, true)
  assert.equal(level.data.pointMultiplier, 3)
  assert.deepEqual(level.data.benefits, ['专属券', '高倍积分'])
  assert.equal(coupon.ok, true)
  assert.equal(coupon.data.validType, 'fixed_range')
  assert.equal(coupon.data.displayTag, '月度奖励')
})

test('admin issues coupons by target level ids', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' },
      { _id: 'u1', openid: 'openid_gold', roles: ['client'], status: 'active', memberLevel: 'level_gold', memberLevelName: '黄金会员' },
      { _id: 'u2', openid: 'openid_renamed', roles: ['client'], status: 'active', memberLevel: 'level_gold', memberLevelName: '旧黄金会员' },
      { _id: 'u3', openid: 'openid_silver', roles: ['client'], status: 'active', memberLevel: 'level_silver', memberLevelName: '白银会员' }
    ],
    member_levels: [
      { _id: 'level_silver', name: '白银会员', minPoints: 100, pointMultiplier: 1 },
      { _id: 'level_gold', name: '黄金会员', minPoints: 200, pointMultiplier: 2 }
    ],
    coupon_templates: [{ _id: 'tpl1', name: '月度券', discountAmount: 20, minOrderAmount: 80, validDays: 30, perUserLimit: 1, issuedCount: 0, enabled: true }],
    user_coupons: [],
    admin_operation_logs: []
  })
  const fn = loadCloudFunction('api', db, 'openid_admin')

  const result = await fn.main({ module: 'admin', action: 'issueCouponByLevels', data: { templateId: 'tpl1', targetLevelIds: ['level_gold'] } })

  assert.equal(result.ok, true)
  assert.equal(result.data.issued, 2)
  assert.equal(result.data.eligibleCount, 2)
  assert.deepEqual(result.data.targetLevelNamesSnapshot, ['黄金会员'])
  assert.equal(db.state.user_coupons.length, 2)
  assert.deepEqual(db.state.user_coupons.map((item) => item.openid).sort(), ['openid_gold', 'openid_renamed'])
})

test('admin issueCouponByLevels returns skipped reasons', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' },
      { _id: 'u1', openid: 'openid_silver_1', roles: ['client'], status: 'active', memberLevel: 'level_silver', memberLevelName: '银卡会员' },
      { _id: 'u2', openid: 'openid_silver_2', roles: ['client'], status: 'active', memberLevel: 'level_silver', memberLevelName: '银卡会员' }
    ],
    member_levels: [
      { _id: 'level_silver', name: '银卡会员', minPoints: 10, pointMultiplier: 1 }
    ],
    coupon_templates: [{ _id: 'tpl1', name: '满80减20', discountAmount: 20, minOrderAmount: 80, validDays: 30, perUserLimit: 1, issuedCount: 1, enabled: true }],
    user_coupons: [{ _id: 'coupon1', templateId: 'tpl1', openid: 'openid_silver_1', status: 'available' }],
    admin_operation_logs: []
  })
  const fn = loadCloudFunction('api', db, 'openid_admin')

  const result = await fn.main({ module: 'admin', action: 'issueCouponByLevels', data: { templateId: 'tpl1', targetLevelIds: ['level_silver'] } })

  assert.equal(result.ok, true)
  assert.equal(result.data.issued, 1)
  assert.equal(result.data.skipped, 1)
  assert.equal(result.data.skippedReasons['该用户已达到领取上限'], 1)
})

test('admin can publish reward mails by target level ids', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' },
      { _id: 'u1', openid: 'openid_gold', roles: ['client'], status: 'active', memberLevel: 'level_gold', memberLevelName: '黄金会员' },
      { _id: 'u2', openid: 'openid_silver', roles: ['client'], status: 'active', memberLevel: 'level_silver', memberLevelName: '白银会员' }
    ],
    member_levels: [
      { _id: 'level_silver', name: '白银会员', minPoints: 100, pointMultiplier: 1 },
      { _id: 'level_gold', name: '黄金会员', minPoints: 200, pointMultiplier: 2 }
    ],
    reward_mails: [],
    admin_operation_logs: []
  })
  const fn = loadCloudFunction('api', db, 'openid_admin')

  const result = await fn.main({ module: 'admin', action: 'publishRewardMailByLevels', data: { title: '等级奖励', content: '请领取积分', rewardType: 'points', points: 30, targetLevelIds: ['level_gold'] } })

  assert.equal(result.ok, true)
  assert.equal(result.data.issued, 1)
  assert.equal(db.state.reward_mails.length, 1)
  assert.equal(db.state.reward_mails[0].openid, 'openid_gold')
  assert.equal(db.state.reward_mails[0].reward.points, 30)
  assert.deepEqual(db.state.reward_mails[0].targetLevelIds, ['level_gold'])
  assert.deepEqual(db.state.reward_mails[0].targetLevelNamesSnapshot, ['黄金会员'])
})

test('saving member level syncs memberLevelName for bound users', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' },
      { _id: 'u1', openid: 'openid_gold', roles: ['client'], status: 'active', memberLevel: 'level_gold', memberLevelName: '旧黄金会员', totalPoints: 260, points: 50 }
    ],
    member_levels: [{ _id: 'level_gold', name: '旧黄金会员', minPoints: 200, pointMultiplier: 2 }],
    admin_operation_logs: []
  })
  const fn = loadCloudFunction('api', db, 'openid_admin')

  const result = await fn.main({ module: 'admin', action: 'saveMemberLevel', data: { _id: 'level_gold', name: '黄金会员', minPoints: 200, pointMultiplier: 2 } })

  assert.equal(result.ok, true)
  assert.equal(db.state.users.find((item) => item._id === 'u1').memberLevelName, '黄金会员')
})

test('saving member level rejects duplicate names', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' }],
    member_levels: [
      { _id: 'level_normal', name: '普通会员', minPoints: 0, pointMultiplier: 1 },
      { _id: 'level_silver', name: '银卡会员', minPoints: 10, pointMultiplier: 1 }
    ],
    admin_operation_logs: []
  })
  const fn = loadCloudFunction('api', db, 'openid_admin')

  const result = await fn.main({ module: 'admin', action: 'saveMemberLevel', data: { name: '银卡会员', minPoints: 20, pointMultiplier: 2 } })

  assert.equal(result.ok, false)
  assert.equal(result.message, '已存在同名会员等级，请先编辑原等级或换一个名称')
})

test('deleting member level recalculates affected users', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' },
      { _id: 'u1', openid: 'openid_gold', roles: ['client'], status: 'active', memberLevel: 'level_gold', memberLevelName: '黄金会员', totalPoints: 260, points: 80 },
      { _id: 'u2', openid: 'openid_silver', roles: ['client'], status: 'active', memberLevel: 'level_silver', memberLevelName: '白银会员', totalPoints: 120, points: 30 }
    ],
    member_levels: [
      { _id: 'level_silver', name: '白银会员', minPoints: 100, pointMultiplier: 1 },
      { _id: 'level_gold', name: '黄金会员', minPoints: 200, pointMultiplier: 2 }
    ],
    admin_operation_logs: []
  })
  const fn = loadCloudFunction('api', db, 'openid_admin')

  const result = await fn.main({ module: 'admin', action: 'deleteMemberLevel', data: { _id: 'level_gold' } })
  const affected = db.state.users.find((item) => item._id === 'u1')

  assert.equal(result.ok, true)
  assert.equal(affected.memberLevel, 'level_silver')
  assert.equal(affected.memberLevelName, '白银会员')
})

test('submitStaffProfile requires fixed service address and valid coordinates', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_staff_new', roles: ['client', 'staff'], status: 'active', phone: '13800001111' }],
    staff_profiles: []
  })
  const fn = loadCloudFunction('api', db, 'openid_staff_new')

  const noAddress = await fn.main({
    module: 'staff',
    action: 'submitStaffProfile',
    data: { realName: '张三', phone: '13800001111', serviceCity: '上海' }
  })
  assert.equal(noAddress.ok, false)
  assert.equal(noAddress.message, '宠托师认证必须设置固定服务地址及坐标')

  const success = await fn.main({
    module: 'staff',
    action: 'submitStaffProfile',
    data: {
      realName: '张三',
      phone: '13800001111',
      serviceCity: '上海',
      serviceAreas: '浦东',
      serviceAddress: '三里屯SOHO',
      serviceLatitude: 31.2,
      serviceLongitude: 121.5,
      serviceRadiusKm: 5
    }
  })
  assert.equal(success.ok, true)
  assert.equal(db.state.staff_profiles[0].serviceAddress, '三里屯SOHO')
  assert.equal(db.state.staff_profiles[0].serviceRadiusKm, 5)
})

test('updateStaffProfileConfig updates service radius and weekly schedule', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_staff_cfg', roles: ['client', 'staff'], status: 'active' }],
    staff_profiles: [{ _id: 'sp1', openid: 'openid_staff_cfg', auditStatus: 'approved', realName: '李四', serviceAddress: '旧地址', serviceLatitude: 31.2, serviceLongitude: 121.5, serviceRadiusKm: 5 }]
  })
  const fn = loadCloudFunction('api', db, 'openid_staff_cfg')

  const result = await fn.main({
    module: 'staff',
    action: 'updateStaffProfileConfig',
    data: {
      serviceAddress: '新基准地址',
      serviceLatitude: 31.2,
      serviceLongitude: 121.5,
      serviceRadiusKm: 10,
      weeklySchedule: {
        '1': [{ start: 10, end: 12 }, { start: 16, end: 18 }],
        '2': [{ start: 10, end: 12 }]
      }
    }
  })

  assert.equal(result.ok, true)
  assert.equal(db.state.staff_profiles[0].serviceAddress, '新基准地址')
  assert.equal(db.state.staff_profiles[0].serviceRadiusKm, 10)
  assert.deepEqual(db.state.staff_profiles[0].weeklySchedule['1'], [{ start: 10, end: 12 }, { start: 16, end: 18 }])
})

test('listApprovedSitters filters out sitters exceeding user location distance', async () => {
  const db = createCollectionStore({
    users: [],
    staff_profiles: [
      { _id: 's_near', openid: 'openid_near', auditStatus: 'approved', realName: '近处宠托师', serviceAddress: '陆家嘴', serviceLatitude: 31.2, serviceLongitude: 121.5, serviceRadiusKm: 5, updatedAt: '2026-08-01' },
      { _id: 's_far', openid: 'openid_far', auditStatus: 'approved', realName: '远处宠托师', serviceAddress: '松江大学城', serviceLatitude: 30.9, serviceLongitude: 121.1, serviceRadiusKm: 5, updatedAt: '2026-08-02' }
    ]
  })
  const fn = loadCloudFunction('api', db, 'guest_user')

  // 用户在陆家嘴附近 (31.201, 121.501)
  const result = await fn.main({
    module: 'staff',
    action: 'listApprovedSitters',
    data: { latitude: 31.201, longitude: 121.501, pageSize: 50 }
  })

  assert.equal(result.ok, true)
  assert.equal(result.data.total, 1)
  assert.equal(result.data.list[0]._id, 's_near')
  assert.equal(typeof result.data.list[0].distanceText, 'string')
})

test('createOrder enforces sitter weekly schedule and service radius limits', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active' },
      { _id: 'u_sitter', openid: 'openid_sitter', roles: ['client', 'staff'], status: 'active' }
    ],
    pets: [{ _id: 'p1', openid: 'openid_client', name: '豆豆', weight: 8 }],
    staff_profiles: [
      {
        _id: 'sitter_1',
        openid: 'openid_sitter',
        realName: '王宠托',
        auditStatus: 'approved',
        serviceAddress: '陆家嘴中心',
        serviceLatitude: 31.2,
        serviceLongitude: 121.5,
        serviceRadiusKm: 5,
        weeklySchedule: {
          // 2026-08-03 是周一 (CST)
          '1': [{ start: 10, end: 12 }, { start: 16, end: 18 }]
        }
      }
    ],
    orders: []
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  // 1. 周一 08:00 - 09:00 -> 不在接单时间段内
  const wrongTime = await fn.main({
    module: 'order',
    action: 'createOrder',
    data: {
      petId: 'p1',
      publishMode: 'direct',
      staffProfileId: 'sitter_1',
      serviceTypes: ['feed'],
      serviceAddress: '近距离小区',
      addressDetail: '1栋',
      doorplate: '101',
      addressLatitude: 31.201,
      addressLongitude: 121.501,
      startTime: '2026-08-03 08:00',
      endTime: '2026-08-03 09:00',
      durationMinutes: 60
    }
  })
  assert.equal(wrongTime.ok, false)
  assert.equal(wrongTime.message.includes('不在宠托师周一的可接单时间段'), true)

  // 2. 超出 5km 范围 -> 无法预约
  const farAddress = await fn.main({
    module: 'order',
    action: 'createOrder',
    data: {
      petId: 'p1',
      publishMode: 'direct',
      staffProfileId: 'sitter_1',
      serviceTypes: ['feed'],
      serviceAddress: '远距离小区',
      addressDetail: '1栋',
      doorplate: '101',
      addressLatitude: 31.5,
      addressLongitude: 121.9,
      startTime: '2026-08-03 10:00',
      endTime: '2026-08-03 11:00',
      durationMinutes: 60
    }
  })
  assert.equal(farAddress.ok, false)
  assert.equal(farAddress.message.includes('超出宠托师设定的接单范围'), true)

  // 3. 符合时间与距离 -> 成功创建
  const validOrder = await fn.main({
    module: 'order',
    action: 'createOrder',
    data: {
      petId: 'p1',
      publishMode: 'direct',
      staffProfileId: 'sitter_1',
      serviceTypes: ['feed'],
      serviceAddress: '合规小区',
      addressDetail: '1栋',
      doorplate: '101',
      addressLatitude: 31.201,
      addressLongitude: 121.501,
      startTime: '2026-08-03 10:00',
      endTime: '2026-08-03 11:00',
      durationMinutes: 60
    }
  })
  assert.equal(validOrder.ok, true)
  assert.equal(validOrder.data.status, 'pending_pay')
})

test('acceptOrder rejects staff without fixed service address', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u_staff', openid: 'openid_no_addr', roles: ['client', 'staff'], status: 'active' }],
    staff_profiles: [{ _id: 'sp_no_addr', openid: 'openid_no_addr', auditStatus: 'approved' }],
    orders: [{ _id: 'ord1', status: 'paid', publishMode: 'open' }]
  })
  const fn = loadCloudFunction('api', db, 'openid_no_addr')

  const result = await fn.main({ module: 'staff', action: 'acceptOrder', data: { orderId: 'ord1' } })
  assert.equal(result.ok, false)
  assert.equal(result.message, '请先在个人中心设置固定服务地址与接单范围，方可接单')
})
