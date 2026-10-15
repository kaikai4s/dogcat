const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const optimistic = require('./optimisticTransactions')

function createMultiUserStore(extra = {}) {
  return createCollectionStore({
    users: [
      { _id: 'u_1', openid: 'openid_1', roles: ['client'], status: 'active', phone: '13800000001', nickname: '用户1' },
      { _id: 'u_2', openid: 'openid_2', roles: ['client'], status: 'active', phone: '13800000002', nickname: '用户2' },
      { _id: 'u_3', openid: 'openid_3', roles: ['client'], status: 'active', phone: '13800000003', nickname: '用户3' },
      { _id: 'u_4', openid: 'openid_4', roles: ['client'], status: 'active', phone: '13800000004', nickname: '用户4' },
      { _id: 'u_5', openid: 'openid_5', roles: ['client'], status: 'active', phone: '13800000005', nickname: '用户5' }
    ],
    platform_configs: [
      { _id: 'cfg1', key: 'system_settings', value: { payment: { enabled: true, mode: 'mock', refundEnabled: true } } }
    ],
    mall_products: [
      {
        _id: 'prod_single_1',
        name: '最后1件绝版猫窝',
        status: 'on_sale',
        price: 99,
        stock: 1,
        totalStock: 1,
        specMode: 'single',
        skus: [{ skuId: 'default', name: '标准款', price: 99, stock: 1, status: 'on_sale' }]
      },
      {
        _id: 'prod_multi_sku',
        name: '双色逗猫棒',
        status: 'on_sale',
        price: 39,
        stock: 2,
        totalStock: 2,
        specMode: 'multi',
        specGroups: [{ name: '颜色', values: ['粉色', '蓝色'] }],
        skus: [
          { skuId: 'sku_pink', name: '粉色款', specs: { '颜色': '粉色' }, price: 39, stock: 1, status: 'on_sale' },
          { skuId: 'sku_blue', name: '蓝色款', specs: { '颜色': '蓝色' }, price: 39, stock: 1, status: 'on_sale' }
        ]
      }
    ],
    mall_orders: [],
    payments: [],
    refunds: [],
    finance_logs: [],
    payment_events: [],
    user_coupons: [],
    order_timeline: [],
    mall_carts: [],
    ...extra
  })
}

test('并发审核 1: 5个用户同时争抢最后1件单品，严格只允许1人成功，0超卖，库存不为负', async () => {
  const db = createMultiUserStore()
  optimistic(db)

  const clients = [1, 2, 3, 4, 5].map(i => loadCloudFunction('api', db, `openid_${i}`))
  const shippingAddress = { contactName: '抢购人', contactPhone: '13800000000', serviceAddress: '幸福小区', addressDetail: '1栋' }

  // 5个用户并发下单
  const results = await Promise.all(
    clients.map(fn => fn.main({
      module: 'mall',
      action: 'createOrder',
      data: { productId: 'prod_single_1', skuId: 'default', quantity: 1, shippingAddress }
    }))
  )

  const successResults = results.filter(r => r.ok === true)
  const failedResults = results.filter(r => r.ok === false)

  assert.equal(successResults.length, 1, '必须仅且只有 1 个并发请求成功')
  assert.equal(failedResults.length, 4, '其余 4 个请求必须全部被拒绝')
  failedResults.forEach(fail => {
    assert.match(fail.message, /商品库存不足/)
  })

  // 检查商品库存
  const product = db.state.mall_products.find(p => p._id === 'prod_single_1')
  assert.equal(product.stock, 0, '商品库存必须严格归零，不可为负数')
  assert.equal(product.skus[0].stock, 0, 'SKU库存必须严格归零')

  // 检查订单数量
  assert.equal(db.state.mall_orders.length, 1, '系统必须严格只产生 1 笔有效订单')
  assert.equal(db.state.mall_orders[0].stockReserved, true, '成功订单必须标记预占库存状态')
})

test('并发审核 2: 多规格不同用户同时交叉争抢各自规格，各SKU库存互不干扰、独立原子隔离', async () => {
  const db = createMultiUserStore()
  optimistic(db)

  const fn1 = loadCloudFunction('api', db, 'openid_1')
  const fn2 = loadCloudFunction('api', db, 'openid_2')
  const fn3 = loadCloudFunction('api', db, 'openid_3')
  const shippingAddress = { contactName: '用户', contactPhone: '13800000000', serviceAddress: '幸福小区', addressDetail: '1栋' }

  // 用户1抢粉色，用户2也抢粉色，用户3抢蓝色
  const [res1, res2, res3] = await Promise.all([
    fn1.main({
      module: 'mall',
      action: 'createOrder',
      data: { productId: 'prod_multi_sku', skuId: 'sku_pink', quantity: 1, shippingAddress }
    }),
    fn2.main({
      module: 'mall',
      action: 'createOrder',
      data: { productId: 'prod_multi_sku', skuId: 'sku_pink', quantity: 1, shippingAddress }
    }),
    fn3.main({
      module: 'mall',
      action: 'createOrder',
      data: { productId: 'prod_multi_sku', skuId: 'sku_blue', quantity: 1, shippingAddress }
    })
  ])

  // 粉色2人争抢只有1人成功
  const pinkSuccess = (res1.ok ? 1 : 0) + (res2.ok ? 1 : 0)
  assert.equal(pinkSuccess, 1, '粉色款式仅有 1 人抢购成功')

  // 蓝色无人竞争，用户3必须成功
  assert.equal(res3.ok, true, '蓝色款式用户3必须成功')

  // 验证两款SKU库存均减为0，总库存减为0
  const product = db.state.mall_products.find(p => p._id === 'prod_multi_sku')
  const pinkSku = product.skus.find(s => s.skuId === 'sku_pink')
  const blueSku = product.skus.find(s => s.skuId === 'sku_blue')
  assert.equal(pinkSku.stock, 0)
  assert.equal(blueSku.stock, 0)
  assert.equal(product.totalStock, 0)
})

test('并发审核 3: 取消未支付订单遭遇并发重复触发，库存释放具有严格幂等性，绝不发生多次累加', async () => {
  const db = createMultiUserStore()
  const fn1 = loadCloudFunction('api', db, 'openid_1')
  const shippingAddress = { contactName: '用户1', contactPhone: '13800000001', serviceAddress: '幸福小区', addressDetail: '1栋' }

  // 1. 用户1下单，预占仅剩的1件库存
  const orderRes = await fn1.main({
    module: 'mall',
    action: 'createOrder',
    data: { productId: 'prod_single_1', skuId: 'default', quantity: 1, shippingAddress }
  })
  assert.equal(orderRes.ok, true)
  assert.equal(db.state.mall_products[0].stock, 0)

  const orderId = orderRes.data._id

  // 2. 模拟前端并发快速双击取消，或用户取消与定时任务取消同时到达
  const [cancel1, cancel2] = await Promise.all([
    fn1.main({ module: 'mall', action: 'cancelOrder', data: { orderId } }),
    fn1.main({ module: 'mall', action: 'cancelOrder', data: { orderId } })
  ])

  // 无论并发多少次，库存只能被回补 1 次
  assert.equal(db.state.mall_products[0].stock, 1, '库存必须严格回补到初始值 1，不可重复回补变成 2')
  assert.equal(db.state.mall_orders[0].status, 'cancelled')
  assert.equal(db.state.mall_orders[0].stockReserved, false)
})

test('并发审核 4: 微信支付成功回调并发重复推送，结算具备严格幂等性，销量与财务流水绝不翻倍', async () => {
  const db = createMultiUserStore({
    mall_orders: [
      {
        _id: 'ord_pay_repeat',
        orderType: 'mall',
        orderNo: 'MO_REPEAT_1',
        clientOpenid: 'openid_1',
        clientUserId: 'u_1',
        status: 'pending_pay',
        paymentStatus: 'paying',
        payAmount: 99,
        paymentNo: 'PNO_999',
        stockReserved: true,
        items: [{ productId: 'prod_single_1', skuId: 'default', name: '最后1件绝版猫窝', quantity: 1, price: 99 }]
      }
    ],
    payments: [
      {
        _id: 'pay_999',
        orderId: 'ord_pay_repeat',
        paymentNo: 'PNO_999',
        amount: 99,
        status: 'pending',
        channel: 'wechat'
      }
    ]
  })

  const context = require('../../cloudfunctions/api/services/context')({ db })

  // 模拟微信服务器连续并发推送 2 次支付成功回调
  const [settleRes1, settleRes2] = await Promise.all([
    context.settleOrderPayment('ord_pay_repeat', { paymentNo: 'PNO_999', channel: 'wechat', wxTransactionId: 'WX_TX_123' }),
    context.settleOrderPayment('ord_pay_repeat', { paymentNo: 'PNO_999', channel: 'wechat', wxTransactionId: 'WX_TX_123' })
  ])

  // 其中一次发生状态变更，另一次命中幂等防护返回 changed: false
  const changedCount = (settleRes1.changed ? 1 : 0) + (settleRes2.changed ? 1 : 0)
  assert.equal(changedCount, 1, '必须仅且只有 1 次回调被作为有效变更执行')

  // 验证商品销量只加了 1，没有翻倍
  const product = db.state.mall_products.find(p => p._id === 'prod_single_1')
  assert.equal(product.salesCount, 1, '销量必须严格为 1，不可重复累加')

  // 验证财务记录只写入 1 条
  const logs = db.state.finance_logs.filter(f => f.orderId === 'ord_pay_repeat')
  assert.equal(logs.length, 1, '实收财务流水必须严格只有 1 条')
})
