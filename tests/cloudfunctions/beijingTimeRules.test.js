const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const time = require('../../cloudfunctions/api/utils/time')

test('fixed-date coupons and the cancellation threshold use Beijing in every server timezone', () => {
  const script = `
    const assert = require('node:assert/strict');
    const time = require('./cloudfunctions/api/utils/time');
    const issuance = require('./cloudfunctions/api/services/couponIssuance')({normalizeCouponSnapshot: v=>v});
    const range=issuance.getCouponValidRange({validType:'fixed_range',validFromFixed:'2026-09-25',validToFixed:'2026-09-26'}, new Date());
    assert.equal(range.validFrom.toISOString(),'2026-09-24T16:00:00.000Z');
    assert.equal(range.validTo.toISOString(),'2026-09-26T15:59:59.000Z');
    const service=require('./cloudfunctions/api/services/orderAccess')({toTimeValue:time.toTimeValue,now:()=>new Date('2026-09-24T18:40:00Z')});
    const order={status:'assigned',payAmount:69.25};
    assert.equal(service.getCancelQuoteForOrder({...order,startTime:'2026-09-26 02:39'}).refundAmount,55.4);
    assert.equal(service.getCancelQuoteForOrder({...order,startTime:'2026-09-26 02:40'}).refundAmount,69.25);
  `
  for (const TZ of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles']) {
    execFileSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '../..'), env: { ...process.env, TZ } })
  }
})

test('lottery coupons use the entire last Beijing day of a fixed validity range', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'user', openid: 'client', roles: ['client'], status: 'active', points: 100 }],
    lottery_activities: [{ _id: 'activity', enabled: true, pointsCost: 0, prizes: [{ id: 'prize', type: 'coupon', name: 'coupon', templateId: 'template', weight: 100, stockLeft: 10 }] }],
    coupon_templates: [{ _id: 'template', enabled: true, validType: 'fixed_range', validFromFixed: '2026-09-25', validToFixed: '2099-09-26', discountAmount: 10 }]
  })
  const fn = loadCloudFunction('api', db, 'client')
  const result = await fn.main({ module: 'lottery', action: 'draw', data: { activityId: 'activity' } })
  assert.equal(result.ok, true, result.message)
  assert.equal(db.state.user_coupons.length, 1)
  assert.equal(new Date(db.state.user_coupons[0].validFrom).toISOString(), '2026-09-24T16:00:00.000Z')
  assert.equal(new Date(db.state.user_coupons[0].validTo).toISOString(), '2099-09-26T15:59:59.000Z')
})

test('overdue scans start on the Beijing calendar date', async () => {
  const db = createCollectionStore()
  const filters = []
  const collection = db.collection
  db.collection = name => {
    const chain = collection(name)
    const where = chain.where
    chain.where = function(filter) { if (name === 'orders') filters.push(filter); return where.call(this, filter) }
    return chain
  }
  const context = createContext({ db, cloud: {} })
  await context.processOverdueUnstartedOrders('2026-09-24T18:40:00Z')
  await context.processOverdueUnfinishedOrders('2026-09-24T18:40:00Z')
  assert.equal(filters.length, 3)
  for (const filter of filters) assert.equal(filter.startTime.$gte, '2026-09-18 00:00')
})

test('pet age uses Beijing calendar days at month boundaries', () => {
  const { formatPetAgeText } = require('../../cloudfunctions/api/services/petBeauty')({
    parseDateValue: time.parseDateValue,
    toCstParts: value => time.toCstParts(value || new Date('2026-10-24T16:00:00Z'))
  })
  assert.equal(formatPetAgeText('2026-09-25'), '1个月')
  assert.equal(formatPetAgeText('2026-09-26'), '未满1个月')
})
