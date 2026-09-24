const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')

test('1. multi-pet multi-day pricing precision: no floating point IEEE-754 drift in priceItems and total amount', async () => {
  const db = createCollectionStore({
    service_prices: [
      { key: 'visit_fee', label: '上门基础服务', price: 30, internPrice: 25, extraPetRule: 'none' },
      { key: 'feed', label: '日常喂食', price: 20, internPrice: 15, extraPetRule: 'all', extraPetFee: 15.5, internExtraPetFee: 12.5 },
      { key: 'play', label: '互动玩耍', price: 35, internPrice: 30, extraHalfHourFee: 18.8, internExtraHalfHourFee: 15.8, extraPetRule: 'all', extraPetFee: 10 }
    ],
    staff_profiles: [],
    user_coupons: []
  })

  const context = require('../../cloudfunctions/api/services/context')({ db })
  const pets = [
    { _id: 'pet_cat_1', name: '咪咪', species: 'cat' },
    { _id: 'pet_cat_2', name: '橘宝', species: 'cat' }
  ]

  // 下单参数：选择 2 只猫、日常喂食 + 玩耍服务，玩耍时长为 90 分钟（续时 2 个 30 分钟 = 2 * 18.8 = 37.6 元），连续服务 3 天
  const orderData = {
    serviceTypes: ['visit_fee', 'feed', 'play'],
    startTime: '2026-10-01 10:00',
    serviceDays: 3,
    petServiceDurations: [
      { serviceKey: 'play', petId: 'pet_cat_1', durationMinutes: 90 },
      { serviceKey: 'play', petId: 'pet_cat_2', durationMinutes: 60 } // 续时 1 个 30 分钟 = 18.8 元
    ]
  }

  const pricing = await context.calcOrderPricing(orderData, pets)

  // 验证每个价格细项均没有浮点尾数
  pricing.priceItems.forEach(item => {
    assert.equal(String(item.price).includes('000000000'), false, `Item ${item.key} price ${item.price} has floating drift`)
    assert.equal(String(item.price).includes('999999999'), false, `Item ${item.key} price ${item.price} has floating drift`)
    assert.ok(Number.isSafeInteger(Math.round(item.price * 100)))
  })

  // 验证总价与细项总和分毫不差
  const sumOfItems = Math.round(pricing.priceItems.reduce((sum, item) => sum + Math.round(item.price * 100), 0)) / 100
  assert.equal(pricing.amount, sumOfItems)
  assert.equal(String(pricing.amount).includes('000000000'), false)
})

test('2. coupon discount calculation: subtraction does not generate 0.30000000000000004 floating error', () => {
  const { applyCouponToPricing } = require('../../cloudfunctions/api/services/coupons')({
    now: () => new Date(),
    couponRuleText: () => '满减券',
    db: {}
  })

  // 模拟浮点陷阱：0.1 + 0.2 或类似金额，例如 100.1 - 20.3
  const basePricing = {
    amount: 100.1,
    payAmount: 100.1,
    priceItems: [{ key: 'service', label: '上门服务', price: 100.1 }],
    priceSnapshot: { originalAmount: 100.1, discountAmount: 0, payAmount: 100.1 }
  }

  const couponResult = {
    applicable: true,
    couponId: 'c1',
    templateId: 't1',
    name: '优惠减20.3',
    discountAmount: 20.3,
    ruleText: '立减20.3元',
    snapshot: { discountAmount: 20.3 }
  }

  const priced = applyCouponToPricing(basePricing, couponResult)
  // 原生 JS: 100.1 - 20.3 = 79.80000000000001
  assert.equal(priced.payAmount, 79.8, 'payAmount must be strictly 79.8 without floating drift')
  assert.equal(String(priced.payAmount), '79.8')
  assert.equal(priced.discountAmount, 20.3)
})

test('3. staff earnings commission calculation: cents-based arithmetic avoids rounding mismatch', async () => {
  const db = createCollectionStore({
    platform_configs: [{
      _id: 'cfg_settle',
      key: 'system_settings',
      value: { settlement: { staffCommissionRate: 0.7, settlementDelayDays: 0 } }
    }],
    staff_earnings: [],
    finance_logs: [],
    orders: []
  })

  const context = require('../../cloudfunctions/api/services/context')({ db })

  // 难以整除的奇数金额，如 89.9 元，70% 分成 = 62.93 元
  const earningInfo = await context.calculateStaffEarningForOrder({ payAmount: 89.9 })
  assert.equal(earningInfo.earningAmount, 62.93)
  assert.equal(String(earningInfo.earningAmount), '62.93')

  // 扣减金额 10.15 元：62.93 - 10.15 = 52.78 元
  const created = await context.ensureStaffEarning(
    { _id: 'o_earning_test', orderNo: 'ORD_E1', staffOpenid: 's_openid_1', payAmount: 89.9 },
    new Date(),
    { deductAmount: 10.15, deductReason: '迟到扣减' }
  )

  assert.equal(created.grossAmount, 89.9)
  assert.equal(created.originalAmount, 62.93)
  assert.equal(created.deductAmount, 10.15)
  assert.equal(created.amount, 52.78)
  assert.equal(String(created.amount), '52.78')
})
