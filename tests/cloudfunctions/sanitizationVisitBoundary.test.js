const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const optimistic = require('./optimisticTransactions')
const createContext = require('../../cloudfunctions/api/services/context')
const createRules = require('../../cloudfunctions/api/services/checkinRules')
const createOrder = require('../../cloudfunctions/api/handlers/order')
const createCheckin = require('../../cloudfunctions/api/handlers/checkin')
const createExecution = require('../../cloudfunctions/api/services/serviceExecution')

function fixture(patch = {}) {
  let clock = new Date('2026-11-10T17:00:00Z') // 北京时间 11 日 01:00
  const db = createCollectionStore({
    users: [{ _id: 'staff', openid: 'staff', roles: ['staff'], status: 'active' },
      { _id: 'client', openid: 'client', roles: ['client'], status: 'active' }],
    orders: [{ _id: 'order', staffOpenid: 'staff', staffUserId: 'staff', clientOpenid: 'client',
      status: 'day_completed', paymentStatus: 'paid', payAmount: 100, requiredCheckins: ['sanitization'],
      startTime: '2026-11-10 23:00', endTime: '2026-11-10 23:30', startedAt: '2026-11-11 00:10',
      lastCompletedSessionIndex: 1, currentSessionStartedAt: '', activeSessionIndex: 0,
      serviceSessions: [
        { index: 1, startTime: '2026-11-10 23:00', endTime: '2026-11-10 23:30', status: 'completed', startedAt: '2026-11-11 00:10', finishedAt: '2026-11-11 00:40' },
        { index: 2, startTime: '2026-11-11 00:45', endTime: '2026-11-11 01:15', status: 'pending' }
      ], ...patch }],
    checkin_logs: [{ _id: 'old', orderId: 'order', staffOpenid: 'staff', eventType: 'sanitization',
      mediaFileId: 'cloud://old.jpg', serverTime: '2026-11-11 00:05', recordedAt: '2026-11-11 00:05',
      latitude: 31.2, longitude: 121.5, preStart: true, sanitizationVersion: 1 }]
  })
  optimistic(db)
  const cloud = { downloadFile: async () => ({ fileContent: Buffer.from([0xff, 0xd8, 0xff, ...Array(20).fill(0)]) }) }
  const c = { ...createContext({ db, cloud }), now: () => clock, checkImageSecurity: async () => {},
    appendOrderTimeline: async () => {}, appendOrderClientMessage: async () => {}, notifyOrder: async () => {} }
  Object.assign(c, createRules(c))
  Object.assign(c, createExecution(c))
  const handler = createOrder(c)
  return { db, c, cloud, handler, setTime: value => { clock = new Date(c.toTimeValue(value)) },
    start: () => handler('staff', 'startService', { id: 'order', currentLatitude: 31.2, currentLongitude: 121.5 }),
    detail: () => handler('staff', 'getOrderDetail', { id: 'order' }),
    upload: (data = {}) => createCheckin(c)('staff', 'createCheckin', { orderId: 'order', eventType: 'sanitization',
      mediaFileId: 'cloud://fresh.jpg', latitude: 31.2, longitude: 121.5, clientRequestId: 'fresh', ...data }) }
}

function addFresh(f, patch = {}) {
  const photo = { ...f.db.state.checkin_logs[0], _id: 'fresh', mediaFileId: 'cloud://fresh.jpg',
    serverTime: '2026-11-11 00:50', recordedAt: '2026-11-11 00:50', ...patch }
  f.db.state.checkin_logs.push(photo)
  return photo
}

test('two delayed visits on the same Beijing day cannot reuse the earlier sanitization', async () => {
  const f = fixture()
  await assert.rejects(f.start(), /消毒/)
  assert.equal(f.db.state.orders[0].status, 'day_completed')
})

test('next-visit readiness does not accept the earlier sanitization on the same day', async () => {
  const f = fixture()
  const ready = await f.handler('staff', 'checkStartServiceReadiness', { id: 'order', currentLatitude: 31.2, currentLongitude: 121.5 })
  assert.equal(ready.canStart, false)
  assert.ok(ready.issues.some(issue => issue.type === 'missing_sanitization'))
})

test('new sanitization is attributed to the pending visit and shows complete before it starts', async () => {
  const f = fixture()
  const photo = await f.upload()
  assert.equal(photo.serviceSessionIndex, 2)
  assert.equal(f.c.toTimeValue(photo.serviceSessionScheduledAt), f.c.toTimeValue('2026-11-11 00:45'))
  const req = (await f.detail()).checkinRequirements.find(item => item.eventType === 'sanitization')
  assert.equal(req.completed, true)
  assert.equal(req.photoCount, 1)
  assert.equal(req.photos[0]._id, photo._id)
  assert.equal((await f.start()).status, 'in_service')
})

for (const patch of [{ serviceSessionIndex: 1 }, { serviceSessionIndex: 2, serviceSessionScheduledAt: '2026-11-11 00:44' }]) {
  test(`explicit incompatible visit metadata cannot satisfy sanitization: ${JSON.stringify(patch)}`, async () => {
    const f = fixture()
    addFresh(f, patch)
    await assert.rejects(f.start(), /消毒/)
  })
}

test('a legacy photo after the previous finish remains usable for the next visit', async () => {
  const f = fixture()
  addFresh(f)
  assert.equal((await f.start()).status, 'in_service')
})

test('ambiguous legacy photos cannot advance a later visit with no previous finish time', async () => {
  const f = fixture()
  delete f.db.state.orders[0].serviceSessions[0].finishedAt
  await assert.rejects(f.start(), /消毒/)
})

test('ordinary and group completion reject sanitization belonging to a previous same-day visit', async () => {
  for (const group of [false, true]) {
    const f = fixture()
    const order = f.db.state.orders[0]
    Object.assign(order, { status: 'in_service', activeSessionIndex: 2, currentSessionStartedAt: '2026-11-11 00:55' })
    Object.assign(order.serviceSessions[1], { status: 'in_service', startedAt: '2026-11-11 00:55' })
    if (group) {
      Object.assign(order, { groupBuyId: 'group', groupBuyStatus: 'formed' })
      f.db.state.pet_playground_groups = [{ _id: 'group', status: 'formed' }]
      await assert.rejects(f.c.completeOrderService(structuredClone(order), order.serviceSessions[1]), /缺少必打卡/)
    } else {
      const result = await f.c.evaluateCheckinCompletion(order, f.c.toTimeValue(order.currentSessionStartedAt))
      assert.equal(result.isComplete, false)
    }
    assert.equal(order.status, 'in_service')
    assert.equal((f.db.state.staff_earnings || []).length, 0)
  }
})

test('a completed multi-day order displays the final visit sanitization against its own start', async () => {
  const f = fixture()
  const order = f.db.state.orders[0]
  Object.assign(order, { status: 'completed', lastCompletedSessionIndex: 2 })
  Object.assign(order.serviceSessions[1], { status: 'completed', startedAt: '2026-11-11 00:55', finishedAt: '2026-11-11 01:30' })
  addFresh(f, { serviceSessionIndex: 2, serviceSessionScheduledAt: order.serviceSessions[1].startTime })
  const req = (await f.detail()).checkinRequirements.find(item => item.eventType === 'sanitization')
  assert.equal(req.photoCount, 1)
  assert.equal(req.photos[0]._id, 'fresh')
})

for (const change of ['deleted', 'file', 'previous_finish']) {
  test(`start transaction rejects sanitization changed after validation: ${change}`, async () => {
    const f = fixture()
    addFresh(f)
    const run = f.db.runTransaction
    f.db.runTransaction = callback => {
      if (change === 'deleted') f.db.state.checkin_logs = f.db.state.checkin_logs.map(row => row._id === 'fresh' ? { ...row, deletedAt: f.c.now() } : row)
      if (change === 'file') f.db.state.checkin_logs = f.db.state.checkin_logs.map(row => row._id === 'fresh' ? { ...row, mediaFileId: 'cloud://unvalidated.jpg' } : row)
      if (change === 'previous_finish') f.db.state.orders[0].serviceSessions[0].finishedAt = '2026-11-11 00:51'
      return run(callback)
    }
    await assert.rejects(f.start(), /消毒|变化/)
    assert.equal(f.db.state.orders[0].status, 'day_completed')
  })
}

for (const time of ['2026-11-11 00:50', '2026-11-10T16:50:00Z', 1794329400000]) {
  test(`equivalent Beijing timestamps attribute fresh legacy sanitization consistently: ${time}`, async () => {
    const f = fixture()
    addFresh(f, { serverTime: time })
    assert.equal((await f.start()).status, 'in_service')
  })
}

test('sanitization from the preceding Beijing date is not reusable after midnight', async () => {
  const f = fixture()
  addFresh(f, { serverTime: '2026-11-10 23:59:59' })
  f.db.state.checkin_logs = f.db.state.checkin_logs.filter(row => row._id === 'fresh')
  await assert.rejects(f.start(), /消毒/)
})

test('next-visit detail keeps old sanitization in history without marking it complete', async () => {
  const f = fixture()
  const requirement = (await f.detail()).checkinRequirements.find(item => item.eventType === 'sanitization')
  assert.equal(requirement.completed, false)
  assert.equal(requirement.photoCount, 0)
  const history = await createCheckin(f.c)('staff', 'listOrderCheckins', { orderId: 'order' })
  assert.equal(history.length, 1)
  assert.equal(history[0]._id, 'old')
})

test('fresh explicitly scoped evidence works when an earlier legacy finish time is missing', async () => {
  const f = fixture()
  delete f.db.state.orders[0].serviceSessions[0].finishedAt
  const photo = await f.upload()
  assert.equal(photo.serviceSessionIndex, 2)
  assert.equal((await f.start()).status, 'in_service')
})

test('equivalent scheduled timestamps do not invalidate visit-scoped evidence', async () => {
  const f = fixture()
  addFresh(f, { serviceSessionIndex: 2, serviceSessionScheduledAt: '2026-11-10T16:45:00Z' })
  assert.equal((await f.start()).status, 'in_service')
})

test('a stale sanitization request ID cannot reuse the previous visit receipt', async () => {
  const f = fixture()
  f.db.state.checkin_logs[0].clientRequestId = 'old-request'
  await assert.rejects(f.upload({ clientRequestId: 'old-request', mediaFileId: 'cloud://old.jpg' }), /消毒.*失效/)
  assert.equal(f.db.state.checkin_logs.length, 1)
})

test('completion after Beijing midnight retains valid evidence from the actual start date', async () => {
  const f = fixture()
  const order = f.db.state.orders[0]
  Object.assign(order, { status: 'in_service', activeSessionIndex: 2, currentSessionStartedAt: '2026-11-11 23:55' })
  Object.assign(order.serviceSessions[1], { status: 'in_service', startedAt: '2026-11-11 23:55' })
  addFresh(f, { serverTime: '2026-11-11 23:50', serviceSessionIndex: 2, serviceSessionScheduledAt: order.serviceSessions[1].startTime })
  f.setTime('2026-11-12 00:10')
  assert.equal((await f.c.evaluateCheckinCompletion(order, f.c.toTimeValue(order.currentSessionStartedAt))).isComplete, true)
  assert.equal((await f.detail()).checkinRequirements.find(item => item.eventType === 'sanitization').completed, true)
})

test('group completion cannot settle a final visit using an earlier same-day sanitization', async () => {
  const f = fixture({ groupBuyId: 'group', groupBuyStatus: 'formed' })
  const order = f.db.state.orders[0]
  Object.assign(order, { status: 'in_service', activeSessionIndex: 2, currentSessionStartedAt: '2026-11-11 00:55' })
  Object.assign(order.serviceSessions[1], { status: 'in_service', startedAt: '2026-11-11 00:55' })
  f.db.state.pet_playground_groups = [{ _id: 'group', status: 'formed' }]
  await assert.rejects(f.c.completeOrderService(structuredClone(order), order.serviceSessions[1]), /缺少必打卡/)
  assert.equal(f.db.state.orders[0].status, 'in_service')
  assert.equal((f.db.state.staff_earnings || []).length, 0)
})

test('two delayed visits each use their own sanitization and settle the order once', async () => {
  const f = fixture({ status: 'assigned', lastCompletedSessionIndex: 0, startedAt: '' })
  Object.assign(f.db.state.orders[0].serviceSessions[0], { status: 'pending', startedAt: '', finishedAt: '' })
  f.db.state.checkin_logs = []
  await f.upload({ mediaFileId: 'cloud://first.jpg', clientRequestId: 'first' })
  await f.start()
  f.setTime('2026-11-11 01:30')
  let order = structuredClone(f.db.state.orders[0])
  assert.equal((await f.c.evaluateCheckinCompletion(order, f.c.toTimeValue(order.currentSessionStartedAt))).isComplete, true)
  assert.equal((await f.c.completeOrderService(order, order.serviceSessions[0])).status, 'day_completed')
  assert.equal((f.db.state.staff_earnings || []).length, 0)
  f.setTime('2026-11-11 01:31')
  await assert.rejects(f.start(), /消毒/)
  await f.upload()
  await f.start()
  f.setTime('2026-11-11 02:01')
  order = structuredClone(f.db.state.orders[0])
  assert.equal((await f.c.evaluateCheckinCompletion(order, f.c.toTimeValue(order.currentSessionStartedAt))).isComplete, true)
  assert.equal((await f.c.completeOrderService(order, order.serviceSessions[1])).status, 'completed')
  assert.equal(f.db.state.staff_earnings.length, 1)
  assert.equal(f.db.state.staff_earnings[0].amount, 70)
  await f.c.completeOrderService(order, order.serviceSessions[1])
  assert.equal(f.db.state.staff_earnings.length, 1)
  assert.equal(f.db.state.users.find(user => user.openid === 'client').completedOrderCount, 1)
})
