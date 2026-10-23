const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createCollectionStore } = require('./helpers')
const createRateLimits = require('../../cloudfunctions/api/services/rateLimits')
function fixture() {
  const db = createCollectionStore({ mall_orders: [{ _id: 'o', clientOpenid: 'account', trackingNo: 'TRACK', status: 'shipped' }] })
  let time = Date.UTC(2026, 9, 23, 10, 4, 50), queries = 0
  const context = { db, crypto, now: () => new Date(time), safeText: v => String(v || '') }
  Object.assign(context, createRateLimits(context), {
    getUser: async () => ({ roles: ['client', 'admin'] }), requireAdmin: async () => ({}),
    getDocOrNull: async (_, id) => structuredClone(db.state.mall_orders.find(row => row._id === id)),
    queryOrderLogistics: async () => { queries++; return { hasLogistics: true, isDelivered: false, traces: [] } }
  })
  return { db, context, advance: ms => { time += ms }, queries: () => queries }
}

test('shared rolling window allows three queries then rejects a fourth without querying logistics', async () => {
  const f = fixture()
  const client = require('../../cloudfunctions/api/handlers/mall')(f.context)
  const admin = require('../../cloudfunctions/api/handlers/adminMall')(f.context)
  await client('account', 'queryOrderLogistics', { orderId: 'o' })
  await admin('account', 'queryOrderLogistics', { orderId: 'o' })
  await client('account', 'queryOrderLogistics', { orderId: 'o' })
  await assert.rejects(() => admin('account', 'queryOrderLogistics', { orderId: 'o' }), error => {
    assert.equal(error.code, 'LOGISTICS_RATE_LIMITED')
    assert.equal(error.retryAfterSeconds, 300)
    assert.match(error.message, /5分钟内最多查询3次/)
    return true
  })
  assert.equal(f.queries(), 3)
  assert.equal(f.db.state.rate_limits.length, 1)
  assert.equal(f.db.state.rate_limits[0].timestamps.length, 3)
})

test('crossing a fixed clock boundary cannot reset the rolling window', async () => {
  const f = fixture()
  for (let i = 0; i < 3; i++) await f.context.checkLogisticsQueryRateLimit('account')
  f.advance(20000) // 10:05:10: the previous 10:00-10:05 clock bucket has ended.
  await assert.rejects(() => f.context.checkLogisticsQueryRateLimit('account'), error => error.retryAfterSeconds === 280)
  f.advance(280000)
  assert.equal((await f.context.checkLogisticsQueryRateLimit('account')).count, 1)
})

test('rolling window releases one slot at a time; another account has its own quota', async () => {
  const f = fixture()
  await f.context.checkLogisticsQueryRateLimit('account')
  f.advance(60000)
  await f.context.checkLogisticsQueryRateLimit('account')
  f.advance(60000)
  await f.context.checkLogisticsQueryRateLimit('account')
  for (let i = 0; i < 3; i++) await f.context.checkLogisticsQueryRateLimit('other')
  f.advance(180000)
  assert.equal((await f.context.checkLogisticsQueryRateLimit('account')).count, 3)
  await assert.rejects(() => f.context.checkLogisticsQueryRateLimit('account'), error => error.retryAfterSeconds === 60)
})

test('concurrent requests across independent service instances share durable quota', async () => {
  const f = fixture()
  require('./optimisticTransactions')(f.db)
  const second = createRateLimits({ db: f.db, crypto, now: f.context.now, safeText: f.context.safeText })
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => (i % 2 ? second : f.context).checkLogisticsQueryRateLimit('account')))
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 3)
  assert.equal(results.filter(row => row.status === 'rejected' && row.reason.code === 'LOGISTICS_RATE_LIMITED').length, 5)
})

test('unauthorized and unshipped orders do not consume query quota; order switching cannot reset it', async () => {
  const f = fixture()
  const client = require('../../cloudfunctions/api/handlers/mall')(f.context)
  await assert.rejects(() => client('other', 'queryOrderLogistics', { orderId: 'o' }), /订单不存在/)
  assert.equal((f.db.state.rate_limits || []).length, 0)
  f.db.state.mall_orders.push({ _id: 'unshipped', clientOpenid: 'account' })
  await client('account', 'queryOrderLogistics', { orderId: 'unshipped' })
  assert.equal((f.db.state.rate_limits || []).length, 0)
  for (let i = 0; i < 4; i++) f.db.state.mall_orders.push({ _id: 'o' + i, clientOpenid: 'account', trackingNo: 'TRACK' + i })
  for (let i = 0; i < 3; i++) await client('account', 'queryOrderLogistics', { orderId: 'o' + i })
  await assert.rejects(() => client('account', 'queryOrderLogistics', { orderId: 'o3' }), /查询过于频繁/)
})

test('failed logistics attempts consume quota and database errors cannot bypass the limiter', async () => {
  const f = fixture()
  f.context.queryOrderLogistics = async () => { throw new Error('provider failed') }
  const client = require('../../cloudfunctions/api/handlers/mall')(f.context)
  for (let i = 0; i < 3; i++) await assert.rejects(() => client('account', 'queryOrderLogistics', { orderId: 'o' }), /provider failed/)
  await assert.rejects(() => client('account', 'queryOrderLogistics', { orderId: 'o' }), /查询过于频繁/)
  f.db.runTransaction = async () => { throw new Error('rate limit store failed') }
  await assert.rejects(() => f.context.checkLogisticsQueryRateLimit('new-account'), /rate limit store failed/)
})
