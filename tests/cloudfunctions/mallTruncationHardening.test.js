const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

process.env.HOME_SECURITY_KEY = process.env.HOME_SECURITY_KEY || 'test-home-security-key'

function createMallDb(overrides = {}) {
  return createCollectionStore({
    users: [
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active', phone: '13800000001', nickname: '管理员' },
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000', nickname: '用户' }
    ],
    platform_configs: [{ _id: 'cfg1', key: 'system_settings', value: { payment: { enabled: true, mode: 'mock', refundEnabled: true } } }],
    mall_categories: [{ _id: 'cat_food', name: '宠物主粮', enabled: true, sortOrder: 1 }],
    mall_products: [],
    mall_carts: [],
    mall_orders: [],
    payments: [],
    refunds: [],
    admin_operation_logs: [],
    ...overrides
  })
}

test('mall.listProducts: breaks 100 item limit and properly paginates beyond 100 items', async () => {
  // Generate 125 on_sale products
  const products = []
  for (let i = 1; i <= 125; i++) {
    const id = `prod_${String(i).padStart(4, '0')}`
    products.push({
      _id: id,
      name: `测试商品_${i}`,
      categoryId: i <= 50 ? 'cat_food' : 'cat_toys',
      status: 'on_sale',
      price: i * 2,
      originalPrice: i * 2 + 10,
      stock: 10,
      salesCount: i,
      sortOrder: i,
      createdAt: `2026-09-01T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`,
      updatedAt: `2026-09-01T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`
    })
  }
  // Add 10 off_sale products that should not be returned
  for (let i = 126; i <= 135; i++) {
    products.push({
      _id: `prod_${String(i).padStart(4, '0')}`,
      name: `下架商品_${i}`,
      categoryId: 'cat_food',
      status: 'off_sale',
      price: 100,
      stock: 0
    })
  }

  const db = createMallDb({ mall_products: products })
  const clientFn = loadCloudFunction('api', db, 'openid_client')
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 1. Client views page 1: total must be 125 (not truncated at 100)
  const page1Res = await clientFn.main({
    module: 'mall',
    action: 'listProducts',
    data: { page: 1, pageSize: 20 }
  })
  assert.equal(page1Res.ok, true)
  assert.equal(page1Res.data.total, 125)
  assert.equal(page1Res.data.list.length, 20)
  assert.equal(page1Res.data.hasMore, true)

  // 2. Client views page 7 (items 121-125): must return remaining 5 items
  const page7Res = await clientFn.main({
    module: 'mall',
    action: 'listProducts',
    data: { page: 7, pageSize: 20 }
  })
  assert.equal(page7Res.ok, true)
  assert.equal(page7Res.data.total, 125)
  assert.equal(page7Res.data.list.length, 5)
  assert.equal(page7Res.data.hasMore, false)
  assert.equal(page7Res.data.list[4].name, '测试商品_125')

  // 3. Category pushdown filtering: only cat_food (50 items)
  const catRes = await clientFn.main({
    module: 'mall',
    action: 'listProducts',
    data: { categoryId: 'cat_food', pageSize: 100 }
  })
  assert.equal(catRes.ok, true)
  assert.equal(catRes.data.total, 50)
  assert.equal(catRes.data.list.length, 50)
  assert.equal(catRes.data.list.every((item) => item.categoryId === 'cat_food'), true)

  // 4. Admin listProducts also breaks 100 limit
  const adminProductsRes = await adminFn.main({
    module: 'adminMall',
    action: 'listProducts',
    data: { page: 7, pageSize: 20, status: 'on_sale' }
  })
  assert.equal(adminProductsRes.ok, true)
  assert.equal(adminProductsRes.data.total, 125)
  assert.equal(adminProductsRes.data.list.length, 5)
})

test('adminMall.listOrders & mall.listMyOrders: breaks 100 limit with DB pagination and search', async () => {
  const orders = []
  for (let i = 1; i <= 130; i++) {
    const id = `order_${String(i).padStart(4, '0')}`
    orders.push({
      _id: id,
      orderNo: `M_20260901_${String(i).padStart(4, '0')}`,
      clientOpenid: 'openid_client',
      contactPhone: i === 125 ? '13911112222' : `1380000${String(i).padStart(4, '0')}`,
      status: i <= 100 ? 'pending_ship' : 'shipped',
      payAmount: 88,
      refundAmount: 0,
      trackingNo: i === 125 ? 'SF_SPECIFIC_125' : `SF${String(i).padStart(6, '0')}`,
      expressCompany: '顺丰速运',
      createdAt: `2026-09-01T12:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
      updatedAt: `2026-09-01T12:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`
    })
  }

  const db = createMallDb({ mall_orders: orders })
  const adminFn = loadCloudFunction('api', db, 'openid_admin')
  const clientFn = loadCloudFunction('api', db, 'openid_client')

  // 1. Admin listOrders without keyword: DB pagination handles page 7 (items 121-130)
  const adminPage1 = await adminFn.main({
    module: 'adminMall',
    action: 'listOrders',
    data: { page: 1, pageSize: 20 }
  })
  assert.equal(adminPage1.ok, true)
  assert.equal(adminPage1.data.total, 130)
  assert.equal(adminPage1.data.list.length, 20)
  assert.equal(adminPage1.data.hasMore, true)

  const adminPage7 = await adminFn.main({
    module: 'adminMall',
    action: 'listOrders',
    data: { page: 7, pageSize: 20 }
  })
  assert.equal(adminPage7.ok, true)
  assert.equal(adminPage7.data.total, 130)
  assert.equal(adminPage7.data.list.length, 10)
  assert.equal(adminPage7.data.hasMore, false)

  // 2. Admin listOrders with status filter: 'shipped' (30 orders)
  const adminShipped = await adminFn.main({
    module: 'adminMall',
    action: 'listOrders',
    data: { status: 'shipped', page: 2, pageSize: 20 }
  })
  assert.equal(adminShipped.ok, true)
  assert.equal(adminShipped.data.total, 30)
  assert.equal(adminShipped.data.list.length, 10)

  // 3. Admin listOrders keyword search: finds item beyond 100th record
  const searchByTracking = await adminFn.main({
    module: 'adminMall',
    action: 'listOrders',
    data: { keyword: 'SF_SPECIFIC_125' }
  })
  assert.equal(searchByTracking.ok, true)
  assert.equal(searchByTracking.data.total, 1)
  assert.equal(searchByTracking.data.list[0].orderNo, 'M_20260901_0125')
  assert.equal(searchByTracking.data.list[0].statusText, '已发货')

  const searchByPhone = await adminFn.main({
    module: 'adminMall',
    action: 'listOrders',
    data: { keyword: '13911112222' }
  })
  assert.equal(searchByPhone.ok, true)
  assert.equal(searchByPhone.data.total, 1)
  assert.equal(searchByPhone.data.list[0].orderNo, 'M_20260901_0125')

  // 4. Client listMyOrders: DB pagination handles items beyond 100
  const clientPage1 = await clientFn.main({
    module: 'mall',
    action: 'listMyOrders',
    data: { page: 1, pageSize: 20 }
  })
  assert.equal(clientPage1.ok, true)
  assert.equal(clientPage1.data.total, 130)
  assert.equal(clientPage1.data.list.length, 20)

  const clientPage7 = await clientFn.main({
    module: 'mall',
    action: 'listMyOrders',
    data: { page: 7, pageSize: 20 }
  })
  assert.equal(clientPage7.ok, true)
  assert.equal(clientPage7.data.total, 130)
  assert.equal(clientPage7.data.list.length, 10)
  assert.equal(clientPage7.data.hasMore, false)
})
