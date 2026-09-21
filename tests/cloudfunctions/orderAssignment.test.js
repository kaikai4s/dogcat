const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')

const date = '2099-09-30'
function order(id, start = '10:00', end = '11:00') {
  return { _id: id, status: 'paid', paymentStatus: 'paid', staffOpenid: '', startTime: `${date} ${start}`, endTime: `${date} ${end}` }
}
function setup(orders = [order('a'), order('b')]) {
  const db = createCollectionStore({
    users: [
      { _id: 'user', openid: 'staff', status: 'active', roles: ['staff'] },
      { _id: 'user2', openid: 'staff2', status: 'active', roles: ['staff'] },
      { _id: 'admin', openid: 'admin', status: 'active', roles: ['admin'] }
    ],
    staff_profiles: [
      { _id: 'profile', openid: 'staff', auditStatus: 'approved', staffLevel: 'certified' },
      { _id: 'profile2', openid: 'staff2', auditStatus: 'approved', staffLevel: 'certified' }
    ],
    orders, order_timeline: [], platform_configs: []
  })
  const context = createContext({ db, cloud: {} })
  function assign(id, staff = 'staff', options = {}) {
    const expected = structuredClone(db.state.orders.find(o => o._id === id))
    const suffix = staff === 'staff' ? '' : '2'
    return context.assignOrderAtomically(id, expected, {
      staffUserId: `user${suffix}`, staffOpenid: staff, staffProfileId: `profile${suffix}`, status: 'assigned'
    }, options)
  }
  return { db, context, assign }
}

// Unlike the shared serialized fake, this permits overlapping snapshots and retries on read/write conflicts.
function useOptimisticTransactions(db) {
  let retries = 0
  db.runTransaction = async callback => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const snapshot = createCollectionStore(structuredClone(db.state))
      const reads = new Map()
      const writes = []
      const result = await callback({ collection(name) {
        return { doc(id) {
          return {
            async get() {
              const item = snapshot.state[name]?.find(row => row._id === id)
              reads.set(`${name}/${id}`, { name, id, value: JSON.stringify(item) })
              return { data: structuredClone(item) }
            },
            async update({ data }) { writes.push({ name, id, data }); return { stats: { updated: 1 } } }
          }
        } }
      } })
      const conflicted = [...reads.values()].some(({ name, id, value }) => JSON.stringify(db.state[name]?.find(row => row._id === id)) !== value)
      if (conflicted) { retries++; continue }
      for (const { name, id, data } of writes) Object.assign(db.state[name].find(row => row._id === id), data)
      return result
    }
    throw new Error('transaction retries exhausted')
  }
  return () => retries
}

test('two overlapping orders for one staff conflict even with parallel transaction snapshots', async () => {
  const { db, assign } = setup()
  const retries = useOptimisticTransactions(db)
  const results = await Promise.allSettled([assign('a'), assign('b', 'staff', { admin: true })])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.match(results.find(r => r.status === 'rejected').reason.message, /该时间段已有订单/)
  assert.ok(retries() > 0)
  assert.equal(db.state.orders.filter(o => o.status === 'assigned').length, 1)
})

test('two staff competing for one order can only assign it once', async () => {
  const { db, assign } = setup([order('a')])
  useOptimisticTransactions(db)
  const results = await Promise.allSettled([assign('a'), assign('a', 'staff2')])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(db.state.orders[0].status, 'assigned')
})

test('adjacent non-overlapping orders can both be assigned', async () => {
  const { db, assign } = setup([order('a'), order('b', '11:00', '12:00')])
  useOptimisticTransactions(db)
  await Promise.all([assign('a'), assign('b')])
  assert.ok(db.state.orders.every(o => o.status === 'assigned'))
})

test('conflict after 100 active orders is detected while completed history is excluded', async () => {
  const history = Array.from({ length: 120 }, (_, i) => ({ ...order(`history${i}`), status: 'completed', staffOpenid: 'staff' }))
  const active = Array.from({ length: 105 }, (_, i) => ({ ...order(`active${String(i).padStart(3, '0')}`, '08:00', '09:00'), status: 'assigned', staffOpenid: 'staff' }))
  const conflict = { ...order('zzz'), status: 'day_completed', staffOpenid: 'staff' }
  const { db, context } = setup([...history, ...active, conflict])
  const rawCollection = db.collection
  db.collection = name => {
    const collection = rawCollection(name)
    if (name === 'orders') {
      const where = collection.where
      collection.where = condition => {
        assert.deepEqual(condition.status.$in, ['paid', 'assigned', 'in_service', 'day_completed'])
        return where.call(collection, condition)
      }
    }
    return collection
  }
  assert.equal((await context.findStaffOrderConflict('staff', order('candidate')))._id, 'zzz')
})

test('multi-day completed sessions do not block slots but remaining sessions do', async () => {
  const multi = { ...order('multi'), staffOpenid: 'staff', status: 'day_completed', serviceSessions: [
    { startTime: `${date} 08:00`, endTime: `${date} 09:00`, status: 'completed' },
    { startTime: `${date} 10:00`, endTime: `${date} 11:00`, status: 'pending' }
  ] }
  const { context } = setup([multi])
  assert.equal(await context.findStaffOrderConflict('staff', order('free', '08:00', '09:00')), null)
  assert.equal((await context.findStaffOrderConflict('staff', order('busy')))._id, 'multi')
  const calendar = await context.buildStaffAvailability({ openid: 'staff' }, date, 1)
  assert.equal(calendar[0].busyOrders.length, 1)
  assert.equal(calendar[0].busyOrders[0].startTime, `${date} 10:00`)
  assert.equal(calendar[0].dateKey, date)
  assert.equal(context.getDateKeyFromTime(`${date} 01:00`), date)
})

test('assignment rollback does not change staff revision or order on failed write', async () => {
  const { db, assign } = setup()
  const run = db.runTransaction
  db.runTransaction = callback => run(transaction => callback({ collection(name) {
    const collection = transaction.collection(name)
    if (name === 'orders') {
      const doc = collection.doc
      collection.doc = id => ({ ...doc(id), update: async () => { throw new Error('write failed') } })
    }
    return collection
  } }))
  await assert.rejects(assign('a'), /write failed/)
  assert.equal(db.state.orders[0].status, 'paid')
  assert.equal(db.state.users[0].staffAssignmentRevision, undefined)
})

test('transaction rejects changed order terms and revoked staff eligibility', async () => {
  for (const mutate of [db => { db.state.orders[0].startTime = `${date} 10:15` }, db => { db.state.staff_profiles[0].auditStatus = 'revoked' }]) {
    const { db, assign } = setup()
    const run = db.runTransaction
    db.runTransaction = callback => { mutate(db); return run(callback) }
    await assert.rejects(assign('a'))
    assert.equal(db.state.orders[0].status, 'paid')
  }
})

test('manual admin reactivation cannot bypass conflict checks', async () => {
  const { db } = setup([
    { ...order('a'), status: 'assigned', staffOpenid: 'staff' },
    { ...order('b'), status: 'cancelled', staffOpenid: 'staff' }
  ])
  const fn = loadCloudFunction('api', db, 'admin')
  const response = await fn.main({ module: 'admin', action: 'updateOrderStatus', data: { orderId: 'b', status: 'assigned', remark: 'restore' } })
  assert.equal(response.ok, false)
  assert.match(response.message, /该时间段已有订单/)
  assert.equal(db.state.orders[1].status, 'cancelled')
})

test('incomplete or invalid service times cannot be assigned', async () => {
  for (const patch of [{ endTime: '' }, { startTime: 'invalid' }, { endTime: `${date} 09:00` }]) {
    const { db, assign } = setup([{ ...order('a'), ...patch }])
    await assert.rejects(assign('a'), /服务时间不完整/)
    assert.equal(db.state.orders[0].status, 'paid')
  }
})

test('admin assignment checks every session of a multi-day order', async () => {
  const pending = { ...order('b'), startTime: '2099-09-29 10:00', endTime: '2099-09-29 11:00', serviceSessions: [
    { startTime: '2099-09-29 10:00', endTime: '2099-09-29 11:00', status: 'pending' },
    { startTime: `${date} 10:00`, endTime: `${date} 11:00`, status: 'pending' }
  ] }
  const { db } = setup([{ ...order('a'), status: 'assigned', staffOpenid: 'staff' }, pending])
  const fn = loadCloudFunction('api', db, 'admin')
  const response = await fn.main({ module: 'admin', action: 'assignOrder', data: { orderId: 'b', staffProfileId: 'profile' } })
  assert.equal(response.ok, false)
  assert.match(response.message, /该时间段已有订单/)
  assert.equal(db.state.orders[1].status, 'paid')
})
