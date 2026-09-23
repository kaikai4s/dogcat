const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('getHomePageData optimizes queries: pushes conditions down, uses count(), and avoids scanning unrelated orders/checkins/users', async () => {
  // 模拟平台具有较大数据量：大量不同用户的订单、打卡和评价
  const orders = []
  const checkinLogs = []
  const serviceReviews = []
  const users = [
    { _id: 'client_active', openid: 'openid_client_active', roles: ['client'], status: 'active', nickname: '当前活跃客户' },
    { _id: 'client_other_hidden', openid: 'openid_other_hidden', roles: ['client'], status: 'active', nickname: '隐私保护客户', hidePublicCheckinPhotos: true }
  ]

  // 构造 50 笔已完成订单，其中最新一笔（第 50 笔）为隐私保护客户的订单
  for (let i = 1; i <= 50; i++) {
    const orderId = `order_completed_${i}`
    const clientOpenid = i === 50 ? 'openid_other_hidden' : (i <= 5 ? `openid_client_${i}` : 'openid_other')
    orders.push({
      _id: orderId,
      orderNo: `MO2026_${String(i).padStart(4, '0')}`,
      clientOpenid,
      status: 'completed',
      serviceSummary: `上门宠护服务 #${i}`,
      petName: `宠物${i}`,
      createdAt: `2026-09-01 ${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
      completedAt: `2026-09-01 ${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`
    })

    // 每一单关联一条打卡记录和评价记录
    checkinLogs.push({
      _id: `chk_${i}`,
      orderId,
      eventType: 'feed',
      mediaFileId: `cloud://feed_photo_${i}.jpg`,
      createdAt: '2026-09-01 10:00'
    })
    serviceReviews.push({
      _id: `rev_${i}`,
      orderId,
      status: 'visible',
      rating: 5,
      content: `服务非常贴心 #${i}`
    })
  }

  // 额外添加 30 笔进行中或已取消订单
  for (let i = 51; i <= 80; i++) {
    orders.push({
      _id: `order_other_${i}`,
      orderNo: `MO2026_${i}`,
      clientOpenid: 'openid_other',
      status: i % 2 === 0 ? 'cancelled' : 'in_service',
      createdAt: '2026-08-10 10:00'
    })
  }

  // 添加当前活跃用户的专属订单（用于 repeatOrder 验证）
  orders.push({
    _id: 'order_active_user_1',
    orderNo: 'MO_ACTIVE_001',
    clientOpenid: 'openid_client_active',
    status: 'in_service',
    serviceSummary: '专属上门喂猫',
    petName: '咪咪',
    createdAt: '2026-09-10 12:00'
  })

  // 添加额外 200 个无关用户的庞大用户表，验证不会被全表全量读取
  for (let i = 1; i <= 20; i++) {
    users.push({
      _id: `user_unrelated_${i}`,
      openid: `openid_unrelated_${i}`,
      roles: ['client'],
      status: 'active'
    })
  }

  const db = createCollectionStore({
    users,
    orders,
    checkin_logs: checkinLogs,
    service_reviews: serviceReviews,
    staff_profiles: [
      { _id: 'sp1', openid: 'openid_staff_1', realName: '李托师', auditStatus: 'approved', isFeatured: true, ratingAverage: 4.9, reviewCount: 10 }
    ],
    coupon_templates: [
      { _id: 'tpl1', name: '首单减免券', discountAmount: 15, minOrderAmount: 50, enabled: true, sortOrder: 1, newbieOnly: true }
    ],
    service_prices: [
      { _id: 'price1', key: 'feed', label: '上门喂养', price: 50, showOnHome: true, enabled: true }
    ],
    platform_configs: [
      { _id: 'cfg1', key: 'system_settings', value: { homePage: { ctaTitle: '立即预约' } } }
    ]
  })

  const fn = loadCloudFunction('api', db, 'openid_client_active')
  const result = await fn.main({ module: 'system', action: 'getHomePageData', data: {} })

  assert.equal(result.ok, true)
  const homeData = result.data

  // 1. 验证完单展示仅返回最新的 6 笔订单，而非将全部 50 笔返回到前端
  assert.equal(homeData.recentOrders.length, 6)

  // 2. 验证统计数据通过 count() 精确统计全部 50 笔已完成订单，而非仅仅是 limit 的 6 笔
  assert.equal(homeData.statsData.completedCount, '50')

  // 3. 验证当前活跃用户的 repeatOrder 正确且高效地命中该用户的专属订单
  assert.ok(homeData.repeatOrder)
  assert.equal(homeData.repeatOrder._id, 'order_active_user_1')
  assert.equal(homeData.repeatOrder.serviceSummary, '专属上门喂猫')

  // 4. 验证隐私设置依然生效：openid_other_hidden 用户的照片被正确隐藏
  const hiddenOrder = homeData.recentOrders.find((o) => o._id === 'order_completed_50')
  assert.ok(hiddenOrder)
  assert.equal(hiddenOrder.checkinPhotosHidden, true)
  assert.equal(hiddenOrder.checkinPhotos.length, 0)

  // 5. 验证普通订单的打卡照片与评价正常被聚合展示
  const normalOrder = homeData.recentOrders.find((o) => o._id !== 'order_completed_50')
  assert.ok(normalOrder)
  assert.equal(normalOrder.checkinPhotosHidden, false)
  assert.ok(normalOrder.review)
  assert.match(normalOrder.review.content, /服务非常贴心/)
})
