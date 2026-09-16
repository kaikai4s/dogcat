const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

process.env.HOME_SECURITY_KEY = process.env.HOME_SECURITY_KEY || 'test-home-security-key'

function createMallDb(overrides = {}) {
  return createCollectionStore({
    users: [
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active', phone: '13800000001', nickname: '管理员' },
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000', nickname: '用户' },
      { _id: 'other', openid: 'openid_other', roles: ['client'], status: 'active', phone: '13800000002', nickname: '其他用户' }
    ],
    platform_configs: [{ _id: 'cfg1', key: 'system_settings', value: { payment: { enabled: true, mode: 'mock', refundEnabled: true } } }],
    mall_categories: [],
    mall_products: [],
    mall_carts: [],
    mall_orders: [],
    payments: [],
    refunds: [],
    payment_events: [],
    finance_logs: [],
    admin_operation_logs: [],
    user_coupons: [],
    order_messages: [],
    order_message_threads: [],
    subscription_logs: [],
    ...overrides
  })
}

test('mall supports product, cart, order, payment, shipping and receipt flow', async () => {
  const db = createMallDb()
  const adminFn = loadCloudFunction('api', db, 'openid_admin')
  const clientFn = loadCloudFunction('api', db, 'openid_client')

  const category = await adminFn.main({ module: 'adminMall', action: 'saveCategory', data: { name: '主粮', icon: 'food', sortOrder: 1 } })
  assert.equal(category.ok, true)

  const product = await adminFn.main({ module: 'adminMall', action: 'saveProduct', data: { categoryId: category.data._id, name: '猫粮', subtitle: '成猫粮', coverFileId: 'cloud://mall/cat-food.jpg', price: 59, originalPrice: 69, stock: 5, specText: '2kg', sortOrder: 1 } })
  assert.equal(product.ok, true)

  const productList = await clientFn.main({ module: 'mall', action: 'listProducts', data: { pageSize: 10 } })
  assert.equal(productList.ok, true)
  assert.equal(productList.data.total, 1)
  assert.equal(productList.data.list[0]._id, product.data._id)

  const cart = await clientFn.main({ module: 'mall', action: 'updateCart', data: { productId: product.data._id, quantity: 1, operation: 'add' } })
  const addedAgain = await clientFn.main({ module: 'mall', action: 'updateCart', data: { productId: product.data._id, quantity: 1, operation: 'add' } })
  assert.equal(cart.ok, true)
  assert.equal(addedAgain.ok, true)
  assert.equal(addedAgain.data.selectedCount, 2)
  assert.equal(addedAgain.data.totalAmount, 118)

  const order = await clientFn.main({ module: 'mall', action: 'createOrder', data: { shippingAddress: { contactName: '张三', contactPhone: '13800000000', serviceAddress: '测试小区', addressDetail: '1栋101' } } })
  assert.equal(order.ok, true)
  assert.equal(order.data.status, 'pending_pay')
  assert.equal(order.data.payAmount, 118)
  assert.equal(db.state.mall_carts[0].items.length, 0)

  const paid = await clientFn.main({ module: 'payment', action: 'mockPayOrder', data: { orderId: order.data._id } })
  assert.equal(paid.ok, true)
  assert.equal(db.state.mall_orders[0].status, 'pending_ship')
  assert.equal(db.state.mall_orders[0].paymentStatus, 'paid')
  assert.equal(db.state.mall_products[0].stock, 3)
  assert.equal(db.state.mall_products[0].salesCount, 2)

  const shipped = await adminFn.main({ module: 'adminMall', action: 'shipOrder', data: { orderId: order.data._id, expressCompany: '顺丰', trackingNo: 'SF100200' } })
  assert.equal(shipped.ok, true)
  assert.equal(shipped.data.status, 'shipped')

  const received = await clientFn.main({ module: 'mall', action: 'confirmReceipt', data: { orderId: order.data._id } })
  assert.equal(received.ok, true)
  assert.equal(db.state.mall_orders[0].status, 'completed')
})

test('mall locks coupons and unlocks them when unpaid order is cancelled', async () => {
  const db = createMallDb({
    mall_products: [{ _id: 'p1', categoryId: '', name: '狗粮', coverFileId: 'cloud://mall/dog-food.jpg', price: 120, stock: 10, status: 'on_sale' }],
    user_coupons: [
      { _id: 'c1', openid: 'openid_client', userId: 'client', templateId: 't1', status: 'available', validFrom: '2026-01-01T00:00:00.000Z', validTo: '2099-01-01T00:00:00.000Z', templateSnapshot: { name: '商城满100减20', type: 'fixed', usageScope: 'mall', discountAmount: 20, minOrderAmount: 100, applicableServiceTypes: [] } },
      { _id: 'c2', openid: 'openid_client', userId: 'client', templateId: 't2', status: 'available', validFrom: '2026-01-01T00:00:00.000Z', validTo: '2099-01-01T00:00:00.000Z', templateSnapshot: { name: '服务满100减30', type: 'fixed', usageScope: 'service', discountAmount: 30, minOrderAmount: 100, applicableServiceTypes: [] } }
    ]
  })
  const clientFn = loadCloudFunction('api', db, 'openid_client')

  const mallCoupons = await clientFn.main({ module: 'coupon', action: 'listMallCoupons', data: { items: [{ productId: 'p1', price: 120, quantity: 1 }] } })
  const blocked = await clientFn.main({ module: 'mall', action: 'createOrder', data: { productId: 'p1', quantity: 1, couponId: 'c2', shippingAddress: { contactName: '张三', contactPhone: '13800000000', serviceAddress: '测试小区', addressDetail: '1栋101' } } })
  const order = await clientFn.main({ module: 'mall', action: 'createOrder', data: { productId: 'p1', quantity: 1, couponId: 'c1', shippingAddress: { contactName: '张三', contactPhone: '13800000000', serviceAddress: '测试小区', addressDetail: '1栋101' } } })
  assert.equal(mallCoupons.ok, true)
  assert.equal(mallCoupons.data.length, 1)
  assert.equal(mallCoupons.data[0]._id, 'c1')
  assert.equal(blocked.ok, false)
  assert.equal(blocked.message, '仅限上门服务订单使用')
  assert.equal(order.ok, true)
  assert.equal(order.data.discountAmount, 20)
  assert.equal(order.data.payAmount, 100)
  assert.equal(db.state.user_coupons[0].status, 'locked')
  assert.equal(db.state.user_coupons[0].lockedOrderId, order.data._id)

  const cancelled = await clientFn.main({ module: 'mall', action: 'cancelOrder', data: { orderId: order.data._id } })
  assert.equal(cancelled.ok, true)
  assert.equal(db.state.mall_orders[0].status, 'cancelled')
  assert.equal(db.state.user_coupons[0].status, 'available')
  assert.equal(db.state.user_coupons[0].lockedOrderId, '')
})

test('mall refund requires owner application and admin approval', async () => {
  const db = createMallDb({
    mall_products: [{ _id: 'p1', categoryId: '', name: '猫砂', coverFileId: 'cloud://mall/litter.jpg', price: 88, stock: 10, status: 'on_sale' }]
  })
  const clientFn = loadCloudFunction('api', db, 'openid_client')
  const otherFn = loadCloudFunction('api', db, 'openid_other')
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  const order = await clientFn.main({ module: 'mall', action: 'createOrder', data: { productId: 'p1', quantity: 1, shippingAddress: { contactName: '张三', contactPhone: '13800000000', serviceAddress: '测试小区', addressDetail: '1栋101' } } })
  await clientFn.main({ module: 'payment', action: 'mockPayOrder', data: { orderId: order.data._id } })

  const forbidden = await otherFn.main({ module: 'mall', action: 'getOrderDetail', data: { orderId: order.data._id } })
  assert.equal(forbidden.ok, false)

  const applied = await clientFn.main({ module: 'mall', action: 'applyRefund', data: { orderId: order.data._id, reason: '不想要了', images: ['cloud://mall/refund.jpg'] } })
  assert.equal(applied.ok, true)
  assert.equal(db.state.mall_orders[0].status, 'refund_applied')
  assert.equal(db.state.mall_orders[0].refundStatus, 'applied')

  const approved = await adminFn.main({ module: 'adminMall', action: 'auditRefund', data: { orderId: order.data._id, approved: true, remark: '同意退款' } })
  assert.equal(approved.ok, true)
  assert.equal(db.state.refunds.length, 1)
  assert.equal(db.state.mall_orders[0].status, 'refunded')
  assert.equal(db.state.mall_orders[0].refundStatus, 'approved')
})

test('mall supports multi-sku products in cart, order and payment stock deduction', async () => {
  const db = createMallDb()
  const adminFn = loadCloudFunction('api', db, 'openid_admin')
  const clientFn = loadCloudFunction('api', db, 'openid_client')

  const product = await adminFn.main({
    module: 'adminMall',
    action: 'saveProduct',
    data: {
      name: '冻干猫粮',
      coverFileId: 'cloud://mall/food.jpg',
      imageFileIds: ['cloud://mall/food-1.jpg', 'cloud://mall/food-2.jpg'],
      specMode: 'multi',
      specGroups: [{ name: '重量', values: ['2kg', '5kg'] }],
      skus: [
        { skuId: 'sku_2kg', specs: { 重量: '2kg' }, specText: '2kg', price: 99, originalPrice: 119, stock: 5, imageFileId: 'cloud://mall/food-2kg.jpg' },
        { skuId: 'sku_5kg', specs: { 重量: '5kg' }, specText: '5kg', price: 199, originalPrice: 239, stock: 8, imageFileId: 'cloud://mall/food-5kg.jpg' }
      ]
    }
  })
  assert.equal(product.ok, true)
  assert.equal(product.data.minPrice, 99)
  assert.equal(product.data.maxPrice, 199)
  assert.equal(product.data.totalStock, 13)

  const detail = await clientFn.main({ module: 'mall', action: 'getProductDetail', data: { id: product.data._id } })
  assert.equal(detail.ok, true)
  assert.equal(detail.data.hasSku, true)
  assert.equal(detail.data.skus.length, 2)

  const cartA = await clientFn.main({ module: 'mall', action: 'updateCart', data: { productId: product.data._id, skuId: 'sku_2kg', quantity: 2, operation: 'add' } })
  const cartB = await clientFn.main({ module: 'mall', action: 'updateCart', data: { productId: product.data._id, skuId: 'sku_5kg', quantity: 1, operation: 'add' } })
  assert.equal(cartA.ok, true)
  assert.equal(cartB.ok, true)
  assert.equal(cartB.data.items.length, 2)
  assert.equal(cartB.data.totalAmount, 397)
  assert.deepEqual(cartB.data.items.map((item) => item.skuId).sort(), ['sku_2kg', 'sku_5kg'])
  assert.equal(cartB.data.items.find((item) => item.skuId === 'sku_5kg').snapshot.coverFileId, 'cloud://mall/food-5kg.jpg')

  const order = await clientFn.main({ module: 'mall', action: 'createOrder', data: { productId: product.data._id, skuId: 'sku_5kg', quantity: 2, shippingAddress: { contactName: '李四', contactPhone: '13800000000', serviceAddress: '测试小区', addressDetail: '2栋202' } } })
  assert.equal(order.ok, true)
  assert.equal(order.data.items[0].skuId, 'sku_5kg')
  assert.equal(order.data.items[0].specText, '5kg')
  assert.equal(order.data.items[0].price, 199)
  assert.equal(order.data.items[0].coverFileId, 'cloud://mall/food-5kg.jpg')
  assert.equal(order.data.items[0].skuSnapshot.imageFileId, 'cloud://mall/food-5kg.jpg')
  assert.equal(order.data.payAmount, 398)

  const paid = await clientFn.main({ module: 'payment', action: 'mockPayOrder', data: { orderId: order.data._id } })
  assert.equal(paid.ok, true)
  const savedProduct = db.state.mall_products[0]
  const sku2 = savedProduct.skus.find((item) => item.skuId === 'sku_2kg')
  const sku5 = savedProduct.skus.find((item) => item.skuId === 'sku_5kg')
  assert.equal(sku2.stock, 5)
  assert.equal(sku5.stock, 6)
  assert.equal(sku5.salesCount, 2)
  assert.equal(savedProduct.stock, 11)
  assert.equal(savedProduct.totalStock, 11)
})

test('mall management rejects non-admin and invalid stock operations', async () => {
  const db = createMallDb({
    mall_products: [{ _id: 'p1', categoryId: '', name: '罐头', coverFileId: 'cloud://mall/can.jpg', price: 20, stock: 1, status: 'on_sale' }]
  })
  const clientFn = loadCloudFunction('api', db, 'openid_client')

  const adminAction = await clientFn.main({ module: 'adminMall', action: 'saveCategory', data: { name: '玩具' } })
  assert.equal(adminAction.ok, false)

  const cart = await clientFn.main({ module: 'mall', action: 'updateCart', data: { productId: 'p1', quantity: 2 } })
  assert.equal(cart.ok, false)
  assert.equal(cart.message, '商品库存不足')
})
