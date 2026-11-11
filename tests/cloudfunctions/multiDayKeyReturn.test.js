const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const optimistic = require('./optimisticTransactions')
const createContext = require('../../cloudfunctions/api/services/context')
const createSecurity = require('../../cloudfunctions/api/handlers/homeSecurity')
const createExecution = require('../../cloudfunctions/api/services/serviceExecution')
const createOrder = require('../../cloudfunctions/api/handlers/order')

const startedAt = '2026-11-11 00:00:00'
const clock = new Date('2026-11-10T16:30:00Z')
const previousKey = { location: '门垫下', imageFileIds: ['cloud://location'], returnRequired: true,
  returnedAt: '2026-11-10 00:30:00', returnImageFileIds: ['cloud://day1'], returnNote: '第一天已归还' }

function fixture(patch = {}, overrides = {}) {
  const security = { type: 'key', key: structuredClone(previousKey) }
  const db = createCollectionStore({
    users: [{ _id: 'staff', openid: 'staff', roles: ['staff'], status: 'active' },
      { _id: 'client', openid: 'client', roles: ['client'], status: 'active', completedOrderCount: 0 }],
    orders: [{ _id: 'order', clientOpenid: 'client', staffOpenid: 'staff', status: 'in_service', paymentStatus: 'paid',
      payAmount: 100, activeSessionIndex: 2, currentSessionStartedAt: startedAt,
      startTime: '2026-11-10 00:00', endTime: '2026-11-11 01:00',
      serviceSessions: [{ index: 1, startTime: '2026-11-10 00:00', endTime: '2026-11-10 01:00', status: 'completed',
        startedAt: '2026-11-10 00:00', finishedAt: '2026-11-10 01:00' },
      { index: 2, startTime: startedAt, endTime: '2026-11-11 01:00', status: 'in_service', startedAt }],
      orderHomeSecurity: structuredClone(security), homeSecuritySnapshot: structuredClone(security), ...patch }],
    order_home_security: [{ _id: 'security', orderId: 'order', ...structuredClone(security) }]
  })
  optimistic(db)
  const c = { ...createContext({ db, cloud: {} }), now: () => clock,
    requireSanitizationEvidence: async () => {}, checkImageSecurity: async () => {}, checkTextSecurity: async () => {}, ...overrides }
  const securityHandler = createSecurity(c)
  const execution = createExecution(c)
  const orderHandler = createOrder({ ...c, ...execution })
  const record = (data = {}) => securityHandler('staff', 'recordKeyReturned', {
    orderId: 'order', sessionIndex: 2, sessionStartedAt: startedAt, imageFileIds: ['cloud://day2'], ...data
  })
  return { db, c, execution, orderHandler, record }
}

test('yesterday key receipt cannot satisfy the next Beijing day service completion', async () => {
  const f = fixture()
  const proof = await f.execution.evaluateCheckinCompletion(f.db.state.orders[0], f.c.toTimeValue(startedAt))
  assert.equal(proof.isComplete, false)
  assert.deepEqual(proof.missing, ['放回钥匙打卡'])
  const detail = await f.orderHandler('staff', 'getOrderDetail', { id: 'order' })
  assert.equal(detail.orderHomeSecurity.key.returnedAt, '')
  assert.deepEqual(detail.orderHomeSecurity.key.returnImageFileIds, [])
  assert.equal(f.db.state.orders[0].orderHomeSecurity.key.returnedAt, previousKey.returnedAt)
})

test('the next visit accepts its own key photo and preserves earlier return evidence', async () => {
  const f = fixture()
  const result = await f.record()
  assert.equal(result.key.returnedAt, clock.toISOString())
  assert.equal(result.key.returnedSessionIndex, 2)
  const stored = f.db.state.orders[0].orderHomeSecurity.key
  assert.equal(stored.returnRecords.length, 2)
  assert.equal(stored.returnRecords[0].returnedAt, previousKey.returnedAt)
  assert.deepEqual(stored.returnRecords[0].returnImageFileIds, ['cloud://day1'])
  assert.deepEqual(f.db.state.order_home_security[0].key, stored)
  const proof = await f.execution.evaluateCheckinCompletion(f.db.state.orders[0], f.c.toTimeValue(startedAt))
  assert.equal(proof.isComplete, true)
})

for (const status of ['assigned', 'on_the_way', 'day_completed', 'completed', 'cancelled', 'refunded']) {
  test(`key return cannot be registered while the order is ${status}`, async () => {
    const f = fixture({ status, orderHomeSecurity: { type: 'key',
      key: { ...previousKey, returnedAt: '', returnImageFileIds: [] } } })
    const before = structuredClone(f.db.state)
    await assert.rejects(f.record(), /服务中|状态|场次/)
    assert.deepEqual(f.db.state.orders, before.orders)
    assert.deepEqual(f.db.state.order_home_security, before.order_home_security)
  })
}

test('multi-day key return rejects a request without visit scope', async () => {
  const f = fixture()
  await assert.rejects(f.record({ sessionIndex: undefined, sessionStartedAt: undefined }), /场次|刷新/)
  assert.equal(f.db.state.orders[0].orderHomeSecurity.key.returnedAt, previousKey.returnedAt)
})

test('old offline key evidence is not attributed to the next visit', async () => {
  const f = fixture()
  await assert.rejects(f.record({ sessionIndex: 1, sessionStartedAt: '2026-11-10 00:00', imageFileIds: ['cloud://old-unqueued'] }), /场次|刷新|不可重复覆盖/)
  assert.equal(f.db.state.orders[0].orderHomeSecurity.key.returnedAt, previousKey.returnedAt)
})

test('two different concurrent key photos cannot overwrite each other', async () => {
  const f = fixture({ orderHomeSecurity: { type: 'key', key: { ...previousKey, returnedAt: '', returnImageFileIds: [] } } })
  const results = await Promise.allSettled([f.record(), f.record({ imageFileIds: ['cloud://other'] })])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected').length, 1)
  assert.equal(f.db.state.orders[0].orderHomeSecurity.key.returnRecords.length, 1)
  assert.deepEqual(f.db.state.orders[0].orderHomeSecurity.key, f.db.state.order_home_security[0].key)
})

test('concurrent identical key submissions create one receipt and remain idempotent after completion', async () => {
  const f = fixture()
  const results = await Promise.all([f.record(), f.record({ sessionStartedAt: '2026-11-10T16:00:00Z' })])
  assert.ok(results.every(result => result.key.returnedAt === clock.toISOString()))
  f.db.state.orders[0] = { ...f.db.state.orders[0], status: 'completed', activeSessionIndex: 0, currentSessionStartedAt: '' }
  await f.record()
  assert.equal(f.db.state.orders[0].orderHomeSecurity.key.returnRecords.length, 2)
})

for (const change of [
  { status: 'cancelled' }, { staffOpenid: 'other' }, { currentSessionStartedAt: '2026-11-11 00:15' }
]) {
  test(`key receipt rechecks the latest order after photo validation: ${JSON.stringify(change)}`, async () => {
    const f = fixture({}, { checkImageSecurity: async () => {
      f.db.state.orders[0] = { ...f.db.state.orders[0], ...change }
    } })
    await assert.rejects(f.record(), /服务中|状态|场次|员工|刷新/)
    assert.equal(f.db.state.orders[0].orderHomeSecurity.key.returnedAt, previousKey.returnedAt)
    assert.equal(f.db.state.order_home_security[0].key.returnedAt, previousKey.returnedAt)
  })
}

test('key receipt and home security mirror roll back together on a write failure', async () => {
  const f = fixture({ orderHomeSecurity: { type: 'key', key: { ...previousKey, returnedAt: '', returnImageFileIds: [] } } })
  const run = f.db.runTransaction
  f.db.runTransaction = callback => run(tx => callback({ collection(name) {
    const collection = tx.collection(name)
    if (name !== 'order_home_security') return collection
    return { ...collection, doc(id) { return { ...collection.doc(id), update: async () => { throw new Error('mirror write failed') } } } }
  } }))
  await assert.rejects(f.record(), /mirror write failed/)
  assert.equal(f.db.state.orders[0].orderHomeSecurity.key.returnedAt, '')
  f.db.runTransaction = run
  await f.record()
  assert.equal(f.db.state.orders[0].orderHomeSecurity.key.returnedAt, clock.toISOString())
})

test('legacy Beijing receipt for the current visit remains valid while wrong visit metadata does not', async () => {
  const f = fixture({ orderHomeSecurity: { type: 'key', key: { ...previousKey, returnedAt: '2026-11-11 00:20' } } })
  assert.equal((await f.execution.evaluateCheckinCompletion(f.db.state.orders[0], f.c.toTimeValue(startedAt))).isComplete, true)
  f.db.state.orders[0].orderHomeSecurity.key.returnedSessionIndex = 1
  assert.equal((await f.execution.evaluateCheckinCompletion(f.db.state.orders[0], f.c.toTimeValue(startedAt))).isComplete, false)
})

for (const group of [false, true]) {
  test(`a multi-day ${group ? 'group household' : 'order'} cannot settle until the last visit key receipt is recorded`, async () => {
    const f = fixture(group ? { groupBuyId: 'group', groupBuyStatus: 'formed' } : {})
    if (group) f.db.state.pet_playground_groups = [{ _id: 'group', status: 'formed' }]
    await assert.rejects(f.orderHandler('staff', 'finishService', { id: 'order' }), /放回钥匙/)
    assert.equal(f.db.state.orders[0].status, 'in_service')
    assert.equal((f.db.state.point_logs || []).length, 0)
    assert.equal((f.db.state.staff_earnings || []).length, 0)
    await f.record()
    const result = await f.orderHandler('staff', 'finishService', { id: 'order' })
    assert.equal(result.status, 'completed')
    assert.equal(f.db.state.orders[0].status, 'completed')
    await f.orderHandler('staff', 'finishService', { id: 'order' })
    assert.equal(f.db.state.point_logs.length, 1)
    assert.equal(f.db.state.staff_earnings.length, 1)
  })
}

test('an already recorded offline return for yesterday is an idempotent read during the next visit', async () => {
  const f = fixture()
  const before = structuredClone(f.db.state.orders[0])
  const result = await f.record({ sessionIndex: 1, sessionStartedAt: '2026-11-10 00:00', imageFileIds: ['cloud://day1'] })
  assert.equal(result.key.returnedAt, '')
  assert.deepEqual(f.db.state.orders[0], before)
})

test('a key order with no key object cannot bypass required return evidence', async () => {
  const f = fixture({ orderHomeSecurity: { type: 'key' } })
  assert.equal((await f.execution.evaluateCheckinCompletion(f.db.state.orders[0], f.c.toTimeValue(startedAt))).isComplete, false)
})

test('legacy visits without explicit indexes still bind key evidence to their array position', async () => {
  const f = fixture()
  f.db.state.orders[0].activeSessionIndex = 0
  f.db.state.orders[0].serviceSessions = f.db.state.orders[0].serviceSessions.map(({ index, ...session }) => session)
  const receipt = await f.record()
  assert.equal(receipt.key.returnedSessionIndex, 2)
  assert.equal((await f.execution.evaluateCheckinCompletion(f.db.state.orders[0], f.c.toTimeValue(startedAt))).isComplete, true)
})
