const test = require('node:test')
const assert = require('node:assert/strict')
const createSettingsService = require('../../cloudfunctions/api/services/settings')
const createPricingService = require('../../cloudfunctions/api/services/pricing')

test('settings.normalizePricingSurcharges correctly sanitizes dates and time slots', () => {
  const settingsService = createSettingsService({
    db: {},
    defaultHomeModules: {},
    normalizeStaffDepositConfig: (c) => c,
    normalizeStaffSuppliesConfig: (c) => c,
    normalizeStaffTrainingConfig: (c) => c,
    now: () => '2026-09-24 16:00:00',
    safeNumber: (n) => Number(n) || 0,
    safeText: (t) => String(t || '')
  })

  const rawConfig = {
    enabled: true,
    dateSurcharges: [
      { date: '2026-10-01', name: '国庆节', surcharge: 30, enabled: true },
      { date: '2026-10-02', name: '国庆节', surcharge: '35.5', enabled: false },
      { date: '', name: '无效日期', surcharge: 10 }
    ],
    timeSlotSurcharges: [
      { startTime: '07:00', endTime: '09:00', name: '早高峰', surcharge: 15, enabled: true },
      { startTime: '20:00', endTime: '22:00', name: '夜间服务', surcharge: 20, enabled: true },
      { startTime: '', endTime: '22:00', name: '无效' }
    ]
  }

  const normalized = settingsService.normalizePricingSurcharges(rawConfig)
  assert.equal(normalized.enabled, true)
  assert.equal(normalized.dateSurcharges.length, 2)
  assert.equal(normalized.dateSurcharges[0].date, '2026-10-01')
  assert.equal(normalized.dateSurcharges[0].surcharge, 30)
  assert.equal(normalized.dateSurcharges[1].surcharge, 35.5)

  assert.equal(normalized.timeSlotSurcharges.length, 2)
  assert.equal(normalized.timeSlotSurcharges[0].startTime, '07:00')
  assert.equal(normalized.timeSlotSurcharges[0].endTime, '09:00')
  assert.equal(normalized.timeSlotSurcharges[0].surcharge, 15)
  assert.equal(normalized.timeSlotSurcharges[1].surcharge, 20)
})

test('pricing.calcOrderPricing accurately applies date and timeSlot surcharges', async () => {
  const mockSystemSettings = {
    pricingSurcharges: {
      enabled: true,
      dateSurcharges: [
        { id: 'ds_1', date: '2026-10-01', name: '国庆节', surcharge: 30, enabled: true },
        { id: 'ds_2', date: '2026-10-02', name: '国庆节', surcharge: 30, enabled: true }
      ],
      timeSlotSurcharges: [
        { id: 'ts_1', startTime: '07:00', endTime: '09:00', name: '早高峰', surcharge: 15, enabled: true }
      ]
    }
  }

  const pricingService = createPricingService({
    PET_TIMED_SERVICE_KEYS: ['walk'],
    addMinutesToDateTimeText: (dt, m) => '2026-10-01 09:30:00',
    applyCouponToPricing: (p) => p,
    buildOrderSessions: (data) => [
      { index: 1, date: '2026-10-01', startTime: '2026-10-01 08:30:00', endTime: '2026-10-01 09:30:00' }
    ],
    db: { collection: () => ({ get: async () => ({ data: [] }) }) },
    evaluateCoupon: () => ({ applicable: false }),
    getAvailableUserCoupons: async () => [],
    getBusinessServiceTypes: (types) => types.filter((t) => t !== 'visit_fee'),
    getSystemSettings: async () => mockSystemSettings,
    listServicePrices: async () => [
      { key: 'visit_fee', label: '上门费', price: 30, internPrice: 20 },
      { key: 'feed', label: '上门喂养', price: 50, internPrice: 40, extraPetRule: 'none' }
    ],
    normalizePetIds: () => ['pet1'],
    normalizeServiceTypes: () => ['visit_fee', 'feed'],
    normalizeStaffWorkflow: (p) => p,
    safeText: (t) => String(t || ''),
    validateVisitFeeServices: () => {}
  })

  // Case 1: 单天订单命中 10-01 日期加价(¥30) 与 08:30 早高峰加价(¥15)
  const orderData = {
    startTime: '2026-10-01 08:30:00',
    endTime: '2026-10-01 09:30:00',
    durationMinutes: 60,
    serviceTypes: ['visit_fee', 'feed']
  }
  const pets = [{ _id: 'pet1', name: '咪咪', species: 'cat' }]

  const pricing = await pricingService.calcOrderPricing(orderData, pets)

  // 基础价格: 上门费30 + 喂养50 = 80
  // 加价: 日期加价30 + 时段加价15 = 45
  // 总计: 80 + 45 = 125
  assert.equal(pricing.amount, 125)
  assert.equal(pricing.payAmount, 125)

  const dateItem = pricing.priceItems.find((item) => item.type === 'date_surcharge')
  assert.ok(dateItem, 'priceItems must contain date_surcharge')
  assert.equal(dateItem.price, 30)
  assert.ok(dateItem.label.includes('国庆节'))

  const timeItem = pricing.priceItems.find((item) => item.type === 'time_surcharge')
  assert.ok(timeItem, 'priceItems must contain time_surcharge')
  assert.equal(timeItem.price, 15)
  assert.ok(timeItem.label.includes('早高峰'))
})
