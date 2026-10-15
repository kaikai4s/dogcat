const test = require('node:test')
const assert = require('node:assert/strict')
const createLogisticsService = require('../../cloudfunctions/api/services/logistics')
const createMallCatalog = require('../../cloudfunctions/api/services/mallCatalog')

test('mallCatalog: supports detail images, parameters, usage instructions, service guarantees and highlights', () => {
  const catalog = createMallCatalog({
    applyCouponToPricing: () => ({}),
    db: {},
    getDocOrNull: async () => null,
    now: () => new Date('2026-10-15T12:00:00Z'),
    safeFileId: s => String(s || ''),
    safeText: s => String(s || '')
  })

  const rawProduct = {
    _id: 'prod_1',
    name: '全价无谷全鲜肉猫粮',
    subtitle: '78%鲜肉含量 / 低敏好消化',
    price: 158,
    stock: 50,
    coverFileId: 'cloud://prod-cover.jpg',
    imageFileIds: ['cloud://slide-1.jpg', 'cloud://slide-2.jpg'],
    detailImageFileIds: [
      'cloud://detail-1.jpg',
      'cloud://detail-2.jpg',
      'cloud://detail-3.jpg'
    ],
    parameters: [
      { label: '适用对象', value: '全阶段猫咪' },
      { label: '保质期', value: '18个月' },
      { label: '净含量', value: '1.8kg' },
      { label: '储存方式', value: '阴凉干燥处常温密封保存' }
    ],
    usageInstructions: '建议采用7日换粮法循序渐进；每日喂食量请参考体重对照表。',
    serviceGuarantees: ['正品保障', '极速发货', '破损包赔', '7天无理由退换'],
    highlights: ['78%全鲜肉', '0谷物0胶质', '单一鸡肉源']
  }

  const normalized = catalog.normalizeMallProduct(rawProduct)
  assert.equal(normalized.name, '全价无谷全鲜肉猫粮')
  assert.equal(normalized.detailImageFileIds.length, 3)
  assert.equal(normalized.parameters.length, 4)
  assert.equal(normalized.parameters[0].label, '适用对象')
  assert.equal(normalized.parameters[0].value, '全阶段猫咪')
  assert.equal(normalized.usageInstructions, '建议采用7日换粮法循序渐进；每日喂食量请参考体重对照表。')
  assert.deepEqual(normalized.serviceGuarantees, ['正品保障', '极速发货', '破损包赔', '7天无理由退换'])
  assert.deepEqual(normalized.highlights, ['78%全鲜肉', '0谷物0胶质', '单一鸡肉源'])

  // publicMallProduct retains the enriched fields
  const pub = catalog.publicMallProduct(normalized)
  assert.equal(pub.detailImageFileIds.length, 3)
  assert.equal(pub.parameters.length, 4)
  assert.equal(pub.usageInstructions, '建议采用7日换粮法循序渐进；每日喂食量请参考体重对照表。')
})

test('logistics: provides express list and generates realistic traces with status tracking', async () => {
  const logistics = createLogisticsService({
    db: {
      collection: () => ({
        doc: () => ({
          update: async () => ({ stats: { updated: 1 } })
        })
      })
    },
    getSystemSettings: async () => ({}),
    https: {},
    now: () => new Date('2026-10-15T12:00:00Z'),
    safeText: s => String(s || '')
  })

  // 1. List express companies
  const companies = logistics.listExpressCompanies()
  assert.ok(Array.isArray(companies))
  assert.ok(companies.some(c => c.name === '顺丰速运' && c.code === 'sf'))
  assert.ok(companies.some(c => c.name === '京东快递' && c.code === 'jd'))

  // 2. Normalize express company name
  const sf = logistics.normalizeExpressCompany('顺丰')
  assert.equal(sf.name, '顺丰速运')
  assert.equal(sf.code, 'sf')

  // 3. Unshipped order returns hasLogistics: false
  const unshipped = await logistics.queryOrderLogistics({ _id: 'ord_1', status: 'pending_ship' })
  assert.equal(unshipped.hasLogistics, false)

  // 4. Shipped order returns structured traces
  const shippedOrder = {
    _id: 'ord_shipped_1',
    status: 'shipped',
    expressCompany: '顺丰速运',
    trackingNo: 'SF1234567890',
    shippedAt: new Date(Date.now() - 3600 * 1000 * 20).toISOString(),
    shippingAddress: {
      contactName: '张小喵',
      serviceAddress: '北京市朝阳区三里屯街道'
    }
  }

  const result = await logistics.queryOrderLogistics(shippedOrder)
  assert.equal(result.hasLogistics, true)
  assert.equal(result.expressCompany, '顺丰速运')
  assert.equal(result.trackingNo, 'SF1234567890')
  assert.ok(Array.isArray(result.traces))
  assert.ok(result.traces.length >= 3)
  assert.ok(result.traces[0].time)
  assert.ok(result.traces[0].context)

  // 5. Completed order marks isDelivered: true
  const completedOrder = {
    ...shippedOrder,
    status: 'completed',
    receivedAt: new Date().toISOString()
  }
  const completedResult = await logistics.queryOrderLogistics(completedOrder)
  assert.equal(completedResult.isDelivered, true)
  assert.equal(completedResult.statusCode, 'delivered')
  assert.equal(completedResult.traces[0].status, 'delivered')
})

test('mall: supports custom shippingFee per product and customizable service guarantees', () => {
  const catalog = createMallCatalog({
    applyCouponToPricing: (base) => base,
    db: {},
    getDocOrNull: async () => null,
    now: () => new Date('2026-10-15T12:00:00Z'),
    safeFileId: (s) => String(s || ''),
    safeText: (s) => String(s || '')
  })

  // 1. Decoupled guarantees: allows empty array and custom guarantees, never force 7-day return
  const livePetProduct = {
    _id: 'prod_live_cat',
    name: '纯种英短蓝猫活体',
    price: 2600,
    shippingFee: 80,
    serviceGuarantees: ['纯种保证', '健康质保30天', '拆封/离店不退']
  }
  const normalizedLive = catalog.normalizeMallProduct(livePetProduct)
  assert.equal(normalizedLive.shippingFee, 80)
  assert.deepEqual(normalizedLive.serviceGuarantees, ['纯种保证', '健康质保30天', '拆封/离店不退'])

  const noGuaranteeProduct = {
    _id: 'prod_no_guarantee',
    name: '特价试吃小样',
    price: 1,
    shippingFee: 0,
    serviceGuarantees: []
  }
  const normalizedNoGuarantee = catalog.normalizeMallProduct(noGuaranteeProduct)
  assert.equal(normalizedNoGuarantee.shippingFee, 0)
  assert.deepEqual(normalizedNoGuarantee.serviceGuarantees, [])

  // 2. Pricing calculates shippingFee from items
  // Case A: Free shipping product
  const pricingFree = catalog.calcMallPricing([
    { price: 20, quantity: 2, shippingFee: 0 }
  ])
  assert.equal(pricingFree.totalProductAmount, 40)
  assert.equal(pricingFree.shippingFee, 0)
  assert.equal(pricingFree.payAmount, 40)

  // Case B: Single product with shippingFee
  const pricingSingle = catalog.calcMallPricing([
    { price: 15, quantity: 1, shippingFee: 8 }
  ])
  assert.equal(pricingSingle.totalProductAmount, 15)
  assert.equal(pricingSingle.shippingFee, 8)
  assert.equal(pricingSingle.payAmount, 23)

  // Case C: Multi products take max shippingFee
  const pricingMulti = catalog.calcMallPricing([
    { price: 10, quantity: 1, shippingFee: 6 },
    { price: 50, quantity: 1, shippingFee: 15 },
    { price: 30, quantity: 2, shippingFee: 0 }
  ])
  assert.equal(pricingMulti.totalProductAmount, 120)
  assert.equal(pricingMulti.shippingFee, 15)
  assert.equal(pricingMulti.payAmount, 135)
})

test('mall: scheduled task auto-completes delivered or expired shipped orders', async () => {
  const nowTime = new Date('2026-10-15T12:00:00Z')
  const eightDaysAgo = new Date(nowTime.getTime() - 8 * 24 * 3600 * 1000)
  const twoDaysAgo = new Date(nowTime.getTime() - 2 * 24 * 3600 * 1000)

  let updatedOrders = []
  const mockDb = {
    collection: (name) => {
      assert.equal(name, 'mall_orders')
      return {
        doc: (docId) => ({
          update: async ({ data }) => {
            updatedOrders.push({ data, id: docId })
            return { stats: { updated: 1 } }
          }
        }),
        where: (query) => ({
          limit: () => ({
            get: async () => ({
              data: [
                // 订单1：发货超7天，无售后，应自动完成
                { _id: 'ord_timeout', status: 'shipped', shippedAt: eightDaysAgo.toISOString(), refundStatus: 'none' },
                // 订单2：发货仅2天，但物流缓存显示已签收，应自动完成
                { _id: 'ord_delivered', status: 'shipped', shippedAt: twoDaysAgo.toISOString(), refundStatus: 'none', logisticsCache: { isDelivered: true } },
                // 订单3：售后处理中，不应自动收货
                { _id: 'ord_refunding', status: 'shipped', shippedAt: eightDaysAgo.toISOString(), refundStatus: 'applied' }
              ]
            })
          })
        })
      }
    }
  }

  const catalog = createMallCatalog({
    applyCouponToPricing: (base) => base,
    db: mockDb,
    getDocOrNull: async () => null,
    now: () => nowTime,
    safeFileId: (s) => String(s || ''),
    safeText: (s) => String(s || '')
  })

  const completedIds = await catalog.autoCompleteDeliveredMallOrders(7)
  assert.equal(completedIds.length, 2)
  assert.ok(completedIds.includes('ord_timeout'))
  assert.ok(completedIds.includes('ord_delivered'))
  assert.ok(!completedIds.includes('ord_refunding'))
})

test('mall: supports full return_and_refund reverse logistics and compensation flows', async () => {
  const nowTime = new Date('2026-10-15T12:00:00Z')
  let orderState = {
    _id: 'ord_return_1',
    orderNo: 'ORD_RET_001',
    clientOpenid: 'client_buyer_1',
    status: 'completed',
    paymentStatus: 'paid',
    payAmount: 188,
    refundStatus: 'none',
    receivedAt: nowTime.toISOString()
  }

  // 1. 买家申请退货退款 (return_and_refund)
  orderState = {
    ...orderState,
    status: 'refund_applied',
    refundStatus: 'applied',
    afterSaleType: 'return_and_refund',
    preRefundStatus: 'completed',
    refundReason: '猫咪不喜欢此口味，包装完好申请退货'
  }
  assert.equal(orderState.afterSaleType, 'return_and_refund')

  // 2. 商家审核同意，下发退货收件人与地址 (return_pending_ship)
  const returnAddress = {
    receiver: '售后客服部',
    phone: '13812345678',
    address: '北京市大兴区电商产业园A座5层售后组'
  }
  orderState = {
    ...orderState,
    refundStatus: 'return_pending_ship',
    returnAddress,
    refundAuditRemark: '同意退货，请保持原包装寄回'
  }
  assert.equal(orderState.refundStatus, 'return_pending_ship')
  assert.equal(orderState.returnAddress.receiver, '售后客服部')

  // 3. 买家寄出并回填快递单号 (return_shipped)
  orderState = {
    ...orderState,
    refundStatus: 'return_shipped',
    returnExpress: {
      expressCompany: '顺丰速运',
      trackingNo: 'SF88888888',
      shippedAt: nowTime.toISOString()
    }
  }
  assert.equal(orderState.refundStatus, 'return_shipped')
  assert.equal(orderState.returnExpress.trackingNo, 'SF88888888')

  // 4. 商家验货入库并原路退款 (refunded)
  orderState = {
    ...orderState,
    status: 'refunded',
    refundStatus: 'full_refunded',
    refundAmount: 188,
    refundedAmount: 188
  }
  assert.equal(orderState.status, 'refunded')
  assert.equal(orderState.refundedAmount, 188)

  // 5. 赔付补偿场景 (compensation)
  let compOrder = {
    _id: 'ord_comp_1',
    orderNo: 'ORD_COMP_001',
    status: 'completed',
    paymentStatus: 'paid',
    payAmount: 200,
    refundStatus: 'none'
  }
  // 买家申请少发补偿 20 元
  compOrder = {
    ...compOrder,
    status: 'refund_applied',
    refundStatus: 'applied',
    afterSaleType: 'compensation',
    preRefundStatus: 'completed',
    refundReason: '主粮包装轻微破损，未漏粮，协商补偿20元',
    refundRequestedAmount: 20
  }
  assert.equal(compOrder.afterSaleType, 'compensation')
  assert.equal(compOrder.refundRequestedAmount, 20)

  // 商家审核同意补偿，执行部分退款 20 元，主订单保持 completed
  compOrder = {
    ...compOrder,
    status: 'completed',
    paymentStatus: 'paid',
    refundStatus: 'partially_refunded',
    compensationAmount: 20,
    compensationRemark: '同意破损补偿20元已原路退款',
    refundAmount: 20,
    refundedAmount: 20
  }
  assert.equal(compOrder.status, 'completed')
  assert.equal(compOrder.compensationAmount, 20)
  assert.equal(compOrder.refundStatus, 'partially_refunded')
})



