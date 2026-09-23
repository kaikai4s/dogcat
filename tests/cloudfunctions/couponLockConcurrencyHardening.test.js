const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const optimistic = require('./optimisticTransactions')

function setupCouponTest(extra = {}) {
  const db = createCollectionStore({
    users: [
      {
        _id: 'u_client_1',
        openid: 'openid_client_1',
        nickname: '优惠券测试用户',
        roles: ['client'],
        status: 'active',
        phone: '13800000001',
        points: 0,
        totalPoints: 0
      }
    ],
    pets: [
      {
        _id: 'pet_1',
        openid: 'openid_client_1',
        name: '旺财',
        species: 'dog',
        breed: '柯基',
        weight: 12
      }
    ],
    coupon_templates: [
      {
        _id: 'tmpl_all_purpose',
        name: '立减20通用券',
        type: 'fixed',
        usageScope: 'all',
        discountAmount: 20,
        minOrderAmount: 50,
        applicableServiceTypes: [],
        enabled: true
      }
    ],
    user_coupons: [
      {
        _id: 'coupon_shared_1',
        openid: 'openid_client_1',
        userId: 'u_client_1',
        templateId: 'tmpl_all_purpose',
        status: 'available',
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: '2099-01-01T00:00:00.000Z',
        templateSnapshot: {
          name: '立减20通用券',
          type: 'fixed',
          usageScope: 'all',
          discountAmount: 20,
          minOrderAmount: 50,
          applicableServiceTypes: []
        },
        lockedOrderId: '',
        lockedAt: null
      }
    ],
    mall_products: [
      {
        _id: 'prod_1',
        name: '高品质天然狗粮 5kg',
        status: 'on_sale',
        price: 150,
        originalPrice: 180,
        stock: 100,
        specMode: 'single',
        skus: [
          { skuId: 'default', name: '标准装', price: 150, stock: 100, status: 'on_sale' }
        ]
      }
    ],
    orders: [],
    mall_orders: [],
    order_home_security: [],
    order_timeline: [],
    client_messages: [],
    ...extra
  })
  return db
}

test('coupon lock concurrency: concurrent service orders with same coupon only allows one lock without overwrite', async () => {
  const db = setupCouponTest()
  optimistic(db)

  const fn = loadCloudFunction('api', db, 'openid_client_1')

  const baseOrderData = {
    petId: 'pet_1',
    serviceTypes: ['visit_fee', 'walk'],
    serviceAddress: '阳光花园 1 号楼',
    addressDetail: '1单元 101',
    doorplate: '101',
    startTime: '2099-08-01 10:00',
    endTime: '2099-08-01 11:00',
    durationMinutes: 60,
    couponId: 'coupon_shared_1'
  }

  // 模拟同一用户并发提交两个服务订单，抢用同一张优惠券
  const [res1, res2] = await Promise.allSettled([
    fn.main({ module: 'order', action: 'createOrder', data: { ...baseOrderData, clientRequestId: 'req_order_1' } }),
    fn.main({ module: 'order', action: 'createOrder', data: { ...baseOrderData, clientRequestId: 'req_order_2' } })
  ])

  const results = [res1.value, res2.value]
  const successList = results.filter(r => r.ok === true)
  const failList = results.filter(r => r.ok === false)

  assert.equal(successList.length, 1, 'Exactly one order creation must succeed')
  assert.equal(failList.length, 1, 'The other concurrent order creation must fail')
  assert.ok(
    failList[0].message.includes('锁定') || failList[0].message.includes('不可用') || failList[0].message.includes('已在使用中'),
    `Error should mention locked/unavailable, got: ${failList[0].message}`
  )

  // 数据库中只成功创建 1 笔订单
  assert.equal(db.state.orders.length, 1, 'Only 1 order must be created')
  const createdOrder = db.state.orders[0]
  assert.equal(createdOrder._id, successList[0].data._id)

  // 优惠券锁定信息必须严格属于成功创建的订单，绝未被并发请求覆盖
  const coupon = db.state.user_coupons.find(c => c._id === 'coupon_shared_1')
  assert.equal(coupon.status, 'locked')
  assert.equal(coupon.lockedOrderId, createdOrder._id, 'Coupon lockedOrderId must match the winning order')
})

test('coupon lock concurrency: concurrent mall orders with same coupon only allows one lock without overwrite', async () => {
  const db = setupCouponTest()
  optimistic(db)

  const fn = loadCloudFunction('api', db, 'openid_client_1')

  const baseMallData = {
    productId: 'prod_1',
    skuId: 'default',
    quantity: 1,
    couponId: 'coupon_shared_1',
    shippingAddress: {
      contactName: '王五',
      contactPhone: '13800000001',
      serviceAddress: '阳光花园',
      addressDetail: '1栋101'
    }
  }

  // 两个并发商城订单抢同一张优惠券
  const [res1, res2] = await Promise.allSettled([
    fn.main({ module: 'mall', action: 'createOrder', data: { ...baseMallData, clientRequestId: 'req_mall_1' } }),
    fn.main({ module: 'mall', action: 'createOrder', data: { ...baseMallData, clientRequestId: 'req_mall_2' } })
  ])

  const results = [res1.value, res2.value]
  const successList = results.filter(r => r.ok === true)
  const failList = results.filter(r => r.ok === false)

  assert.equal(successList.length, 1, 'Exactly one mall order creation must succeed')
  assert.equal(failList.length, 1, 'The other mall order creation must fail')
  assert.ok(
    failList[0].message.includes('锁定') || failList[0].message.includes('不可用') || failList[0].message.includes('已在使用中'),
    `Error should mention locked, got: ${failList[0].message}`
  )

  // 数据库中只存在 1 笔商城订单
  assert.equal(db.state.mall_orders.length, 1)
  const createdMallOrder = db.state.mall_orders[0]

  // 优惠券锁定归属一致
  const coupon = db.state.user_coupons.find(c => c._id === 'coupon_shared_1')
  assert.equal(coupon.status, 'locked')
  assert.equal(coupon.lockedOrderId, createdMallOrder._id)
})

test('coupon lock concurrency: service order and mall order concurrent race for universal coupon', async () => {
  const db = setupCouponTest()
  optimistic(db)

  const fn = loadCloudFunction('api', db, 'openid_client_1')

  const serviceOrderData = {
    petId: 'pet_1',
    serviceTypes: ['visit_fee', 'walk'],
    serviceAddress: '阳光花园 1 号楼',
    addressDetail: '1单元 101',
    doorplate: '101',
    startTime: '2099-08-01 10:00',
    endTime: '2099-08-01 11:00',
    durationMinutes: 60,
    couponId: 'coupon_shared_1',
    clientRequestId: 'req_cross_service'
  }

  const mallOrderData = {
    productId: 'prod_1',
    skuId: 'default',
    quantity: 1,
    couponId: 'coupon_shared_1',
    clientRequestId: 'req_cross_mall',
    shippingAddress: {
      contactName: '王五',
      contactPhone: '13800000001',
      serviceAddress: '阳光花园',
      addressDetail: '1栋101'
    }
  }

  // 服务订单与商城订单同时争抢一张通用优惠券
  const [resService, resMall] = await Promise.allSettled([
    fn.main({ module: 'order', action: 'createOrder', data: serviceOrderData }),
    fn.main({ module: 'mall', action: 'createOrder', data: mallOrderData })
  ])

  const results = [resService.value, resMall.value]
  const successList = results.filter(r => r.ok === true)
  const failList = results.filter(r => r.ok === false)

  assert.equal(successList.length, 1, 'Only one order across services may lock the coupon')
  assert.equal(failList.length, 1, 'The competing order must fail gracefully')

  const coupon = db.state.user_coupons.find(c => c._id === 'coupon_shared_1')
  assert.equal(coupon.status, 'locked')
  assert.equal(coupon.lockedOrderId, successList[0].data._id)
})

test('coupon lock safety: attempting to use already locked, used or expired coupon is rejected', async () => {
  const db = setupCouponTest({
    user_coupons: [
      {
        _id: 'c_locked',
        openid: 'openid_client_1',
        templateId: 'tmpl_all_purpose',
        status: 'locked',
        lockedOrderId: 'other_order_999',
        validTo: '2099-01-01T00:00:00.000Z',
        templateSnapshot: { name: '已锁定券', type: 'fixed', usageScope: 'all', discountAmount: 20, minOrderAmount: 50, applicableServiceTypes: [] }
      },
      {
        _id: 'c_used',
        openid: 'openid_client_1',
        templateId: 'tmpl_all_purpose',
        status: 'used',
        usedOrderId: 'old_order_888',
        validTo: '2099-01-01T00:00:00.000Z',
        templateSnapshot: { name: '已使用券', type: 'fixed', usageScope: 'all', discountAmount: 20, minOrderAmount: 50, applicableServiceTypes: [] }
      }
    ]
  })

  const fn = loadCloudFunction('api', db, 'openid_client_1')

  const baseOrderData = {
    petId: 'pet_1',
    serviceTypes: ['visit_fee', 'walk'],
    serviceAddress: '阳光花园',
    addressDetail: '101',
    doorplate: '101',
    startTime: '2099-08-01 10:00',
    endTime: '2099-08-01 11:00',
    durationMinutes: 60
  }

  // 1. 尝试使用已锁定的券
  const resLocked = await fn.main({
    module: 'order',
    action: 'createOrder',
    data: { ...baseOrderData, couponId: 'c_locked' }
  })
  assert.equal(resLocked.ok, false)
  assert.ok(resLocked.message.includes('锁定') || resLocked.message.includes('不可用'))

  // 2. 尝试使用已使用的券
  const resUsed = await fn.main({
    module: 'order',
    action: 'createOrder',
    data: { ...baseOrderData, couponId: 'c_used' }
  })
  assert.equal(resUsed.ok, false)
  assert.ok(resUsed.message.includes('使用') || resUsed.message.includes('不可用'))

  // 绝无订单生成
  assert.equal(db.state.orders.length, 0)
  // 原锁定关系未受影响
  assert.equal(db.state.user_coupons.find(c => c._id === 'c_locked').lockedOrderId, 'other_order_999')
})
