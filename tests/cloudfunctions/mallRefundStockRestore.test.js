const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const optimistic = require('./optimisticTransactions')
const createContext = require('../../cloudfunctions/api/services/context')

function setupMallRefundTest(initialExtra = {}) {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active' },
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' }
    ],
    mall_products: [
      {
        _id: 'prod_dog_food',
        name: '全价冻干无谷犬粮 2kg',
        specMode: 'single',
        price: 100,
        originalPrice: 120,
        stock: 8, // 假设已被购买2件，初始10件，当前剩8件
        totalStock: 8,
        salesCount: 2, // 已售2件
        status: 'on_sale',
        skus: [
          { skuId: 'default', specText: '2kg装', price: 100, stock: 8, salesCount: 2, status: 'on_sale' }
        ]
      },
      {
        _id: 'prod_multi_spec',
        name: '多规格猫粮',
        specMode: 'multi',
        price: 50,
        stock: 15,
        totalStock: 15,
        salesCount: 5,
        specGroups: [
          { name: '规格', values: ['1kg装', '5kg装'] }
        ],
        skus: [
          { skuId: 'sku_1kg', specs: { 规格: '1kg装' }, specText: '1kg装', price: 50, stock: 7, salesCount: 3, status: 'on_sale' },
          { skuId: 'sku_5kg', specs: { 规格: '5kg装' }, specText: '5kg装', price: 200, stock: 8, salesCount: 2, status: 'on_sale' }
        ]
      }
    ],
    mall_orders: [
      {
        _id: 'order_mall_pending_ship',
        orderType: 'mall',
        orderNo: 'MO10001',
        clientOpenid: 'openid_client',
        status: 'pending_ship',
        paymentStatus: 'paid',
        paymentNo: 'P_MALL_1',
        wxTransactionId: 'WX_MALL_1',
        payAmount: 200,
        refundAmount: 0,
        refundedAmount: 0,
        items: [
          {
            productId: 'prod_dog_food',
            skuId: 'default',
            name: '全价冻干无谷犬粮 2kg',
            price: 100,
            quantity: 2
          }
        ],
        createdAt: new Date()
      }
    ],
    refunds: [],
    finance_logs: [],
    payment_events: [],
    ...initialExtra
  })

  optimistic(db)
  const baseContext = createContext({ db, cloud: {} })
  const service = require('../../cloudfunctions/api/services/refunds')({
    ...baseContext,
    getSystemSettings: async () => ({ payment: { mode: 'wechat', refundEnabled: true } }),
    getWechatPayConfig: () => ({ appId: 'app', mchId: 'mch', apiV3Key: 'key', certSerialNo: 'cert', privateKey: 'pk' }),
    wechatPayRequest: async (method, path, body) => ({
      status: 'SUCCESS',
      out_refund_no: body.out_refund_no,
      refund_id: `WX_REF_${Date.now()}`,
      amount: body.amount
    })
  })
  return { db, baseContext, ...service }
}

test('mall refund stock restore: 未发货商城订单全额退款成功后，商品库存与销量精准回滚', async () => {
  const { db, requestOrderRefund } = setupMallRefundTest()

  const order = structuredClone(db.state.mall_orders[0])
  const res = await requestOrderRefund(order, 200, '用户未发货申请退款', 'admin_mall_manual', 'openid_admin', 'req_refund_1')

  assert.equal(res.status, 'success')

  // 1. 验证订单状态
  const updatedOrder = db.state.mall_orders.find((o) => o._id === 'order_mall_pending_ship')
  assert.equal(updatedOrder.status, 'refunded')
  assert.equal(updatedOrder.paymentStatus, 'refunded')
  assert.equal(updatedOrder.refundStatus, 'full_refunded')
  assert.equal(updatedOrder.refundedAmount, 200)
  assert.equal(updatedOrder.stockRestored, true, '订单必须被打上 stockRestored 标记')

  // 2. 验证商品库存与销量回滚
  const product = db.state.mall_products.find((p) => p._id === 'prod_dog_food')
  assert.equal(product.stock, 10, '单规格商品 stock 应从 8 恢复为 10')
  assert.equal(product.totalStock, 10, 'totalStock 应恢复为 10')
  assert.equal(product.salesCount, 0, 'salesCount 应从 2 核减为 0')
  assert.equal(product.skus[0].stock, 10, 'SKU stock 应恢复为 10')
  assert.equal(product.skus[0].salesCount, 0, 'SKU salesCount 应恢复为 0')
})

test('mall refund stock restore: 多规格商品退款成功后准确回退指定规格库存与对应销量', async () => {
  const { db, requestOrderRefund } = setupMallRefundTest({
    mall_orders: [
      {
        _id: 'order_multi_spec',
        orderType: 'mall',
        orderNo: 'MO10002',
        clientOpenid: 'openid_client',
        status: 'pending_ship',
        paymentStatus: 'paid',
        paymentNo: 'P_MALL_2',
        wxTransactionId: 'WX_MALL_2',
        payAmount: 150,
        refundAmount: 0,
        refundedAmount: 0,
        items: [
          {
            productId: 'prod_multi_spec',
            skuId: 'sku_1kg',
            name: '多规格猫粮',
            price: 50,
            quantity: 3
          }
        ],
        createdAt: new Date()
      }
    ]
  })

  const order = structuredClone(db.state.mall_orders[0])
  const res = await requestOrderRefund(order, 150, '买错了退款', 'admin_mall_manual', 'openid_admin', 'req_refund_multi')

  assert.equal(res.status, 'success')

  const product = db.state.mall_products.find((p) => p._id === 'prod_multi_spec')
  const sku1kg = product.skus.find((s) => s.skuId === 'sku_1kg')
  const sku5kg = product.skus.find((s) => s.skuId === 'sku_5kg')

  // sku_1kg 应从 7 恢复为 10，销量从 3 减为 0
  assert.equal(sku1kg.stock, 10)
  assert.equal(sku1kg.salesCount, 0)

  // sku_5kg 保持不变
  assert.equal(sku5kg.stock, 8)
  assert.equal(sku5kg.salesCount, 2)

  // 商品总库存与总销量重新平衡
  assert.equal(product.totalStock, 10 + 8)
  assert.equal(product.salesCount, 0 + 2)
})

test('mall refund stock restore: 已恢复库存的订单重复执行退款对账时不发生二次重复累加（幂等）', async () => {
  const { db, dispatchOrderRefund } = setupMallRefundTest({
    mall_orders: [
      {
        _id: 'order_mall_already_restored',
        orderType: 'mall',
        clientOpenid: 'openid_client',
        status: 'refunded',
        paymentStatus: 'refunded',
        payAmount: 100,
        refundAmount: 100,
        refundedAmount: 100,
        stockRestored: true, // 已经恢复过库存
        items: [
          { productId: 'prod_dog_food', skuId: 'default', quantity: 2 }
        ]
      }
    ],
    refunds: [
      {
        _id: 'refund_already_done',
        orderId: 'order_mall_already_restored',
        refundNo: 'R_DONE_1',
        amount: 100,
        refundAmount: 100,
        status: 'processing',
        channel: 'wechat'
      }
    ]
  })

  // 模拟对账重试
  await dispatchOrderRefund(db.state.refunds[0])

  // 库存仍为初始的 8，绝对不能再次累加变成 10 或 12
  const product = db.state.mall_products.find((p) => p._id === 'prod_dog_food')
  assert.equal(product.stock, 8, '库存不能被二次重复累加')
})

test('mall refund stock restore: 超卖导致的退款订单（oversoldRefundRequired）全额退款不额外多加库存', async () => {
  const { db, requestOrderRefund } = setupMallRefundTest({
    mall_orders: [
      {
        _id: 'order_mall_oversold',
        orderType: 'mall',
        clientOpenid: 'openid_client',
        status: 'refund_applied',
        paymentStatus: 'paid',
        paymentNo: 'P_OVERSOLD',
        wxTransactionId: 'WX_OVERSOLD',
        payAmount: 100,
        refundAmount: 0,
        refundedAmount: 0,
        oversoldRefundRequired: true, // 标记为超卖单，当时未扣库存
        items: [
          { productId: 'prod_dog_food', skuId: 'default', quantity: 2 }
        ],
        createdAt: new Date()
      }
    ]
  })

  const order = structuredClone(db.state.mall_orders[0])
  await requestOrderRefund(order, 100, '超卖自动退款', 'system_auto_refund', 'system', 'req_oversold')

  // 库存应保持为 8，不增加
  const product = db.state.mall_products.find((p) => p._id === 'prod_dog_food')
  assert.equal(product.stock, 8, '超卖退款订单不应凭空增加商品库存')
})

test('mall refund stock restore: 已确认收货完成的订单（completed）全额退款不自动恢复在售库存', async () => {
  const { db, requestOrderRefund } = setupMallRefundTest({
    mall_orders: [
      {
        _id: 'order_mall_completed',
        orderType: 'mall',
        clientOpenid: 'openid_client',
        status: 'completed',
        paymentStatus: 'paid',
        paymentNo: 'P_COMPLETED',
        wxTransactionId: 'WX_COMPLETED',
        payAmount: 100,
        refundAmount: 0,
        refundedAmount: 0,
        items: [
          { productId: 'prod_dog_food', skuId: 'default', quantity: 2 }
        ],
        createdAt: new Date()
      }
    ]
  })

  const order = structuredClone(db.state.mall_orders[0])
  await requestOrderRefund(order, 100, '收货后客诉全额退款', 'admin_mall_manual', 'openid_admin', 'req_completed')

  // 订单保持 completed 状态（在 refunds.js 中不会被置为 refunded）
  const product = db.state.mall_products.find((p) => p._id === 'prod_dog_food')
  assert.equal(product.stock, 8, '已完成收货的订单退款不自动回滚在售库存')
})
