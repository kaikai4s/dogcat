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

test('api dispatches order createOrder through unified cloud function', async () => {
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
      serviceTypes: ['walk'],
      serviceAddress: '测试地址',
      addressDetail: '3栋2单元',
      doorplate: '1802',
      startTime: '2026-07-28 10:00',
      endTime: '2026-07-28 11:00',
      durationMinutes: 60
    }
  })

  assert.equal(result.ok, true)
  assert.equal(result.data.status, 'pending_pay')
  assert.equal(db.state.orders.length, 1)
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
      { _id: 'sp_a', openid: 'openid_staff_a', auditStatus: 'approved', currentLatitude: 31.2, currentLongitude: 121.5 },
      { _id: 'sp_b', openid: 'openid_staff_b', auditStatus: 'approved', currentLatitude: 31.2, currentLongitude: 121.5 }
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
    staff_profiles: [{ _id: 'sp1', openid: 'openid_staff', realName: '王小花', auditStatus: 'approved' }],
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
