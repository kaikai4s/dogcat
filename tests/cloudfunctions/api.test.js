const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

async function withEnv(values, fn) {
  const previous = {}
  Object.keys(values).forEach((key) => {
    previous[key] = process.env[key]
    process.env[key] = values[key]
  })
  try {
    return await fn()
  } finally {
    Object.keys(values).forEach((key) => {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    })
  }
}

const testPrivateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' })

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
      { _id: 's1', openid: 'staff_openid', auditStatus: 'approved', realName: '王小明', serviceCity: '上海', serviceAreas: '浦东,徐汇', updatedAt: '2099-07-28' },
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
    staff_profiles: [{ _id: 's1', openid: 'staff_openid', auditStatus: 'approved', realName: '王小明', serviceCity: '上海', serviceAreas: '浦东', updatedAt: '2099-07-28' }],
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
  assert.equal(favorite.code, 'AUTH_REQUIRED')
  assert.equal(favorite.message, '请先登录')
  assert.equal(order.ok, false)
  assert.equal(order.code, 'AUTH_REQUIRED')
  assert.equal(order.message, '请先登录')
})

test('api dispatches order createOrder through unified cloud function', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
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
      startTime: '2099-07-28 10:00',
      endTime: '2099-07-28 11:00',
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

test('auth updateProfile saves editable nickname avatar and syncs order phone', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active', nickname: '旧昵称', avatarUrl: '', phone: '' }],
    orders: [
      { _id: 'o1', clientOpenid: 'openid_client', contactPhone: '', clientSnapshot: { nickname: '旧昵称', phoneMasked: '' } },
      { _id: 'o2', clientOpenid: 'other_client', contactPhone: '', clientSnapshot: { nickname: '其他用户', phoneMasked: '' } }
    ]
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const result = await fn.main({ module: 'auth', action: 'updateProfile', data: { nickname: '豆豆家长', avatarUrl: 'cloud://avatar', phone: '13800000000' } })

  assert.equal(result.ok, true)
  assert.equal(result.data.nickname, '豆豆家长')
  assert.equal(result.data.avatarUrl, 'cloud://avatar')
  assert.equal(db.state.users[0].phone, '13800000000')
  assert.equal(db.state.orders[0].contactPhone, '13800000000')
  assert.equal(db.state.orders[0].clientSnapshot.phoneMasked, '1***0')
  assert.equal(db.state.orders[1].contactPhone, '')
})

test('auth bindPhone syncs existing order phone', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
    orders: [{ _id: 'o1', clientOpenid: 'openid_client', contactPhone: '13800000000', clientSnapshot: { phoneMasked: '1***0' } }]
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const result = await fn.main({ module: 'auth', action: 'bindPhone', data: { phone: '15900000001' } })

  assert.equal(result.ok, true)
  assert.equal(db.state.users[0].phone, '15900000001')
  assert.equal(db.state.orders[0].contactPhone, '15900000001')
  assert.equal(db.state.orders[0].clientSnapshot.phoneMasked, '1***1')
})

test('pet profile stores photo birthday breed and AI interaction fields', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
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

  // Test missing photo validation
  const noPhoto = await fn.main({
    module: 'pet',
    action: 'createPet',
    data: { name: '雪球' }
  })
  assert.equal(noPhoto.ok, false)
  assert.match(noPhoto.message, /请上传至少一张宠物照片/)

  // Test AI pet breed recognition through mocked cloud AI service
  const aiDb = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
    ai_logs: []
  })
  const aiFn = loadCloudFunction('api', aiDb, 'openid_client', {
    async getTempFileURL({ fileList }) {
      return { fileList: [{ fileID: fileList[0], tempFileURL: 'https://example.com/corgi-photo.jpg' }] }
    },
    ai() {
      return {
        createModel() {
          return {
            async generateText(payload) {
              assert.equal(payload.model, 'qwen3.5-flash')
              assert.equal(payload.messages[0].content[1].type, 'image_url')
              return { text: '照片中的宠物是一只威尔士柯基犬，体型矮小，大耳朵，毛色黄白相间。{"species":"dog","breed":"威尔士柯基犬"}' }
            }
          }
        }
      }
    }
  })
  const aiRecognize = await aiFn.main({
    module: 'pet',
    action: 'recognizePetBreed',
    data: { avatarFileId: 'cloud://corgi-photo.jpg' }
  })
  assert.equal(aiRecognize.ok, true)
  assert.equal(aiRecognize.data.species, 'dog')
  assert.equal(aiRecognize.data.breed, '威尔士柯基犬')
  assert.match(aiRecognize.data.aiResultText, /柯基/)
})

test('pet AI recognition requires an uploaded image', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }]
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const result = await fn.main({ module: 'pet', action: 'recognizePetBreed', data: {} })

  assert.equal(result.ok, false)
  assert.match(result.message, /请先上传宠物照片/)
})

test('pet AI recognition fails when cloud photo URL cannot be generated', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }]
  })
  const fn = loadCloudFunction('api', db, 'openid_client', {
    async getTempFileURL() {
      throw new Error('file not found')
    }
  })

  const result = await fn.main({ module: 'pet', action: 'recognizePetBreed', data: { avatarFileId: 'cloud://missing-photo.jpg' } })

  assert.equal(result.ok, false)
  assert.match(result.message, /照片链接生成失败/)
})

test('api quoteOrder supports multiple services and price details', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
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
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
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
      startTime: '2099-07-28 10:00',
      endTime: '2099-07-28 11:00',
      durationMinutes: 60
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.message, '请填写详细地址')
})

test('api createOrder requires bound phone and future start time', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active', phone: '' }],
    pets: [{ _id: 'p1', openid: 'openid_client', name: '可乐', weight: 12 }],
    orders: []
  })
  const fn = loadCloudFunction('api', db, 'openid_client')
  const baseData = {
    petId: 'p1',
    serviceTypes: ['feed'],
    serviceAddress: '测试小区',
    addressDetail: '1栋101',
    doorplate: '101',
    startTime: '2099-07-28 10:00',
    endTime: '2099-07-28 11:00',
    durationMinutes: 60
  }

  const noPhone = await fn.main({ module: 'order', action: 'createOrder', data: baseData })
  assert.equal(noPhone.ok, false)
  assert.equal(noPhone.message, '请先绑定手机号')

  db.state.users[0].phone = '13800000000'
  const past = await fn.main({ module: 'order', action: 'createOrder', data: { ...baseData, startTime: '2000-01-01 10:00', endTime: '2000-01-01 11:00' } })
  assert.equal(past.ok, false)
  assert.equal(past.message, '服务开始时间不能早于当前时间')
})

test('api createOrder stores compatible and extended service fields', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
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
      startTime: '2099-07-28 10:00',
      endTime: '2099-07-28 11:00',
      durationMinutes: 60
    }
  })

  assert.equal(result.ok, true)
  assert.equal(result.data.serviceType, 'feed')
  assert.deepEqual(result.data.serviceTypes, ['feed', 'litter'])
  assert.equal(result.data.serviceSummary, '上门喂养、清理宠物厕所')
  assert.equal(result.data.addressDetail, '1栋101')
  assert.equal(result.data.doorplate, '101')
  assert.equal(result.data.contactPhone, '13800000000')
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

  const settingsPayload = {
    enableTestAddressMode: true,
    payment: { enabled: true, mode: 'mock', mchId: 'mch_1', refundEnabled: true },
    settlement: { staffCommissionRate: 0.75, settlementDelayDays: 2, minWithdrawAmount: 20 },
    subscription: { enabled: true, templates: { orderPaid: 'tpl_paid', orderAssigned: 'tpl_assigned', serviceStart: 'tpl_start', serviceFinish: 'tpl_finish', refundResult: 'tpl_refund' } },
    reliability: { enableOfflineQueue: true, maxTrackBatchSize: 60, maxRetryTimes: 6 },
    homeHeroCarousel: {
      enabled: true,
      autoRotate: true,
      rotateIntervalMs: 6000,
      items: [
        {
          id: 'item1',
          type: 'video',
          fileId: 'cloud://video1.mp4',
          posterFileId: 'cloud://poster1.jpg',
          title: '视频测试',
          subtitle: '测试副标题',
          enabled: true,
          sort: 1
        }
      ]
    }
  }

  const saved = await adminFn.main({ module: 'admin', action: 'saveSystemSettings', data: settingsPayload })
  const fetched = await guestFn.main({ module: 'system', action: 'getSettings' })

  assert.equal(saved.ok, true)
  assert.equal(saved.data.enableTestAddressMode, true)
  assert.equal(saved.data.homeHeroCarousel.enabled, true)
  assert.equal(saved.data.payment.mode, 'mock')
  assert.equal(saved.data.payment.mchId, 'mch_1')
  assert.equal(saved.data.settlement.staffCommissionRate, 0.75)
  assert.equal(saved.data.subscription.enabled, true)
  assert.equal(saved.data.subscription.templates.orderPaid, 'tpl_paid')
  assert.equal(saved.data.reliability.maxTrackBatchSize, 60)
  assert.equal(saved.data.homeHeroCarousel.rotateIntervalMs, 6000)
  assert.equal(saved.data.homeHeroCarousel.items.length, 1)
  assert.equal(saved.data.homeHeroCarousel.items[0].type, 'video')

  assert.equal(fetched.ok, true)
  assert.equal(fetched.data.enableTestAddressMode, true)
  assert.equal(fetched.data.payment.refundEnabled, true)
  assert.equal(fetched.data.settlement.minWithdrawAmount, 20)
  assert.equal(fetched.data.subscription.templates.refundResult, 'tpl_refund')
  assert.equal(fetched.data.reliability.maxRetryTimes, 6)
  assert.equal(fetched.data.homeHeroCarousel.enabled, true)
  assert.equal(fetched.data.homeHeroCarousel.items[0].title, '视频测试')
})

test('system home page data aggregates public conversion modules', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }
    ],
    platform_configs: [{ _id: 'cfg1', key: 'system_settings', value: { homePage: { ctaTitle: '马上预约', modules: { lottery: false } } } }],
    service_prices: [{ _id: 'price1', key: 'feed', label: '上门喂养', price: 66, enabled: true, sortOrder: 1, description: '喂粮换水' }],
    staff_profiles: [{ _id: 'sp1', openid: 'openid_staff', realName: '王小花', auditStatus: 'approved', serviceCity: '上海', serviceAreas: '浦东', ratingAverage: 4.8, reviewCount: 3, isFeatured: true, featuredAt: '2026-08-01 10:00' }],
    coupon_templates: [{ _id: 'tpl1', name: '新人券', discountAmount: 20, minOrderAmount: 80, enabled: true, sortOrder: 1 }],
    orders: [{ _id: 'o1', orderNo: 'ORDER000001', clientOpenid: 'openid_client', staffProfileId: 'sp1', status: 'completed', serviceSummary: '上门喂养', petName: '豆豆', serviceAddress: '秘密小区', addressLatitude: 31.2, addressLongitude: 121.5, createdAt: '2026-08-01 10:00', completedAt: '2026-08-01 11:00' }],
    service_reviews: [{ _id: 'r1', orderId: 'o1', status: 'visible', rating: 5, content: '很细心', tags: ['准时'] }],
    checkin_logs: [{ _id: 'c1', orderId: 'o1', eventType: 'feed', mediaFileId: 'cloud://feed-photo', latitude: 31.2, longitude: 121.5, createdAt: '2026-08-01 10:30' }]
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const result = await fn.main({ module: 'system', action: 'getHomePageData', data: {} })

  assert.equal(result.ok, true)
  assert.equal(result.data.settings.homePage.ctaTitle, '马上预约')
  assert.equal(result.data.settings.homePage.modules.lottery, false)
  assert.equal(result.data.servicePrices[0].priceText, '¥66起')
  assert.equal(result.data.featuredSitters[0]._id, 'sp1')
  assert.equal(result.data.coupons.length, 0)
  assert.equal(result.data.repeatOrder._id, 'o1')
  assert.equal(result.data.recentOrders[0].statusText, '已完成')
  assert.equal(result.data.recentOrders[0].clientName, '宠物主')
  assert.equal(result.data.recentOrders[0].staffName, '王* 宠托师')
  assert.equal(result.data.recentOrders[0].review.content, '很细心')
  assert.equal(result.data.recentOrders[0].checkinPhotos[0].mediaFileId, 'cloud://feed-photo')
  assert.equal(result.data.recentOrders[0].serviceAddress, undefined)
  assert.equal(result.data.recentOrders[0].addressLatitude, undefined)
  assert.equal(result.data.statsData.completedCount, '1')
  assert.equal(result.data.statsData.ratingCount, '1')
})

test('system home page newbie coupons only show for unclaimed new users', async () => {
  const baseData = {
    users: [{ _id: 'client', openid: 'openid_new', roles: ['client'], status: 'active' }],
    coupon_templates: [{ _id: 'tpl1', name: '新人券', discountAmount: 20, minOrderAmount: 80, enabled: true, sortOrder: 1 }],
    orders: [],
    staff_profiles: [],
    service_prices: [],
    platform_configs: []
  }
  const newUserDb = createCollectionStore(baseData)
  const newUserFn = loadCloudFunction('api', newUserDb, 'openid_new')

  const newUserResult = await newUserFn.main({ module: 'system', action: 'getHomePageData', data: {} })

  assert.equal(newUserResult.ok, true)
  assert.equal(newUserResult.data.coupons.length, 1)
  assert.equal(newUserResult.data.coupons[0].ruleText, '满80减20')

  const claimedDb = createCollectionStore({
    ...baseData,
    user_coupons: [{ _id: 'uc1', openid: 'openid_new', templateId: 'tpl1', status: 'unused' }]
  })
  const claimedFn = loadCloudFunction('api', claimedDb, 'openid_new')

  const claimedResult = await claimedFn.main({ module: 'system', action: 'getHomePageData', data: {} })

  assert.equal(claimedResult.ok, true)
  assert.equal(claimedResult.data.coupons.length, 0)
})

test('public completed order detail exposes service proof without location', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', nickname: '豆豆家长' }],
    staff_profiles: [{ _id: 'sp1', openid: 'openid_staff', realName: '王小花', auditStatus: 'approved' }],
    orders: [{ _id: 'o1', orderNo: 'ORDER000001', clientOpenid: 'openid_client', staffProfileId: 'sp1', status: 'completed', serviceSummary: '上门喂养', petName: '豆豆', serviceAddress: '秘密小区', addressDetail: '1栋101', addressLatitude: 31.2, addressLongitude: 121.5, createdAt: '2026-08-01 10:00' }],
    service_reviews: [{ _id: 'r1', orderId: 'o1', status: 'visible', rating: 5, content: '很细心', tags: ['准时'] }],
    checkin_logs: [{ _id: 'c1', orderId: 'o1', eventType: 'feed', mediaFileId: 'cloud://feed-photo', latitude: 31.2, longitude: 121.5, createdAt: '2026-08-01 10:30' }]
  })
  const fn = loadCloudFunction('api', db, 'guest_openid')

  const result = await fn.main({ module: 'order', action: 'getPublicCompletedOrderDetail', data: { id: 'o1' } })

  assert.equal(result.ok, true)
  assert.equal(result.data.clientName, '豆* 用户')
  assert.equal(result.data.staffName, '王* 宠托师')
  assert.equal(result.data.review.content, '很细心')
  assert.equal(result.data.checkinPhotos[0].eventText, '喂食')
  assert.equal(result.data.serviceAddress, undefined)
  assert.equal(result.data.addressDetail, undefined)
  assert.equal(result.data.addressLatitude, undefined)
  assert.equal(result.data.checkinPhotos[0].latitude, undefined)
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
  assert.deepEqual(staffResult.data.list.map((user) => user.openid), ['openid_staff'])
  assert.deepEqual(keywordResult.data.list.map((user) => user.openid), ['openid_client'])
  assert.equal(keywordResult.data.list[0].memberLevelName, '银卡会员')
  assert.deepEqual(disabledResult.data.list.map((user) => user.openid), ['openid_staff'])
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
  assert.deepEqual(approvedResult.data.list.map((profile) => profile._id), ['sp1'])
  assert.equal(approvedResult.data.list[0].phone, '13800000000')
  assert.equal(approvedResult.data.list[0].userNickname, '豆豆姐姐')
  assert.equal(approvedResult.data.list[0].auditStatusText, '已通过')
  assert.equal(approvedResult.data.list[0].ratingAverage, 0)
  assert.equal(approvedResult.data.list[0].reviewCount, 0)
  assert.equal(approvedResult.data.list[0].isFeatured, false)
  assert.deepEqual(keywordResult.data.list.map((profile) => profile._id), ['sp1'])
})

test('admin large lists return pagination metadata', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' }],
    orders: [
      { _id: 'order1', orderNo: 'O1', clientOpenid: 'openid_client', status: 'paid', createdAt: '2026-08-03' },
      { _id: 'order2', orderNo: 'O2', clientOpenid: 'openid_client', status: 'completed', createdAt: '2026-08-02' },
      { _id: 'order3', orderNo: 'O3', clientOpenid: 'openid_client', status: 'cancelled', createdAt: '2026-08-01' }
    ],
    order_incidents: [
      { _id: 'incident1', orderId: 'order1', status: 'open', createdAt: '2026-08-03' },
      { _id: 'incident2', orderId: 'order2', status: 'processing', createdAt: '2026-08-02' }
    ]
  })
  const fn = loadCloudFunction('api', db, 'openid_admin')

  const orders = await fn.main({ module: 'admin', action: 'listOrders', data: { page: 2, pageSize: 1 } })
  const incidents = await fn.main({ module: 'incident', action: 'listIncidents', data: { page: 1, pageSize: 1 } })

  assert.equal(orders.ok, true)
  assert.equal(orders.data.total, 3)
  assert.equal(orders.data.page, 2)
  assert.equal(orders.data.hasMore, true)
  assert.deepEqual(orders.data.list.map((order) => order._id), ['order2'])
  assert.equal(incidents.data.total, 2)
  assert.equal(incidents.data.hasMore, true)
  assert.deepEqual(incidents.data.list.map((incident) => incident._id), ['incident1'])
})

test('admin can set and cancel featured sitter', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' },
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }
    ],
    staff_profiles: [{ _id: 'sp1', openid: 'openid_staff', realName: '王小花', auditStatus: 'approved' }],
    admin_operation_logs: []
  })
  const adminFn = loadCloudFunction('api', db, 'openid_admin')
  const clientFn = loadCloudFunction('api', db, 'openid_client')

  const setResult = await adminFn.main({ module: 'admin', action: 'setSitterFeatured', data: { staffProfileId: 'sp1', isFeatured: true } })
  const cancelResult = await adminFn.main({ module: 'admin', action: 'setSitterFeatured', data: { staffProfileId: 'sp1', isFeatured: false } })
  const deniedResult = await clientFn.main({ module: 'admin', action: 'setSitterFeatured', data: { staffProfileId: 'sp1', isFeatured: true } })
  const profile = db.state.staff_profiles.find((item) => item._id === 'sp1')

  assert.equal(setResult.ok, true)
  assert.equal(setResult.data.isFeatured, true)
  assert.equal(cancelResult.ok, true)
  assert.equal(profile.isFeatured, false)
  assert.equal(profile.featuredAt, '')
  assert.equal(deniedResult.ok, false)
  assert.equal(deniedResult.message, '仅管理员可操作')
  assert.equal(db.state.admin_operation_logs.length, 2)
})

test('admin cannot feature unapproved sitter', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' }],
    staff_profiles: [{ _id: 'sp1', openid: 'openid_staff', realName: '王小花', auditStatus: 'pending' }],
    admin_operation_logs: []
  })
  const fn = loadCloudFunction('api', db, 'openid_admin')

  const result = await fn.main({ module: 'admin', action: 'setSitterFeatured', data: { staffProfileId: 'sp1', isFeatured: true } })

  assert.equal(result.ok, false)
  assert.equal(result.message, '仅已审核通过的宠托师可设为精选')
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
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }
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
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }
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
    users: [{ _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
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
    users: [{ _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
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
  assert.equal(result.data.list[0].ratingAverage, 0)
  assert.equal(result.data.list[0].reviewCount, 0)
  assert.equal(result.data.list[0].isFeatured, false)
})

test('client sitter list supports rating sort and featured-first ordering', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
    staff_profiles: [
      { _id: 'sp1', realName: '普通高分', serviceCity: '上海', serviceAreas: '浦东', auditStatus: 'approved', ratingAverage: 4.9, reviewCount: 8, updatedAt: '2026-07-29 10:00' },
      { _id: 'sp2', realName: '精选低分', serviceCity: '上海', serviceAreas: '徐汇', auditStatus: 'approved', ratingAverage: 4.2, reviewCount: 2, isFeatured: true, featuredAt: '2026-07-29 09:00', updatedAt: '2026-07-29 09:00' },
      { _id: 'sp3', realName: '普通次高', serviceCity: '上海', serviceAreas: '静安', auditStatus: 'approved', ratingAverage: 4.8, reviewCount: 12, updatedAt: '2026-07-29 12:00' }
    ]
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const ratingResult = await fn.main({ module: 'staff', action: 'listApprovedSitters', data: { sortBy: 'rating' } })
  const latestResult = await fn.main({ module: 'staff', action: 'listApprovedSitters', data: { sortBy: 'latest' } })
  const cityResult = await fn.main({ module: 'staff', action: 'listApprovedSitters', data: { sortBy: 'city' } })

  assert.equal(ratingResult.ok, true)
  assert.deepEqual(ratingResult.data.list.map((item) => item._id), ['sp2', 'sp1', 'sp3'])
  assert.equal(ratingResult.data.list[0].isFeatured, true)
  assert.equal(ratingResult.data.list[1].ratingAverage, 4.9)
  assert.equal(ratingResult.data.list[1].reviewCount, 8)
  assert.equal(latestResult.data.list[0]._id, 'sp2')
  assert.equal(cityResult.data.list[0]._id, 'sp2')
})

test('client sitter list keeps featured first for distance sort', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
    staff_profiles: [
      { _id: 'sp1', realName: '近距离', serviceCity: '上海', serviceAreas: '浦东', auditStatus: 'approved', serviceAddress: '近', serviceLatitude: 31.21, serviceLongitude: 121.51, serviceRadiusKm: 20, ratingAverage: 4.9, reviewCount: 10 },
      { _id: 'sp2', realName: '精选远距离', serviceCity: '上海', serviceAreas: '徐汇', auditStatus: 'approved', serviceAddress: '远', serviceLatitude: 31.25, serviceLongitude: 121.55, serviceRadiusKm: 20, ratingAverage: 4.1, reviewCount: 1, isFeatured: true, featuredAt: '2026-07-29 09:00' }
    ]
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const result = await fn.main({ module: 'staff', action: 'listApprovedSitters', data: { sortBy: 'distance', latitude: 31.2, longitude: 121.5 } })

  assert.equal(result.ok, true)
  assert.deepEqual(result.data.list.map((item) => item._id), ['sp2', 'sp1'])
})

test('client review updates sitter rating stats and blocks duplicates', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', nickname: '豆豆家长', points: 0, totalPoints: 0 }],
    orders: [{ _id: 'order1', clientOpenid: 'openid_client', staffProfileId: 'sp1', staffUserId: 'staff', staffOpenid: 'openid_staff', status: 'completed' }],
    staff_profiles: [{ _id: 'sp1', openid: 'openid_staff', auditStatus: 'approved', ratingAverage: 0, reviewCount: 0 }],
    service_reviews: [{ _id: 'old_review', orderId: 'old_order', staffProfileId: 'sp1', rating: 4, status: 'visible', createdAt: '2099-07-28 10:00' }],
    order_timeline: [],
    point_logs: [],
    member_levels: []
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const result = await fn.main({ module: 'order', action: 'createReview', data: { orderId: 'order1', rating: 5, tags: ['服务细心'], content: '很细心' } })
  const duplicate = await fn.main({ module: 'order', action: 'createReview', data: { orderId: 'order1', rating: 3 } })
  const profile = db.state.staff_profiles.find((item) => item._id === 'sp1')

  assert.equal(result.ok, true)
  assert.equal(profile.ratingAverage, 4.5)
  assert.equal(profile.reviewCount, 2)
  assert.ok(profile.ratingUpdatedAt)
  assert.equal(duplicate.ok, false)
  assert.equal(duplicate.message, '该订单已评价')
})

test('client sitter list and detail display current nickname first', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' },
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
    users: [{ _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
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

test('paid order expires when service start time arrives without acceptance', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' },
      { _id: 'staff', openid: 'openid_staff', roles: ['client', 'staff'], status: 'active' }
    ],
    staff_profiles: [{ _id: 'sp1', openid: 'openid_staff', auditStatus: 'approved', serviceAddress: '服务点', serviceLatitude: 31.2, serviceLongitude: 121.5 }],
    orders: [{ _id: 'expired_order', orderNo: 'O_EXPIRED', clientOpenid: 'openid_client', status: 'paid', paymentStatus: 'paid', payAmount: 100, publishMode: 'open', staffOpenid: '', startTime: '2000-01-01 10:00', endTime: '2000-01-01 11:00', createdAt: '2000-01-01 09:00' }],
    order_timeline: []
  })
  const clientFn = loadCloudFunction('api', db, 'openid_client')
  const staffFn = loadCloudFunction('api', db, 'openid_staff')

  const list = await clientFn.main({ module: 'order', action: 'listOrders', data: {} })
  const accept = await staffFn.main({ module: 'staff', action: 'acceptOrder', data: { orderId: 'expired_order' } })

  assert.equal(list.ok, true)
  assert.equal(list.data[0].status, 'expired')
  assert.equal(db.state.orders[0].status, 'expired')
  assert.equal(db.state.order_timeline.some((item) => item.type === 'expired'), true)
  assert.equal(accept.ok, false)
  assert.equal(accept.message, '订单状态不可接单')
})

test('createOrder defaults to open publish mode', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
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
      startTime: '2099-07-28 10:00',
      endTime: '2099-07-28 11:00',
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
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' },
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
    startTime: '2099-07-28 10:00',
    endTime: '2099-07-28 11:00',
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
      { _id: 'open_order', petId: 'pet1', petName: '可乐', status: 'paid', publishMode: 'open', staffOpenid: '', requestedStaffOpenid: '', startTime: '2099-07-28 10:00', addressLatitude: 31.2, addressLongitude: 121.5 },
      { _id: 'direct_order', petId: 'pet1', petName: '可乐', status: 'paid', publishMode: 'direct', staffOpenid: '', requestedStaffOpenid: 'openid_staff_a', startTime: '2099-07-28 11:00', addressLatitude: 31.2, addressLongitude: 121.5 }
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
    orders: [{ _id: 'order1', status: 'paid', publishMode: 'direct', requestedStaffOpenid: 'other_staff', staffOpenid: '', startTime: '2099-07-28 10:00', endTime: '2099-07-28 11:00' }],
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

test('admin getOrderDetail returns real client and staff phones only through admin module', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' },
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', nickname: '豆豆家长', phone: '13800000000' },
      { _id: 'staff', openid: 'openid_staff', roles: ['client', 'staff'], status: 'active', nickname: '宠托姐姐', phone: '13900000000' }
    ],
    staff_profiles: [{ _id: 'sp1', openid: 'openid_staff', realName: '王小花', phone: '13911112222', auditStatus: 'approved' }],
    orders: [{ _id: 'order1', orderNo: 'O20260825001', clientOpenid: 'openid_client', staffOpenid: 'openid_staff', staffProfileId: 'sp1', status: 'assigned', petName: '豆豆' }],
    track_logs: [],
    checkin_logs: [],
    unlock_code_logs: []
  })
  const adminFn = loadCloudFunction('api', db, 'openid_admin')
  const staffFn = loadCloudFunction('api', db, 'openid_staff')

  const adminResult = await adminFn.main({ module: 'admin', action: 'getOrderDetail', data: { id: 'order1' } })
  const staffResult = await staffFn.main({ module: 'order', action: 'getOrderDetail', data: { id: 'order1' } })

  assert.equal(adminResult.ok, true)
  assert.equal(adminResult.data.order.clientContact.phone, '13800000000')
  assert.equal(adminResult.data.order.staffContact.phone, '13911112222')
  assert.equal(staffResult.ok, true)
  assert.equal(staffResult.data.clientContact, undefined)
  assert.equal(staffResult.data.staffContact, undefined)
})

test('admin listOrders filters by order keyword client phone and staff phone', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' },
      { _id: 'client1', openid: 'openid_client_1', roles: ['client'], status: 'active', nickname: '豆豆家长', phone: '13800000000' },
      { _id: 'client2', openid: 'openid_client_2', roles: ['client'], status: 'active', nickname: '可乐家长', phone: '13900000000' },
      { _id: 'staff1', openid: 'openid_staff_1', roles: ['client', 'staff'], status: 'active', nickname: '宠托甲', phone: '13700000000' },
      { _id: 'staff2', openid: 'openid_staff_2', roles: ['client', 'staff'], status: 'active', nickname: '宠托乙', phone: '13600000000' }
    ],
    staff_profiles: [
      { _id: 'sp1', openid: 'openid_staff_1', realName: '王小花', phone: '13711112222', auditStatus: 'approved' },
      { _id: 'sp2', openid: 'openid_staff_2', realName: '李小狗', phone: '', auditStatus: 'approved' }
    ],
    orders: [
      { _id: 'order_alpha', orderNo: 'O20260825001', clientOpenid: 'openid_client_1', contactPhone: '13500000000', staffOpenid: 'openid_staff_1', staffProfileId: 'sp1', status: 'paid', petName: '豆豆', createdAt: '2026-08-25 10:00' },
      { _id: 'order_beta', orderNo: 'O20260825002', clientOpenid: 'openid_client_2', requestedStaffOpenid: 'openid_staff_2', requestedStaffProfileId: 'sp2', status: 'paid', petName: '可乐', createdAt: '2026-08-25 09:00' },
      { _id: 'order_contact_phone', orderNo: 'O20260825004', clientOpenid: 'openid_no_phone', contactPhone: '13512345678', status: 'paid', petName: '花花', createdAt: '2026-08-25 08:30' },
      { _id: 'order_deleted', orderNo: 'O20260825003', clientOpenid: 'openid_client_1', status: 'paid', adminDeletedAt: '2026-08-25 11:00', createdAt: '2026-08-25 08:00' }
    ]
  })
  const fn = loadCloudFunction('api', db, 'openid_admin')

  const orderNoResult = await fn.main({ module: 'admin', action: 'listOrders', data: { orderKeyword: '25002' } })
  const orderIdResult = await fn.main({ module: 'admin', action: 'listOrders', data: { orderKeyword: 'alpha' } })
  const clientPhoneResult = await fn.main({ module: 'admin', action: 'listOrders', data: { clientPhone: '138' } })
  const contactPhoneResult = await fn.main({ module: 'admin', action: 'listOrders', data: { clientPhone: '1351234' } })
  const staffProfilePhoneResult = await fn.main({ module: 'admin', action: 'listOrders', data: { staffPhone: '1371111' } })
  const staffUserPhoneResult = await fn.main({ module: 'admin', action: 'listOrders', data: { staffPhone: '136' } })

  assert.equal(orderNoResult.ok, true)
  assert.deepEqual(orderNoResult.data.list.map((order) => order._id), ['order_beta'])
  assert.deepEqual(orderIdResult.data.list.map((order) => order._id), ['order_alpha'])
  assert.deepEqual(clientPhoneResult.data.list.map((order) => order._id), ['order_alpha'])
  assert.equal(clientPhoneResult.data.list[0].clientContact.phone, '13800000000')
  assert.deepEqual(contactPhoneResult.data.list.map((order) => order._id), ['order_contact_phone'])
  assert.deepEqual(staffProfilePhoneResult.data.list.map((order) => order._id), ['order_alpha'])
  assert.equal(staffProfilePhoneResult.data.list[0].staffContact.phone, '13711112222')
  assert.deepEqual(staffUserPhoneResult.data.list.map((order) => order._id), ['order_beta'])
})

test('admin batchDeleteOrders soft deletes orders and hides them from list', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' },
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }
    ],
    orders: [
      { _id: 'order1', orderNo: 'O1', clientOpenid: 'openid_client', status: 'paid', createdAt: '2026-08-25 10:00' },
      { _id: 'order2', orderNo: 'O2', clientOpenid: 'openid_client', status: 'completed', createdAt: '2026-08-25 09:00' }
    ],
    admin_operation_logs: []
  })
  const adminFn = loadCloudFunction('api', db, 'openid_admin')
  const clientFn = loadCloudFunction('api', db, 'openid_client')

  const denied = await clientFn.main({ module: 'admin', action: 'batchDeleteOrders', data: { orderIds: ['order1'] } })
  const deleted = await adminFn.main({ module: 'admin', action: 'batchDeleteOrders', data: { orderIds: ['order1', 'order2'], reason: '测试删除' } })
  const list = await adminFn.main({ module: 'admin', action: 'listOrders' })
  const clientList = await clientFn.main({ module: 'order', action: 'listOrders', data: { page: 1, pageSize: 20 } })
  const clientDetail = await clientFn.main({ module: 'order', action: 'getOrderDetail', data: { id: 'order1' } })

  assert.equal(denied.ok, false)
  assert.equal(denied.message, '仅管理员可操作')
  assert.equal(deleted.ok, true)
  assert.equal(deleted.data.count, 2)
  assert.equal(db.state.orders.length, 2)
  assert.ok(db.state.orders[0].adminDeletedAt)
  assert.equal(db.state.orders[0].adminDeletedByOpenid, 'openid_admin')
  assert.equal(db.state.orders[0].adminDeletedReason, '测试删除')
  assert.equal(list.data.total, 0)
  assert.equal(clientList.data.total, 0)
  assert.equal(clientDetail.ok, false)
  assert.equal(clientDetail.message, '订单不存在')
  assert.equal(db.state.admin_operation_logs.length, 2)
})

test('client can favorite and list approved sitters without private fields', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
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
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' },
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
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' },
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
      { _id: 'client', openid: 'openid_client', nickname: '小明', roles: ['client'], status: 'active', phone: '13800000000' },
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
  await staffFn.main({ module: 'order', action: 'requestEarlyStart', data: { orderId: created.data._id, reason: '测试提前开始' } })
  await clientFn.main({ module: 'order', action: 'approveEarlyStart', data: { orderId: created.data._id } })
  await staffFn.main({ module: 'order', action: 'startService', data: { id: created.data._id } })
  for (const eventType of ['enter_door', 'pet_status', 'feed', 'water', 'leave_door']) {
    await staffFn.main({ module: 'checkin', action: 'createCheckin', data: { orderId: created.data._id, eventType, mediaFileId: 'cloud://checkin.jpg', remark: '已完成打卡', latitude: 31.2, longitude: 121.5 } })
  }
  await staffFn.main({ module: 'order', action: 'finishService', data: { id: created.data._id } })
  const review = await clientFn.main({ module: 'order', action: 'createReview', data: { orderId: created.data._id, rating: 5, tags: ['服务细心'], content: '很好' } })
  const duplicate = await clientFn.main({ module: 'order', action: 'createReview', data: { orderId: created.data._id, rating: 4 } })
  const timeline = await clientFn.main({ module: 'order', action: 'getOrderTimeline', data: { orderId: created.data._id } })

  assert.equal(review.ok, true)
  assert.equal(duplicate.ok, false)
  assert.equal(duplicate.message, '该订单已评价')
  assert.deepEqual(timeline.data.map((item) => item.type), ['created', 'paid', 'assigned', 'early_start_requested', 'early_start_approved', 'started', 'checkin', 'checkin', 'checkin', 'checkin', 'checkin', 'completed', 'reviewed'])
})

test('real-device acceptance core flow covers client staff admin lifecycle', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000', points: 0, totalPoints: 0, completedOrderCount: 0 },
      { _id: 'staff', openid: 'openid_staff', roles: ['client', 'staff'], status: 'active' },
      { _id: 'admin', openid: 'openid_admin', roles: ['admin'], status: 'active' }
    ],
    pets: [],
    home_security: [],
    user_addresses: [],
    staff_profiles: [{ _id: 'sp1', openid: 'openid_staff', realName: '王小花', auditStatus: 'approved', serviceCity: '上海', serviceAddress: '服务点', serviceLatitude: 31.2, serviceLongitude: 121.5 }],
    service_prices: [{ _id: 'price1', key: 'feed', label: '上门喂养', price: 100, enabled: true, sortOrder: 1 }],
    orders: [],
    payments: [],
    refunds: [],
    payment_events: [],
    track_logs: [],
    checkin_logs: [],
    order_timeline: [],
    service_reviews: [],
    staff_earnings: [],
    withdraw_requests: [],
    finance_logs: [],
    point_logs: [],
    retro_card_logs: [],
    order_incidents: [],
    incident_comments: [],
    incident_actions: [],
    admin_operation_logs: [],
    subscription_logs: [],
    platform_configs: [{ _id: 'cfg1', key: 'system_settings', value: { payment: { mode: 'mock' }, settlement: { staffCommissionRate: 0.8, settlementDelayDays: 0, minWithdrawAmount: 1 } } }]
  })
  const clientFn = loadCloudFunction('api', db, 'openid_client')
  const staffFn = loadCloudFunction('api', db, 'openid_staff')
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  const profile = await clientFn.main({ module: 'auth', action: 'updateProfile', data: { nickname: '小明', avatarUrl: 'https://example.com/a.png' } })
  const pet = await clientFn.main({ module: 'pet', action: 'createPet', data: { name: '可乐', species: 'dog', breed: '柯基', weight: 10, avatarFileId: 'cloud://pet.jpg' } })
  const address = await clientFn.main({ module: 'client', action: 'saveAddress', data: { label: '家', serviceAddress: '测试小区', addressDetail: '1栋', doorplate: '101', latitude: 31.21, longitude: 121.49, isDefault: true } })
  const security = await clientFn.main({ module: 'homeSecurity', action: 'saveHomeSecurity', data: { doorLockCode: '123456', keyLocation: '门垫下', entryNotes: '轻声进门' } })
  const directOrder = await clientFn.main({ module: 'order', action: 'createOrder', data: { petId: pet.data._id, serviceTypes: ['feed'], serviceAddress: '测试小区', addressDetail: '1栋', doorplate: '101', addressLatitude: 31.21, addressLongitude: 121.49, startTime: '2099-07-28 10:00', endTime: '2099-07-28 11:00', durationMinutes: 60, publishMode: 'direct', staffProfileId: 'sp1', saveAddress: true } })
  const openOrder = await clientFn.main({ module: 'order', action: 'createOrder', data: { petId: pet.data._id, serviceTypes: ['feed'], serviceAddress: '测试小区', addressDetail: '1栋', doorplate: '102', addressLatitude: 31.21, addressLongitude: 121.49, startTime: '2099-07-29 10:00', endTime: '2099-07-29 11:00', durationMinutes: 60, publishMode: 'open' } })
  await clientFn.main({ module: 'payment', action: 'mockPayOrder', data: { orderId: directOrder.data._id } })
  await clientFn.main({ module: 'payment', action: 'mockPayOrder', data: { orderId: openOrder.data._id } })
  const openAccepted = await staffFn.main({ module: 'staff', action: 'acceptOrder', data: { orderId: openOrder.data._id } })
  const directAccepted = await staffFn.main({ module: 'staff', action: 'acceptOrder', data: { orderId: directOrder.data._id } })
  await staffFn.main({ module: 'order', action: 'requestEarlyStart', data: { orderId: directOrder.data._id, reason: '验收提前开始' } })
  await clientFn.main({ module: 'order', action: 'approveEarlyStart', data: { orderId: directOrder.data._id } })
  const started = await staffFn.main({ module: 'order', action: 'startService', data: { id: directOrder.data._id } })
  const track = await staffFn.main({ module: 'track', action: 'batchUploadTrack', data: { orderId: directOrder.data._id, points: [{ clientPointId: 'p1', batchId: 'b1', latitude: 31.21, longitude: 121.49, recordedAt: '2099-07-28 10:05', isBackfilled: false }, { clientPointId: 'p2', batchId: 'b1', latitude: 31.22, longitude: 121.5, recordedAt: '2099-07-28 10:06', isBackfilled: true }] } })
  const duplicateTrack = await staffFn.main({ module: 'track', action: 'batchUploadTrack', data: { orderId: directOrder.data._id, points: [{ clientPointId: 'p2', batchId: 'b2', latitude: 31.22, longitude: 121.5, recordedAt: '2099-07-28 10:06', isBackfilled: true }] } })
  for (const eventType of ['enter_door', 'pet_status', 'feed', 'water', 'leave_door']) {
    await staffFn.main({ module: 'checkin', action: 'createCheckin', data: { orderId: directOrder.data._id, eventType, mediaFileId: 'cloud://checkin.jpg', remark: '已完成', latitude: 31.21, longitude: 121.49, clientRequestId: `checkin_${eventType}` } })
  }
  const finished = await staffFn.main({ module: 'order', action: 'finishService', data: { id: directOrder.data._id, clientRequestId: 'finish_e2e' } })
  const report = await clientFn.main({ module: 'order', action: 'getServiceReport', data: { id: directOrder.data._id } })
  const review = await clientFn.main({ module: 'order', action: 'createReview', data: { orderId: directOrder.data._id, rating: 5, content: '服务很好' } })
  const balance = await staffFn.main({ module: 'finance', action: 'getStaffBalance', data: {} })
  const withdraw = await staffFn.main({ module: 'finance', action: 'createWithdrawRequest', data: { accountName: '王小花', accountNo: 'wxid_staff', clientRequestId: 'withdraw_e2e' } })
  const approved = await adminFn.main({ module: 'admin', action: 'auditWithdrawRequest', data: { id: withdraw.data._id, approved: true } })
  const paidWithdraw = await adminFn.main({ module: 'admin', action: 'markWithdrawPaid', data: { id: withdraw.data._id } })
  const finance = await adminFn.main({ module: 'admin', action: 'financeDashboard', data: {} })
  const incident = await clientFn.main({ module: 'incident', action: 'createComplaint', data: { orderId: directOrder.data._id, description: '补充测试投诉', clientRequestId: 'incident_e2e' } })
  const resolution = await adminFn.main({ module: 'incident', action: 'proposeResolution', data: { incidentId: incident.data._id, resolutionType: 'explain', resolutionText: '已跟进说明' } })
  const closed = await adminFn.main({ module: 'incident', action: 'closeIncident', data: { incidentId: incident.data._id, status: 'closed', closeRemark: '验收结案' } })
  const detail = await clientFn.main({ module: 'incident', action: 'getIncidentDetail', data: { id: incident.data._id } })

  assert.equal(profile.ok, true)
  assert.equal(address.ok, true)
  assert.equal(security.ok, true)
  assert.equal(openAccepted.ok, true)
  assert.equal(directAccepted.ok, true)
  assert.equal(started.ok, true)
  assert.equal(track.data.count, 2)
  assert.equal(duplicateTrack.data.count, 0)
  assert.equal(finished.ok, true)
  assert.equal(report.data.tracks.length, 2)
  assert.equal(report.data.checkins.length, 5)
  assert.equal(review.ok, true)
  assert.equal(balance.data.available, 80)
  assert.equal(withdraw.ok, true)
  assert.equal(approved.data.status, 'approved')
  assert.equal(paidWithdraw.data.status, 'paid')
  assert.equal(finance.data.counts.withdraws, 1)
  assert.equal(resolution.ok, true)
  assert.equal(closed.data.status, 'closed')
  assert.equal(detail.data.incident.status, 'closed')
})


test('client cancel order returns MVP refund quote and writes cancelled timeline', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
    orders: [{ _id: 'order1', clientOpenid: 'openid_client', status: 'assigned', paymentStatus: 'paid', paymentNo: 'P1', payAmount: 100, startTime: '2000-07-28 10:00' }],
    refunds: [],
    payment_events: [],
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
  assert.equal(order.paymentStatus, 'refunding')
  assert.equal(order.refundStatus, 'processing')
  assert.equal(db.state.refunds.length, 1)
  assert.equal(db.state.refunds[0].refundAmount, 80)
  assert.equal(db.state.order_timeline[0].type, 'cancelled')
})


test('coupon quote auto applies best available coupon', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
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
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
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
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
    pets: [{ _id: 'p1', openid: 'openid_client', name: '可乐', weight: 12 }],
    orders: [],
    user_coupons: [
      { _id: 'c1', openid: 'openid_client', userId: 'u1', templateId: 't1', status: 'available', validFrom: '2026-01-01T00:00:00.000Z', validTo: '2099-01-01T00:00:00.000Z', templateSnapshot: { name: '满80减20', type: 'fixed', discountAmount: 20, minOrderAmount: 80, applicableServiceTypes: [] } }
    ],
    order_timeline: []
  })
  const fn = loadCloudFunction('api', db, 'openid_client')
  const data = { petId: 'p1', serviceTypes: ['walk'], serviceAddress: '测试地址', addressDetail: '1栋101', doorplate: '101', startTime: '2099-07-28 10:00', endTime: '2099-07-28 11:00', durationMinutes: 60, couponId: 'c1' }

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

test('system records subscription consent results', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
    subscription_consents: []
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const result = await fn.main({ module: 'system', action: 'recordSubscriptionConsent', data: { templateKeys: ['orderPaid'], templateIds: { orderPaid: 'tpl_paid' }, results: { tpl_paid: 'accept' }, scene: 'client_pay' } })

  assert.equal(result.ok, true)
  assert.equal(result.data.count, 1)
  assert.equal(db.state.subscription_consents[0].templateKey, 'orderPaid')
  assert.equal(db.state.subscription_consents[0].status, 'accept')
})


test('payment create status mock pay and admin refund permissions work', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' },
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' }
    ],
    orders: [{ _id: 'order1', orderNo: 'O1', clientOpenid: 'openid_client', status: 'pending_pay', paymentStatus: 'unpaid', payAmount: 88 }],
    payments: [],
    refunds: [],
    payment_events: [],
    finance_logs: [],
    order_timeline: [],
    user_coupons: [],
    subscription_logs: [],
    platform_configs: []
  })
  const clientFn = loadCloudFunction('api', db, 'openid_client')
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  const created = await clientFn.main({ module: 'payment', action: 'createPayment', data: { orderId: 'order1' } })
  const statusBeforePay = await clientFn.main({ module: 'payment', action: 'getPaymentStatus', data: { orderId: 'order1' } })
  const paid = await clientFn.main({ module: 'payment', action: 'mockPayOrder', data: { orderId: 'order1', paymentNo: created.data.paymentNo } })
  const clientRefund = await clientFn.main({ module: 'payment', action: 'createRefund', data: { orderId: 'order1' } })
  const adminRefund = await adminFn.main({ module: 'payment', action: 'createRefund', data: { orderId: 'order1', refundAmount: 30, reason: '测试退款' } })
  const refunds = await adminFn.main({ module: 'payment', action: 'listRefunds', data: { orderId: 'order1' } })
  const order = db.state.orders.find((item) => item._id === 'order1')

  assert.equal(created.ok, true)
  assert.equal(created.data.mock, true)
  assert.equal(statusBeforePay.data.paymentStatus, 'paying')
  assert.equal(paid.ok, true)
  assert.equal(order.status, 'paid')
  assert.equal(order.paymentStatus, 'refunding')
  assert.equal(clientRefund.ok, false)
  assert.equal(adminRefund.ok, true)
  assert.equal(adminRefund.data.refundAmount, 30)
  assert.equal(refunds.data.length, 1)
})


test('wechat payment settings mask secrets in public responses', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'admin', openid: 'openid_admin', roles: ['admin'], status: 'active' }],
    platform_configs: [],
    admin_operation_logs: []
  })
  const adminFn = loadCloudFunction('api', db, 'openid_admin')
  const guestFn = loadCloudFunction('api', db, 'openid_guest')

  const saved = await adminFn.main({ module: 'admin', action: 'saveSystemSettings', data: { payment: { enabled: true, mode: 'wechat', mchId: 'mch_1', appId: 'app_1', notifyUrl: 'https://pay.example.com/callback', certSerialNo: 'serial_1', apiV3KeyInput: 'secret_v3_key', privateKeyInput: testPrivateKey, platformPublicKeyInput: 'public_key' } } })
  const publicSettings = await guestFn.main({ module: 'system', action: 'getSettings' })

  assert.equal(saved.ok, true)
  assert.equal(saved.data.payment.apiV3KeyConfigured, true)
  assert.equal(saved.data.payment.apiV3Key, undefined)
  assert.equal(publicSettings.data.payment.privateKey, undefined)
  assert.equal(db.state.platform_configs[0].value.payment.apiV3Key, 'secret_v3_key')
  assert.equal(db.state.admin_operation_logs[0].detail.payment.apiV3Key, undefined)

  const preserved = await adminFn.main({ module: 'admin', action: 'saveSystemSettings', data: { payment: { mchId: 'mch_2' } } })
  assert.equal(preserved.data.payment.mode, 'wechat')
  assert.equal(preserved.data.payment.enabled, true)
  assert.equal(db.state.platform_configs[0].value.payment.apiV3Key, 'secret_v3_key')
})


test('wechat create payment returns pay params and reuses duplicate clientRequestId', async () => {
  await withEnv({ WECHAT_PAY_MOCK_PREPAY_ID: 'mock_prepay_1' }, async () => {
    const db = createCollectionStore({
      users: [{ _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
      orders: [{ _id: 'order1', orderNo: 'O1', clientOpenid: 'openid_client', status: 'pending_pay', paymentStatus: 'unpaid', payAmount: 88, serviceSummary: '上门喂养' }],
      payments: [],
      payment_events: [],
      platform_configs: [{ _id: 'cfg1', key: 'system_settings', value: { payment: { enabled: true, mode: 'wechat', mchId: 'mch_1', appId: 'app_1', notifyUrl: 'https://pay.example.com/callback', certSerialNo: 'serial_1', apiV3Key: '12345678901234567890123456789012', privateKey: testPrivateKey } } }],
      user_coupons: []
    })
    const fn = loadCloudFunction('api', db, 'openid_client')

    const created = await fn.main({ module: 'payment', action: 'createPayment', data: { orderId: 'order1', clientRequestId: 'pay_once' } })
    const duplicate = await fn.main({ module: 'payment', action: 'createPayment', data: { orderId: 'order1', clientRequestId: 'pay_once' } })

    assert.equal(created.ok, true)
    assert.equal(created.data.mock, false)
    assert.equal(created.data.payParams.package, 'prepay_id=mock_prepay_1')
    assert.equal(duplicate.data.paymentNo, created.data.paymentNo)
    assert.equal(db.state.payments.length, 1)
    assert.equal(db.state.payments[0].channel, 'wechat')
    assert.equal(db.state.payments[0].prepayId, 'mock_prepay_1')
    assert.equal(db.state.payments[0].rawRequest.payer.openid, 'configured')
  })
})


test('wechat callback marks paid idempotently and rejects amount mismatch', async () => {
  const callbackPayload = { appid: 'app_1', mchid: 'mch_1', out_trade_no: 'P1', transaction_id: 'WX1', trade_state: 'SUCCESS', amount: { total: 8800, currency: 'CNY' } }
  await withEnv({ WECHAT_PAY_SKIP_VERIFY: 'true', WECHAT_PAY_MOCK_CALLBACK_RESOURCE: JSON.stringify(callbackPayload) }, async () => {
    const db = createCollectionStore({
      users: [{ _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
      orders: [{ _id: 'order1', orderNo: 'O1', clientOpenid: 'openid_client', status: 'pending_pay', paymentStatus: 'paying', payAmount: 88, paymentNo: 'P1' }],
      payments: [{ _id: 'pay1', orderId: 'order1', orderNo: 'O1', openid: 'openid_client', paymentNo: 'P1', amount: 88, status: 'pending', channel: 'wechat' }],
      payment_events: [],
      finance_logs: [],
      order_timeline: [],
      user_coupons: [],
      subscription_logs: [],
      platform_configs: [{ _id: 'cfg1', key: 'system_settings', value: { payment: { enabled: true, mode: 'wechat', mchId: 'mch_1', appId: 'app_1', notifyUrl: 'https://pay.example.com/callback', certSerialNo: 'serial_1', apiV3Key: '12345678901234567890123456789012', privateKey: testPrivateKey } } }]
    })
    const fn = loadCloudFunction('api', db, '')
    const body = JSON.stringify({ resource: { ciphertext: 'mock' } })

    const first = await fn.main({ module: 'payment', action: 'paymentCallback', data: { body, headers: {} } })
    const second = await fn.main({ module: 'payment', action: 'paymentCallback', data: { body, headers: {} } })

    assert.equal(first.ok, true)
    assert.equal(first.data.code, 'SUCCESS')
    assert.equal(second.data.code, 'SUCCESS')
    assert.equal(db.state.orders[0].paymentStatus, 'paid')
    assert.equal(db.state.orders[0].wxTransactionId, 'WX1')
    assert.equal(db.state.finance_logs.length, 1)
  })

  await withEnv({ WECHAT_PAY_SKIP_VERIFY: 'true', WECHAT_PAY_MOCK_CALLBACK_RESOURCE: JSON.stringify(callbackPayload) }, async () => {
    const db = createCollectionStore({
      orders: [{ _id: 'order1', orderNo: 'O1', clientOpenid: 'openid_client', status: 'pending_pay', paymentStatus: 'paying', payAmount: 88, paymentNo: 'P1' }],
      payments: [{ _id: 'pay1', orderId: 'order1', orderNo: 'O1', openid: 'openid_client', paymentNo: 'P1', amount: 88, status: 'pending', channel: 'wechat' }],
      payment_events: [],
      finance_logs: [],
      order_timeline: [],
      user_coupons: [],
      subscription_logs: [],
      platform_configs: [{ _id: 'cfg1', key: 'system_settings', value: { payment: { enabled: true, mode: 'wechat', mchId: 'mch_1', appId: 'app_1', notifyUrl: 'https://pay.example.com/callback', certSerialNo: 'serial_1', apiV3Key: '12345678901234567890123456789012', privateKey: testPrivateKey } } }]
    })
    const fn = loadCloudFunction('api', db, '')
    const direct = await fn.main({ httpMethod: 'POST', headers: { 'Wechatpay-Timestamp': '1' }, body: JSON.stringify({ resource: { ciphertext: 'mock' } }) })
    assert.equal(direct.code, 'SUCCESS')
    assert.equal(direct.ok, undefined)
    assert.equal(db.state.orders[0].paymentStatus, 'paid')
  })

  await withEnv({ WECHAT_PAY_SKIP_VERIFY: 'true', WECHAT_PAY_MOCK_CALLBACK_RESOURCE: JSON.stringify({ ...callbackPayload, amount: { total: 1, currency: 'CNY' } }) }, async () => {
    const db = createCollectionStore({
      orders: [{ _id: 'order1', orderNo: 'O1', clientOpenid: 'openid_client', status: 'pending_pay', paymentStatus: 'paying', payAmount: 88, paymentNo: 'P1' }],
      payments: [{ _id: 'pay1', orderId: 'order1', paymentNo: 'P1', amount: 88, status: 'pending', channel: 'wechat' }],
      payment_events: [],
      platform_configs: [{ _id: 'cfg1', key: 'system_settings', value: { payment: { enabled: true, mode: 'wechat', mchId: 'mch_1', appId: 'app_1', notifyUrl: 'https://pay.example.com/callback', certSerialNo: 'serial_1', apiV3Key: '12345678901234567890123456789012', privateKey: testPrivateKey } } }]
    })
    const fn = loadCloudFunction('api', db, '')
    const result = await fn.main({ module: 'payment', action: 'paymentCallback', data: { body: JSON.stringify({ resource: { ciphertext: 'mock' } }), headers: {} } })
    assert.equal(result.data.code, 'FAIL')
    assert.match(result.data.message, /金额不匹配/)
  })
})


test('wechat refund request updates refund record and keeps idempotency', async () => {
  await withEnv({ WECHAT_PAY_MOCK_REFUND_ID: 'wx_refund_1', WECHAT_PAY_MOCK_REFUND_STATUS: 'PROCESSING' }, async () => {
    const db = createCollectionStore({
      users: [{ _id: 'admin', openid: 'openid_admin', roles: ['admin'], status: 'active' }],
      orders: [{ _id: 'order1', orderNo: 'O1', clientOpenid: 'openid_client', status: 'paid', paymentStatus: 'paid', paymentNo: 'P1', wxTransactionId: 'WX1', payAmount: 88 }],
      refunds: [],
      payment_events: [],
      order_timeline: [],
      admin_operation_logs: [],
      platform_configs: [{ _id: 'cfg1', key: 'system_settings', value: { payment: { enabled: true, mode: 'wechat', mchId: 'mch_1', appId: 'app_1', notifyUrl: 'https://pay.example.com/callback', certSerialNo: 'serial_1', apiV3Key: '12345678901234567890123456789012', privateKey: testPrivateKey, refundEnabled: true } } }],
      subscription_logs: []
    })
    const fn = loadCloudFunction('api', db, 'openid_admin')

    const refund = await fn.main({ module: 'payment', action: 'createRefund', data: { orderId: 'order1', refundAmount: 30, reason: '测试退款', clientRequestId: 'refund_once' } })
    const duplicate = await fn.main({ module: 'payment', action: 'createRefund', data: { orderId: 'order1', refundAmount: 30, reason: '测试退款', clientRequestId: 'refund_once' } })

    assert.equal(refund.ok, true)
    assert.equal(refund.data.wxRefundId, 'wx_refund_1')
    assert.equal(refund.data.status, 'processing')
    assert.equal(duplicate.data.refundNo, refund.data.refundNo)
    assert.equal(db.state.refunds.length, 1)
    assert.equal(db.state.refunds[0].rawRequest.amount.refund, 3000)
  })
})


test('coupon payment marks coupon used and cancel unpaid releases coupon', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
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
  const base = { petId: 'p1', serviceTypes: ['walk'], serviceAddress: '测试地址', addressDetail: '1栋101', doorplate: '101', startTime: '2099-07-28 10:00', endTime: '2099-07-28 11:00', durationMinutes: 60 }

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
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }
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

test('track and checkin backfill are idempotent', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'staff', openid: 'openid_staff', roles: ['client', 'staff'], status: 'active' }],
    orders: [{ _id: 'order1', clientOpenid: 'openid_client', staffOpenid: 'openid_staff', status: 'in_service', requiredCheckins: [] }],
    track_logs: [],
    checkin_logs: [],
    order_timeline: [],
    platform_configs: []
  })
  const fn = loadCloudFunction('api', db, 'openid_staff')

  const track1 = await fn.main({ module: 'track', action: 'batchUploadTrack', data: { orderId: 'order1', batchId: 'batch1', points: [{ clientPointId: 'pt1', latitude: 31.2, longitude: 121.5, recordedAt: 1000, isBackfilled: true }] } })
  const track2 = await fn.main({ module: 'track', action: 'batchUploadTrack', data: { orderId: 'order1', batchId: 'batch1', points: [{ clientPointId: 'pt1', latitude: 31.2, longitude: 121.5, recordedAt: 1000, isBackfilled: true }] } })
  const checkin1 = await fn.main({ module: 'checkin', action: 'createCheckin', data: { orderId: 'order1', eventType: 'feed', mediaFileId: 'cloud://checkin.jpg', latitude: 31.2, longitude: 121.5, clientRequestId: 'ck1', recordedAt: 1000, isBackfilled: true } })
  const checkin2 = await fn.main({ module: 'checkin', action: 'createCheckin', data: { orderId: 'order1', eventType: 'feed', mediaFileId: 'cloud://checkin.jpg', latitude: 31.2, longitude: 121.5, clientRequestId: 'ck1', recordedAt: 1000, isBackfilled: true } })

  assert.equal(track1.ok, true)
  assert.equal(track1.data.count, 1)
  assert.equal(track2.data.count, 0)
  assert.equal(db.state.track_logs.length, 1)
  assert.equal(db.state.track_logs[0].isBackfilled, true)
  assert.equal(checkin1.ok, true)
  assert.equal(checkin2.ok, true)
  assert.equal(checkin1.data._id, checkin2.data._id)
  assert.equal(db.state.checkin_logs.length, 1)
  assert.equal(db.state.checkin_logs[0].isBackfilled, true)
})


test('incident workflow supports client complaint comments status and earning freeze', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' },
      { _id: 'staff', openid: 'openid_staff', roles: ['client', 'staff'], status: 'active' },
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' }
    ],
    orders: [{ _id: 'order1', clientOpenid: 'openid_client', staffOpenid: 'openid_staff', staffProfileId: 'sp1', status: 'completed', serviceSummary: '上门喂养' }],
    order_incidents: [],
    incident_comments: [],
    incident_actions: [],
    order_timeline: [],
    staff_earnings: [{ _id: 'earn1', orderId: 'order1', staffOpenid: 'openid_staff', status: 'available', amount: 70 }],
    finance_logs: []
  })
  const clientFn = loadCloudFunction('api', db, 'openid_client')
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  const created = await clientFn.main({ module: 'incident', action: 'createComplaint', data: { orderId: 'order1', title: '服务投诉', description: '猫粮没有补满' } })
  const comment = await clientFn.main({ module: 'incident', action: 'appendIncidentComment', data: { incidentId: created.data._id, content: '补充说明' } })
  const frozen = await adminFn.main({ module: 'incident', action: 'freezeStaffEarning', data: { incidentId: created.data._id } })
  const resolution = await adminFn.main({ module: 'incident', action: 'proposeResolution', data: { incidentId: created.data._id, resolutionType: 'refund', refundAmount: 20, content: '建议部分退款' } })
  const closed = await adminFn.main({ module: 'incident', action: 'closeIncident', data: { incidentId: created.data._id, status: 'resolved', closeRemark: '已协商' } })
  const detail = await clientFn.main({ module: 'incident', action: 'getIncidentDetail', data: { incidentId: created.data._id } })

  assert.equal(created.ok, true)
  assert.equal(created.data.clientOpenid, 'openid_client')
  assert.equal(comment.ok, true)
  assert.equal(db.state.incident_comments.length, 1)
  assert.deepEqual(frozen.data.frozenEarningIds, ['earn1'])
  assert.equal(db.state.staff_earnings[0].status, 'frozen')
  assert.equal(resolution.data.resolution.refundAmount, 20)
  assert.equal(closed.data.status, 'resolved')
  assert.equal(detail.data.comments.length, 1)
})


test('admin finance dashboard summarizes payments refunds earnings and withdraws', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' }],
    orders: [
      { _id: 'order1', status: 'completed', paymentStatus: 'paid', payAmount: 100, paidAt: '2099-07-28 10:00' },
      { _id: 'order2', status: 'completed', paymentStatus: 'paid', payAmount: 50, paidAt: '2026-07-29 10:00' }
    ],
    payments: [{ _id: 'pay1', status: 'paid', amount: 100, paidAt: '2099-07-28 10:01' }],
    refunds: [{ _id: 'refund1', status: 'processing', amount: 20, createdAt: '2099-07-28 11:00' }],
    staff_earnings: [{ _id: 'earn1', status: 'available', amount: 70, createdAt: '2099-07-28 12:00' }],
    withdraw_requests: [{ _id: 'withdraw1', status: 'pending', amount: 30, createdAt: '2099-07-28 13:00' }],
    finance_logs: [{ _id: 'log1', action: 'staff_earning_created', targetType: 'staff_earning', amountDelta: 70, createdAt: '2099-07-28 12:00' }]
  })
  const fn = loadCloudFunction('api', db, 'openid_admin')

  const dashboard = await fn.main({ module: 'admin', action: 'financeDashboard', data: { startDate: '2099-07-28', endDate: '2099-07-28' } })
  const payments = await fn.main({ module: 'admin', action: 'listPayments', data: { startDate: '2099-07-28', endDate: '2099-07-28' } })
  const logs = await fn.main({ module: 'admin', action: 'listFinanceLogs', data: { startDate: '2099-07-28', endDate: '2099-07-28' } })

  assert.equal(dashboard.ok, true)
  assert.equal(dashboard.data.metrics.gmv, 100)
  assert.equal(dashboard.data.metrics.received, 100)
  assert.equal(dashboard.data.metrics.refundAmount, 20)
  assert.equal(dashboard.data.metrics.netRevenue, 80)
  assert.equal(dashboard.data.metrics.staffEarningAmount, 70)
  assert.equal(dashboard.data.metrics.platformGrossProfit, 10)
  assert.equal(dashboard.data.metrics.pendingWithdrawAmount, 30)
  assert.equal(payments.data.length, 1)
  assert.equal(logs.data.length, 1)
})


test('staff schedule exceptions and order conflicts block unavailable slots', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' },
      { _id: 'staff', openid: 'openid_staff', roles: ['client', 'staff'], status: 'active' }
    ],
    pets: [{ _id: 'pet1', openid: 'openid_client', name: '可乐', weight: 10 }],
    staff_profiles: [{ _id: 'sp1', openid: 'openid_staff', auditStatus: 'approved', realName: '王小花', serviceAddress: '固定地址', serviceLatitude: 31.2, serviceLongitude: 121.5, serviceRadiusKm: 5, weeklySchedule: { '2': [{ start: 9, end: 18 }] } }],
    staff_schedule_exceptions: [],
    orders: [],
    user_addresses: [],
    user_coupons: [],
    coupon_templates: [],
    order_timeline: []
  })
  const staffFn = loadCloudFunction('api', db, 'openid_staff')
  const clientFn = loadCloudFunction('api', db, 'openid_client')

  const rest = await staffFn.main({ module: 'staff', action: 'saveScheduleException', data: { dateKey: '2099-07-28', status: 'unavailable', remark: '休息' } })
  const blocked = await clientFn.main({ module: 'order', action: 'quoteOrder', data: { petId: 'pet1', publishMode: 'direct', staffProfileId: 'sp1', serviceTypes: ['walk'], addressLatitude: 31.21, addressLongitude: 121.51, startTime: '2099-07-28 10:00', endTime: '2099-07-28 11:00', durationMinutes: 60 } })
  const available = await staffFn.main({ module: 'staff', action: 'saveScheduleException', data: { dateKey: '2099-07-28', status: 'available', slots: [{ start: 10, end: 12 }] } })
  const order = await clientFn.main({ module: 'order', action: 'createOrder', data: { petId: 'pet1', publishMode: 'direct', staffProfileId: 'sp1', serviceTypes: ['walk'], serviceAddress: '测试地址', addressDetail: '1栋', doorplate: '101', addressLatitude: 31.21, addressLongitude: 121.51, startTime: '2099-07-28 10:00', endTime: '2099-07-28 11:00', durationMinutes: 60 } })
  db.state.orders.push({ _id: 'busy1', clientOpenid: 'other_client', staffOpenid: 'openid_staff', staffProfileId: 'sp1', status: 'assigned', startTime: '2099-07-28 10:30', endTime: '2099-07-28 11:30' })
  db.state.orders.push({ _id: 'open1', clientOpenid: 'openid_client', status: 'paid', startTime: '2099-07-28 11:00', endTime: '2099-07-28 12:00' })
  const conflict = await staffFn.main({ module: 'staff', action: 'acceptOrder', data: { orderId: 'open1' } })

  assert.equal(rest.ok, true)
  assert.equal(blocked.ok, false)
  assert.match(blocked.message, /休息/)
  assert.equal(available.ok, true)
  assert.equal(order.ok, true)
  assert.equal(conflict.ok, false)
  assert.match(conflict.message, /已有订单/)
})


test('finishService creates staff earning and withdraw workflow locks earnings', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000', points: 0, totalPoints: 0, completedOrderCount: 0 },
      { _id: 'staff', openid: 'openid_staff', roles: ['client', 'staff'], status: 'active' },
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' }
    ],
    orders: [{ _id: 'order1', orderNo: 'O1', clientOpenid: 'openid_client', clientUserId: 'client', staffOpenid: 'openid_staff', staffUserId: 'staff', staffProfileId: 'sp1', status: 'in_service', payAmount: 100, requiredCheckins: [] }],
    staff_earnings: [],
    withdraw_requests: [],
    finance_logs: [],
    point_logs: [],
    retro_card_logs: [],
    order_timeline: [],
    subscription_logs: [],
    platform_configs: [{ _id: 'cfg1', key: 'system_settings', value: { settlement: { staffCommissionRate: 0.8, settlementDelayDays: 0, minWithdrawAmount: 10 } } }]
  })
  const staffFn = loadCloudFunction('api', db, 'openid_staff')
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  const finished = await staffFn.main({ module: 'order', action: 'finishService', data: { id: 'order1' } })
  const balance = await staffFn.main({ module: 'finance', action: 'getStaffBalance', data: {} })
  const withdraw = await staffFn.main({ module: 'finance', action: 'createWithdrawRequest', data: { accountName: '王小花', accountNo: 'wxid_staff' } })
  const approved = await adminFn.main({ module: 'admin', action: 'auditWithdrawRequest', data: { id: withdraw.data._id, approved: true } })
  const paid = await adminFn.main({ module: 'admin', action: 'markWithdrawPaid', data: { id: withdraw.data._id } })

  assert.equal(finished.ok, true)
  assert.equal(db.state.staff_earnings.length, 1)
  assert.equal(db.state.staff_earnings[0].amount, 80)
  assert.equal(balance.data.available, 80)
  assert.equal(withdraw.ok, true)
  assert.equal(db.state.staff_earnings[0].status, 'withdrawn')
  assert.equal(approved.data.status, 'approved')
  assert.equal(paid.data.status, 'paid')
})


test('critical write APIs ignore duplicate clientRequestId submissions', async () => {
  const paymentDb = createCollectionStore({
    users: [{ _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
    orders: [{ _id: 'order_pay', orderNo: 'OP1', clientOpenid: 'openid_client', status: 'pending_pay', paymentStatus: 'unpaid', payAmount: 88 }],
    payments: [],
    payment_events: [],
    order_timeline: [],
    platform_configs: []
  })
  const paymentFn = loadCloudFunction('api', paymentDb, 'openid_client')
  const firstPayment = await paymentFn.main({ module: 'payment', action: 'createPayment', data: { orderId: 'order_pay', clientRequestId: 'pay_req_1' } })
  const duplicatePayment = await paymentFn.main({ module: 'payment', action: 'createPayment', data: { orderId: 'order_pay', clientRequestId: 'pay_req_1' } })

  assert.equal(firstPayment.ok, true)
  assert.equal(duplicatePayment.data.paymentNo, firstPayment.data.paymentNo)
  assert.equal(paymentDb.state.payments.length, 1)

  const cancelDb = createCollectionStore({
    users: [{ _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
    orders: [{ _id: 'order_cancel', orderNo: 'OC1', clientOpenid: 'openid_client', status: 'assigned', paymentStatus: 'paid', paymentNo: 'P1', payAmount: 100, startTime: '2000-07-28 10:00' }],
    refunds: [],
    payment_events: [],
    order_timeline: []
  })
  const cancelFn = loadCloudFunction('api', cancelDb, 'openid_client')
  const firstCancel = await cancelFn.main({ module: 'order', action: 'cancelOrder', data: { orderId: 'order_cancel', reason: '行程变化', clientRequestId: 'cancel_req_1' } })
  const duplicateCancel = await cancelFn.main({ module: 'order', action: 'cancelOrder', data: { orderId: 'order_cancel', reason: '行程变化', clientRequestId: 'cancel_req_1' } })

  assert.equal(firstCancel.ok, true)
  assert.equal(duplicateCancel.ok, true)
  assert.equal(cancelDb.state.refunds.length, 1)
  assert.equal(cancelDb.state.order_timeline.length, 2)

  const incidentDb = createCollectionStore({
    users: [{ _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }],
    orders: [{ _id: 'order_incident', clientOpenid: 'openid_client', staffOpenid: 'openid_staff', status: 'completed' }],
    order_incidents: [],
    incident_actions: [],
    order_timeline: []
  })
  const incidentFn = loadCloudFunction('api', incidentDb, 'openid_client')
  const firstIncident = await incidentFn.main({ module: 'incident', action: 'createComplaint', data: { orderId: 'order_incident', title: '服务投诉', description: '猫粮没有补满', clientRequestId: 'complaint_req_1' } })
  const duplicateIncident = await incidentFn.main({ module: 'incident', action: 'createComplaint', data: { orderId: 'order_incident', title: '服务投诉', description: '猫粮没有补满', clientRequestId: 'complaint_req_1' } })

  assert.equal(firstIncident.ok, true)
  assert.equal(duplicateIncident.data._id, firstIncident.data._id)
  assert.equal(incidentDb.state.order_incidents.length, 1)
  assert.equal(incidentDb.state.incident_actions.length, 1)
})


test('service finish and withdraw requests are idempotent', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000', points: 0, totalPoints: 0, completedOrderCount: 0 },
      { _id: 'staff', openid: 'openid_staff', roles: ['client', 'staff'], status: 'active' }
    ],
    orders: [{ _id: 'order1', orderNo: 'O1', clientOpenid: 'openid_client', clientUserId: 'client', staffOpenid: 'openid_staff', staffUserId: 'staff', staffProfileId: 'sp1', status: 'in_service', payAmount: 100, requiredCheckins: [] }],
    staff_earnings: [],
    withdraw_requests: [],
    finance_logs: [],
    point_logs: [],
    retro_card_logs: [],
    order_timeline: [],
    subscription_logs: [],
    platform_configs: [{ _id: 'cfg1', key: 'system_settings', value: { settlement: { staffCommissionRate: 0.8, settlementDelayDays: 0, minWithdrawAmount: 10 } } }]
  })
  const staffFn = loadCloudFunction('api', db, 'openid_staff')

  const firstFinish = await staffFn.main({ module: 'order', action: 'finishService', data: { id: 'order1', clientRequestId: 'finish_req_1' } })
  const duplicateFinish = await staffFn.main({ module: 'order', action: 'finishService', data: { id: 'order1', clientRequestId: 'finish_req_1' } })
  const firstWithdraw = await staffFn.main({ module: 'finance', action: 'createWithdrawRequest', data: { accountName: '王小花', accountNo: 'wxid_staff', clientRequestId: 'withdraw_req_1' } })
  const duplicateWithdraw = await staffFn.main({ module: 'finance', action: 'createWithdrawRequest', data: { accountName: '王小花', accountNo: 'wxid_staff', clientRequestId: 'withdraw_req_1' } })

  assert.equal(firstFinish.ok, true)
  assert.equal(duplicateFinish.ok, true)
  assert.equal(db.state.staff_earnings.length, 1)
  assert.equal(db.state.point_logs.length, 1)
  assert.equal(db.state.users.find((item) => item._id === 'client').completedOrderCount, 1)
  assert.equal(firstWithdraw.ok, true)
  assert.equal(duplicateWithdraw.data._id, firstWithdraw.data._id)
  assert.equal(db.state.withdraw_requests.length, 1)
  assert.equal(db.state.staff_earnings[0].status, 'withdrawing')
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

  const level = await fn.main({ module: 'admin', action: 'saveMemberLevel', data: { name: '钻石会员', badgeTag: 'VIP-DIAMOND', nameColor: '#b87333', nameEffect: 'purple_neon', badgeStyle: 'bronze', minPoints: 300, pointMultiplier: 3, description: '高阶会员', benefits: ['专属券', '高倍积分'] } })
  const coupon = await fn.main({ module: 'admin', action: 'saveCouponTemplate', data: { name: '月度券', discountAmount: 20, minOrderAmount: 80, validType: 'fixed_range', validFromFixed: '2026-08-01', validToFixed: '2026-08-31', displayTag: '月度奖励', claimNotice: '限时领取', useNotice: '按规则使用', perUserLimit: 2, enabled: true } })

  assert.equal(level.ok, true)
  assert.equal(level.data.badgeTag, 'VIP-DIAM')
  assert.equal(level.data.nameColor, '#b87333')
  assert.equal(level.data.nameEffect, 'purple_neon')
  assert.equal(level.data.badgeStyle, 'bronze')
  assert.equal(level.data.pointMultiplier, 3)
  assert.deepEqual(level.data.benefits, ['专属券', '高倍积分'])
  assert.equal(coupon.ok, true)
  assert.equal(coupon.data.validType, 'fixed_range')
  assert.equal(coupon.data.displayTag, '月度奖励')
})

test('member level visual fields are normalized before storage', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' }],
    member_levels: [],
    admin_operation_logs: []
  })
  const fn = loadCloudFunction('api', db, 'openid_admin')

  const result = await fn.main({ module: 'admin', action: 'saveMemberLevel', data: { name: '测试会员', badgeTag: 'VIPVIPVIP', nameColor: 'red;background:red', nameEffect: 'unknown-effect', badgeStyle: 'bad style' } })

  assert.equal(result.ok, true)
  assert.equal(result.data.badgeTag, 'VIPVIPVI')
  assert.equal(result.data.nameColor, '')
  assert.equal(result.data.nameEffect, 'none')
  assert.equal(result.data.badgeStyle, 'gold')
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
      serviceRadiusKm: 5,
      idCardFrontFileId: 'cloud://id-front.jpg',
      idCardBackFileId: 'cloud://id-back.jpg',
      facePhotoFileId: 'cloud://face.jpg'
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
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' },
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
      startTime: '2099-08-03 08:00',
      endTime: '2099-08-03 09:00',
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
      startTime: '2099-08-03 10:00',
      endTime: '2099-08-03 11:00',
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
      startTime: '2099-08-03 10:00',
      endTime: '2099-08-03 11:00',
      durationMinutes: 60
    }
  })
  assert.equal(validOrder.ok, true)
  assert.equal(validOrder.data.status, 'pending_pay')
})

test('createOrder supports overnight sitter schedule time validation', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' },
      { _id: 'u_sitter', openid: 'openid_sitter', roles: ['client', 'staff'], status: 'active' }
    ],
    pets: [{ _id: 'p1', openid: 'openid_client', name: '豆豆', weight: 8 }],
    staff_profiles: [
      {
        _id: 'sitter_overnight',
        openid: 'openid_sitter',
        auditStatus: 'approved',
        serviceAddress: '陆家嘴中心',
        serviceLatitude: 31.2,
        serviceLongitude: 121.5,
        serviceRadiusKm: 10,
        weeklySchedule: {
          '1': [{ start: 22, end: 24 }],
          '2': [{ start: 0, end: 2 }]
        }
      }
    ],
    orders: []
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const overnightOrder = await fn.main({
    module: 'order',
    action: 'createOrder',
    data: {
      petId: 'p1',
      publishMode: 'direct',
      staffProfileId: 'sitter_overnight',
      serviceTypes: ['feed'],
      serviceAddress: '合规小区',
      addressDetail: '1栋',
      doorplate: '101',
      addressLatitude: 31.201,
      addressLongitude: 121.501,
      startTime: '2099-08-03 23:00',
      endTime: '2099-08-04 01:00',
      durationMinutes: 120
    }
  })
  assert.equal(overnightOrder.ok, true)
})

test('updateStaffProfileConfig rejects unapproved sitters', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_pending_staff', roles: ['client'], status: 'active' }],
    staff_profiles: [{ _id: 'sp_pending', openid: 'openid_pending_staff', auditStatus: 'pending', realName: '张三' }]
  })
  const fn = loadCloudFunction('api', db, 'openid_pending_staff')

  const res = await fn.main({
    module: 'staff',
    action: 'updateStaffProfileConfig',
    data: { serviceAddress: '测试地址', serviceLatitude: 31.2, serviceLongitude: 121.5 }
  })
  assert.equal(res.ok, false)
  assert.equal(res.message, '宠托师认证审核通过后方可设置接单配置')
})

test('createOrder rejects direct booking when order lacks valid coordinates', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' },
      { _id: 'u_sitter', openid: 'openid_sitter', roles: ['client', 'staff'], status: 'active' }
    ],
    pets: [{ _id: 'p1', openid: 'openid_client', name: '豆豆', weight: 8 }],
    staff_profiles: [
      {
        _id: 'sitter_1',
        openid: 'openid_sitter',
        auditStatus: 'approved',
        serviceAddress: '陆家嘴中心',
        serviceLatitude: 31.2,
        serviceLongitude: 121.5,
        serviceRadiusKm: 5
      }
    ],
    orders: []
  })
  const fn = loadCloudFunction('api', db, 'openid_client')

  const res = await fn.main({
    module: 'order',
    action: 'createOrder',
    data: {
      petId: 'p1',
      publishMode: 'direct',
      staffProfileId: 'sitter_1',
      serviceTypes: ['feed'],
      serviceAddress: '无定位小区',
      addressDetail: '1栋',
      doorplate: '101',
      addressLatitude: 0,
      addressLongitude: 0,
      startTime: '2099-08-03 10:00',
      endTime: '2099-08-03 11:00',
      durationMinutes: 60
    }
  })
  assert.equal(res.ok, false)
  assert.equal(res.message, '指定宠托师预约需选择包含精确定位的服务地址')
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

test('staff creates SOS incident and incident lists are scoped by role', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' },
      { _id: 'staff', openid: 'openid_staff', roles: ['client', 'staff'], status: 'active' },
      { _id: 'other', openid: 'openid_other', roles: ['client'], status: 'active' }
    ],
    orders: [{ _id: 'order1', clientOpenid: 'openid_client', staffOpenid: 'openid_staff', status: 'in_service' }],
    order_incidents: [{ _id: 'other_incident', orderId: 'order2', clientOpenid: 'openid_other', staffOpenid: '', incidentType: 'complaint', status: 'open', createdAt: '2026-08-01' }],
    incident_actions: [],
    order_timeline: []
  })
  const staffFn = loadCloudFunction('api', db, 'openid_staff')
  const clientFn = loadCloudFunction('api', db, 'openid_client')

  const sos = await staffFn.main({ module: 'incident', action: 'createSosIncident', data: { orderId: 'order1', description: '门锁打不开', clientRequestId: 'sos_req_1' } })
  const staffList = await staffFn.main({ module: 'incident', action: 'listMyIncidents', data: { role: 'staff' } })
  const clientList = await clientFn.main({ module: 'incident', action: 'listMyIncidents', data: { role: 'client' } })

  assert.equal(sos.ok, true)
  assert.equal(sos.data.staffUserId, 'staff')
  assert.equal(staffList.data.length, 1)
  assert.equal(clientList.data.length, 1)
  assert.equal(staffList.data[0]._id, sos.data._id)
  assert.equal(clientList.data[0]._id, sos.data._id)
})

test('admin creates incident refund and coupon compensation', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' },
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' }
    ],
    orders: [{ _id: 'order1', orderNo: 'O1', clientOpenid: 'openid_client', status: 'completed', paymentStatus: 'paid', paymentNo: 'P1', payAmount: 120 }],
    order_incidents: [{ _id: 'incident1', orderId: 'order1', clientOpenid: 'openid_client', staffOpenid: 'openid_staff', status: 'processing', createdAt: '2026-08-01' }],
    refunds: [],
    payment_events: [],
    subscription_logs: [],
    user_coupons: [],
    coupon_templates: [{ _id: 'tpl1', name: '补偿券', discountAmount: 20, minOrderAmount: 80, validDays: 30, perUserLimit: 1, issuedCount: 0, enabled: true }],
    incident_actions: [],
    order_timeline: []
  })
  const fn = loadCloudFunction('api', db, 'openid_admin')

  const refund = await fn.main({ module: 'incident', action: 'linkRefund', data: { incidentId: 'incident1', refundAmount: 60, reason: '纠纷退款', clientRequestId: 'incident_refund_1' } })
  const coupon = await fn.main({ module: 'incident', action: 'proposeResolution', data: { incidentId: 'incident1', resolutionType: 'coupon', content: '发放补偿券', couponTemplateId: 'tpl1' } })

  assert.equal(refund.ok, true)
  assert.equal(db.state.refunds.length, 1)
  assert.equal(db.state.orders[0].refundAmount, 60)
  assert.equal(db.state.order_incidents[0].refundId, db.state.refunds[0]._id)
  assert.equal(coupon.ok, true)
  assert.equal(db.state.user_coupons.length, 1)
  assert.equal(db.state.order_incidents[0].resolution.couponId, db.state.user_coupons[0]._id)
  assert.equal(db.state.incident_actions.some((item) => item.action === 'refund_created'), true)
  assert.equal(db.state.incident_actions.some((item) => item.action === 'coupon_issued'), true)
})

test('closing incidents resolves frozen earnings by release deduct or keep frozen', async () => {
  const releaseDb = createCollectionStore({
    users: [{ _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' }],
    order_incidents: [{ _id: 'incident_release', orderId: 'order1', frozenEarningIds: ['earning_release'], status: 'processing' }],
    staff_earnings: [{ _id: 'earning_release', orderId: 'order1', staffOpenid: 'openid_staff', amount: 80, status: 'frozen', frozenFromStatus: 'available' }],
    incident_actions: [],
    finance_logs: [],
    order_timeline: []
  })
  const releaseFn = loadCloudFunction('api', releaseDb, 'openid_admin')
  const released = await releaseFn.main({ module: 'incident', action: 'closeIncident', data: { incidentId: 'incident_release', status: 'resolved', earningDecision: 'release', closeRemark: '释放收益' } })
  assert.equal(released.ok, true)
  assert.equal(releaseDb.state.staff_earnings[0].status, 'available')

  const deductDb = createCollectionStore({
    users: [{ _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' }],
    order_incidents: [{ _id: 'incident_deduct', orderId: 'order1', frozenEarningIds: ['earning_deduct'], status: 'processing' }],
    staff_earnings: [{ _id: 'earning_deduct', orderId: 'order1', staffOpenid: 'openid_staff', amount: 80, status: 'frozen', frozenFromStatus: 'available' }],
    incident_actions: [],
    finance_logs: [],
    order_timeline: []
  })
  const deductFn = loadCloudFunction('api', deductDb, 'openid_admin')
  const deducted = await deductFn.main({ module: 'incident', action: 'closeIncident', data: { incidentId: 'incident_deduct', status: 'resolved', earningDecision: 'deduct', deductAmount: 30, closeRemark: '扣减收益' } })
  assert.equal(deducted.ok, true)
  assert.equal(deductDb.state.staff_earnings[0].amount, 50)
  assert.equal(deductDb.state.staff_earnings[0].deductedAmount, 30)
  assert.equal(deductDb.state.finance_logs[0].amountDelta, -30)

  const keepDb = createCollectionStore({
    users: [{ _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' }],
    order_incidents: [{ _id: 'incident_keep', orderId: 'order1', frozenEarningIds: ['earning_keep'], status: 'processing' }],
    staff_earnings: [{ _id: 'earning_keep', orderId: 'order1', staffOpenid: 'openid_staff', amount: 80, status: 'frozen', frozenFromStatus: 'pending' }],
    incident_actions: [],
    finance_logs: [],
    order_timeline: []
  })
  const keepFn = loadCloudFunction('api', keepDb, 'openid_admin')
  const kept = await keepFn.main({ module: 'incident', action: 'closeIncident', data: { incidentId: 'incident_keep', status: 'closed', earningDecision: 'keep_frozen', closeRemark: '等待复核' } })
  assert.equal(kept.ok, true)
  assert.equal(keepDb.state.staff_earnings[0].status, 'frozen')
  assert.equal(keepDb.state.incident_actions.some((item) => item.action === 'earning_keep_frozen'), true)
})
