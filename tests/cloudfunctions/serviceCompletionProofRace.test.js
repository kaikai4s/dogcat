const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const optimistic = require('./optimisticTransactions')
const createContext = require('../../cloudfunctions/api/services/context')
const createExecution = require('../../cloudfunctions/api/services/serviceExecution')
const createCheckin = require('../../cloudfunctions/api/handlers/checkin')

const time = new Date('2026-11-10T16:35:00Z')
function fixture(patch = {}, overrides = {}) {
  const db = createCollectionStore({
    users: [{ _id: 'staff', openid: 'staff', roles: ['staff'], status: 'active' },
      { _id: 'client', openid: 'client', roles: ['client'], status: 'active', completedOrderCount: 0, points: 0 }],
    orders: [{ _id: 'order', clientOpenid: 'client', clientUserId: 'client', staffOpenid: 'staff', staffUserId: 'staff',
      status: 'in_service', paymentStatus: 'paid', payAmount: 100, activeSessionIndex: 1,
      currentSessionStartedAt: '2026-11-11 00:00', startedAt: '2026-11-11 00:00',
      startTime: '2026-11-11 00:00', endTime: '2026-11-11 00:30',
      requiredCheckins: ['feed'], serviceSessions: [{ index: 1, startTime: '2026-11-11 00:00', endTime: '2026-11-11 00:30',
        status: 'in_service', startedAt: '2026-11-11 00:00' }], ...patch }],
    checkin_logs: [{ _id: 'proof', orderId: 'order', staffOpenid: 'staff', eventType: 'feed', mediaFileId: 'cloud://proof', recordedAt: '2026-11-11 00:10' }]
  })
  optimistic(db)
  const c = { ...createContext({ db, cloud: {} }), now: () => time, checkImageSecurity: async () => {}, ...overrides }
  const execution = createExecution(c)
  const checkin = createCheckin({ ...c, ...execution })
  const remove = () => checkin('staff', 'deleteCheckin', { orderId: 'order', checkinId: 'proof' })
  const upload = (data = {}) => checkin('staff', 'createCheckin', { orderId: 'order', eventType: 'feed', mediaFileId: 'cloud://new',
    latitude: 31.2, longitude: 121.5, recordedAt: time, clientRequestId: 'request', ...data })
  return { db, c, execution, checkin, remove, upload }
}

for (const mode of ['final', 'daily', 'automatic']) {
  test(`deleting proof after its validation prevents ${mode} completion from settling a stale snapshot`, async () => {
    const f = fixture()
    if (mode === 'daily') f.db.state.orders[0].serviceSessions.push({ index: 2, startTime: '2026-11-12 00:00', endTime: '2026-11-12 00:30', status: 'pending' })
    const snapshot = structuredClone(f.db.state.orders[0])
    assert.equal((await f.execution.evaluateCheckinCompletion(snapshot, f.c.toTimeValue(snapshot.currentSessionStartedAt))).isComplete, true)
    await f.remove()
    await assert.rejects(f.execution.completeOrderService(snapshot, snapshot.serviceSessions[0], time, { isAuto: mode === 'automatic' }), /打卡|凭证|变化/)
    assert.equal(f.db.state.orders[0].status, 'in_service')
    assert.equal((f.db.state.staff_earnings || []).length, 0)
    assert.equal((f.db.state.point_logs || []).length, 0)
  })
}

test('a same-index service restarted after validation cannot be completed with its previous snapshot', async () => {
  const f = fixture()
  const snapshot = structuredClone(f.db.state.orders[0])
  f.db.state.orders[0] = { ...snapshot, currentSessionStartedAt: '2026-11-11 00:20',
    serviceSessions: [{ ...snapshot.serviceSessions[0], startedAt: '2026-11-11 00:20' }] }
  await assert.rejects(f.execution.completeOrderService(snapshot, snapshot.serviceSessions[0], time), /场次|变化/)
  assert.equal(f.db.state.orders[0].status, 'in_service')
})

for (const status of ['completed', 'day_completed', 'cancelled']) {
  test(`deletion rechecks ${status} committed after the authorization snapshot`, async () => {
    const f = fixture()
    const handler = createCheckin({ ...f.c, requireStaffOrder: async (...args) => {
      const access = structuredClone(await f.c.requireStaffOrder(...args))
      f.db.state.orders[0] = { ...f.db.state.orders[0], status }
      return access
    } })
    await assert.rejects(handler('staff', 'deleteCheckin', { orderId: 'order', checkinId: 'proof' }), /状态|服务中|变化/)
    assert.equal(f.db.state.checkin_logs[0].deletedAt, undefined)
  })
}

function failOrderUpdates(db) {
  const run = db.runTransaction.bind(db)
  db.runTransaction = callback => run(tx => callback({ collection(name) {
    const collection = tx.collection(name)
    if (name !== 'orders') return collection
    return { ...collection, doc(id) {
      const doc = collection.doc(id)
      return { ...doc, update: async () => { throw new Error('revision unavailable') } }
    } }
  } }))
  const collection = db.collection.bind(db)
  db.collection = name => {
    const original = collection(name)
    if (name !== 'orders') return original
    return { ...original, doc(id) { return { ...original.doc(id), update: async () => { throw new Error('revision unavailable') } } } }
  }
}

for (const operation of ['delete', 'create']) {
  test(`${operation} and its order revision roll back together when revision storage fails`, async () => {
    const f = fixture()
    failOrderUpdates(f.db)
    await assert.rejects(operation === 'delete' ? f.remove() : f.upload(), /revision unavailable/)
    assert.equal(f.db.state.checkin_logs.length, 1)
    assert.equal(f.db.state.checkin_logs[0].deletedAt, undefined)
  })
}

test('the next day cannot delete the previous visit evidence', async () => {
  const f = fixture({ activeSessionIndex: 2, currentSessionStartedAt: '2026-11-11 00:20',
    serviceSessions: [{ index: 1, status: 'completed', startedAt: '2026-11-10 23:00' },
      { index: 2, status: 'in_service', startedAt: '2026-11-11 00:20' }] })
  await assert.rejects(f.remove(), /本次|场次/)
  assert.equal(f.db.state.checkin_logs[0].deletedAt, undefined)
})

test('photo moderation completing after order completion never writes a new checkin', async () => {
  let f
  f = fixture({}, { checkImageSecurity: async () => { f.db.state.orders[0] = { ...f.db.state.orders[0], status: 'completed' } } })
  await assert.rejects(f.upload(), /状态|服务中|变化/)
  assert.equal(f.db.state.checkin_logs.length, 1)
})

test('simultaneous uploads with the same client request create one photo and one revision', async () => {
  const f = fixture()
  const rows = await Promise.all([f.upload(), f.upload()])
  assert.equal(rows[0]._id, rows[1]._id)
  assert.equal(f.db.state.checkin_logs.length, 2)
  assert.equal(f.db.state.orders[0].checkinRevision, 1)
})

for (const recordedAt of ['2026-11-10 00:10', '2026-11-12 00:10', 'invalid']) {
  test(`checkin timestamp ${recordedAt} cannot be attributed to the current visit`, async () => {
    const f = fixture()
    await assert.rejects(f.upload({ recordedAt, isBackfilled: true }), /时间|场次|本次/)
    assert.equal(f.db.state.checkin_logs.length, 1)
  })
}

test('a photo explicitly belonging to a different visit cannot satisfy required checkins', async () => {
  const f = fixture()
  f.db.state.checkin_logs[0].serviceSessionIndex = 2
  f.db.state.checkin_logs[0].serviceSessionStartedAt = '2026-11-11 00:20'
  assert.equal((await f.execution.evaluateCheckinCompletion(f.db.state.orders[0], f.c.toTimeValue('2026-11-11 00:00'))).isComplete, false)
})

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('group completion retries its proof validation when a deletion commits during the check', async () => {
  const f = fixture({ groupBuyId: 'group', groupBuyStatus: 'formed' })
  f.db.state.orders.push({ ...structuredClone(f.db.state.orders[0]), _id: 'other', status: 'assigned' })
  f.db.state.pet_playground_groups = [{ _id: 'group', status: 'formed' }]
  const read = deferred(), resume = deferred()
  let first = true
  const execution = createExecution({ ...f.c, readScopedDocuments: async (...args) => {
    const rows = structuredClone(await f.c.readScopedDocuments(...args))
    if (first && args[0] === 'checkin_logs') { first = false; read.resolve(); await resume.promise }
    return rows
  } })
  const snapshot = structuredClone(f.db.state.orders[0])
  const finishing = execution.completeOrderService(snapshot, snapshot.serviceSessions[0], time)
  const rejected = assert.rejects(finishing, /缺少必打卡/)
  await read.promise
  await f.remove()
  resume.resolve()
  await rejected
  assert.equal(f.db.state.orders[0].status, 'in_service')
  assert.equal((f.db.state.staff_earnings || []).length, 0)
})

test('repeated concurrent deletion keeps one revision and the same deletion receipt', async () => {
  const f = fixture()
  const results = await Promise.all([f.remove(), f.remove()])
  assert.equal(results[0].deletedAt.toISOString(), results[1].deletedAt.toISOString())
  assert.equal(f.db.state.orders[0].checkinRevision, 1)
})

test('a photo belonging to a previous staff member cannot be deleted or count for the current staff', async () => {
  const f = fixture()
  f.db.state.checkin_logs[0].staffOpenid = 'previous-staff'
  assert.equal((await f.execution.evaluateCheckinCompletion(f.db.state.orders[0], f.c.toTimeValue('2026-11-11 00:00'))).isComplete, false)
  await assert.rejects(f.remove(), /本次服务场次/)
})

test('moderation returning after reassignment or a different visit cannot write to that visit', async () => {
  for (const patch of [{ staffOpenid: 'another-staff' }, { activeSessionIndex: 2 }, { currentSessionStartedAt: '2026-11-11 00:20' }]) {
    let f
    f = fixture({}, { checkImageSecurity: async () => { f.db.state.orders[0] = { ...f.db.state.orders[0], ...patch } } })
    await assert.rejects(f.upload(), /归属|场次|变化/)
    assert.equal(f.db.state.checkin_logs.length, 1)
  }
})

for (const recordedAt of ['2026-11-11 00:35', '2026-11-10T16:35:00Z', time.getTime()]) {
  test(`Beijing checkin time ${recordedAt} is persisted with the current actual visit and completes normally`, async () => {
    const f = fixture()
    const photo = await f.upload({ recordedAt })
    assert.equal(photo.canDelete, true)
    assert.equal(photo.serviceSessionIndex, 1)
    assert.equal(f.c.toTimeValue(photo.serviceSessionStartedAt), f.c.toTimeValue('2026-11-11 00:00'))
    assert.equal(f.c.toTimeValue(photo.recordedAt), time.getTime())
    const order = structuredClone(f.db.state.orders[0])
    await f.execution.completeOrderService(order, order.serviceSessions[0], time)
    assert.equal(f.db.state.orders[0].status, 'completed')
    assert.equal(f.db.state.staff_earnings[0].amount, 70)
  })
}

test('multi-day offline checkin without an original timestamp is not silently attributed to a later visit', async () => {
  const f = fixture()
  f.db.state.orders[0].serviceSessions.push({ index: 2, status: 'pending' })
  await assert.rejects(f.upload({ recordedAt: undefined, isBackfilled: true }), /缺少本次服务打卡时间/)
  assert.equal(f.db.state.checkin_logs.length, 1)
})

test('photo list keeps historical proof but only exposes delete controls for the current visit', async () => {
  const f = fixture()
  f.db.state.checkin_logs.push({ ...f.db.state.checkin_logs[0], _id: 'old', serviceSessionIndex: 2 },
    { ...f.db.state.checkin_logs[0], _id: 'sanitization', eventType: 'sanitization' })
  const rows = await f.checkin('staff', 'listOrderCheckins', { orderId: 'order' })
  assert.equal(rows.find(row => row._id === 'proof').canDelete, true)
  assert.equal(rows.find(row => row._id === 'old').canDelete, false)
  assert.equal(rows.find(row => row._id === 'sanitization').canDelete, false)
  const clientRows = await f.checkin('client', 'listOrderCheckins', { orderId: 'order' })
  assert.ok(clientRows.every(row => !row.canDelete))
})

test('order detail uses the same visit attribution as backend completion checks', async () => {
  const f = fixture()
  f.db.state.checkin_logs[0].serviceSessionIndex = 2
  const orderHandler = require('../../cloudfunctions/api/handlers/order')({ ...f.c, ...f.execution })
  const order = await orderHandler('staff', 'getOrderDetail', { id: 'order' })
  assert.equal(order.checkinRequirements.find(item => item.eventType === 'feed').completed, false)
})

for (const code of ['SERVICE_PROOF_CHANGED', 'SERVICE_VISIT_CHANGED']) {
  test(`automatic completion skips ${code} and still settles later orders`, async () => {
    const f = fixture()
    f.db.state.orders.push({ ...structuredClone(f.db.state.orders[0]), _id: 'other' })
    f.db.state.checkin_logs.push({ ...f.db.state.checkin_logs[0], _id: 'other-proof', orderId: 'other' })
    const overdue = require('../../cloudfunctions/api/services/overdueOrders')({ ...f.c, ...f.execution,
      completeOrderService: async (order, ...args) => {
        if (order._id === 'order') throw Object.assign(new Error('proof changed while checking'), { code })
        return f.execution.completeOrderService(order, ...args)
      }
    })
    const results = await overdue.processOverdueUnfinishedOrders(new Date('2026-11-10T17:05:00Z'))
    assert.equal(f.db.state.orders[0].status, 'in_service')
    assert.equal(f.db.state.orders[1].status, 'completed')
    assert.equal(results.length, 1)
    assert.equal(results[0].orderId, 'other')
    assert.equal(f.db.state.staff_earnings.length, 1)
  })
}
