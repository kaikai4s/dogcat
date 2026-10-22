const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const optimistic = require('./optimisticTransactions')

function fixture() {
  const now = new Date()
  const startTime = new Date(now.getTime() - 60000).toISOString()
  const endTime = new Date(now.getTime() + 3600000).toISOString()
  const sent = []
  const db = createCollectionStore({
    users: [{ _id: 'staff', openid: 'staff', roles: ['staff'], status: 'active' },
      { _id: 'client', openid: 'client', roles: ['client'], status: 'active' },
      { _id: 'admin', openid: 'admin', roles: ['admin'], status: 'active' }],
    platform_configs: [{ _id: 'config', key: 'system_settings', value: { subscription: { enabled: true,
      templates: { serviceStart: 'start-71479', serviceProgress: 'progress', staffDeparture: 'departure' } } } }],
    orders: [{ _id: 'order', orderNo: 'O202610110001', clientOpenid: 'client', staffOpenid: 'staff', status: 'assigned',
      serviceType: 'feed', checkinRequirements: [{ eventType: 'sanitization', required: true }], startTime, endTime, serviceSessions: [{ index: 1, startTime, endTime, status: 'pending' }] }],
    checkin_logs: [{ _id: 'photo', orderId: 'order', staffOpenid: 'staff', eventType: 'sanitization',
      sanitizationVersion: 1, preStart: true, latitude: 31.2, longitude: 121.5, mediaFileId: 'cloud://photo.jpg', serverTime: now }]
  })
  optimistic(db)
  const cloud = { openapi: { subscribeMessage: { send: async message => { sent.push(message) } } } }
  const api = loadCloudFunction('api', db, 'staff', cloud)
  return { db, sent, cloud, api, start: () => api.main({ module: 'order', action: 'startService', data: { id: 'order', currentLatitude: 31.2, currentLongitude: 121.5 } }) }
}

test('actual start sends template 71479 to client once per service session', async () => {
  const { db, sent, start } = fixture()
  const result = await start()
  assert.equal(result.ok, true, result.message)
  assert.deepEqual(sent[0], { touser: 'client', templateId: 'start-71479', page: 'pages/client/orders/detail/index?id=order', data: {
    character_string1: { value: 'O202610110001' }, thing2: { value: '服务已开始，毛孩子正被贴心照顾' }
  } })
  assert.equal((await start()).ok, true)
  assert.equal(sent.length, 1)
  const order = db.state.orders[0]
  order.status = 'day_completed'
  order.serviceSessions[0].status = 'completed'
  order.serviceSessions.push({ ...order.serviceSessions[0], index: 2, status: 'pending' })
  const second = await start()
  assert.equal(second.ok, true, second.message)
  assert.equal(sent.length, 2)
  assert.equal(db.state.subscription_logs.filter(row => row.delivery && row.templateKey === 'serviceStart').length, 2)
})

test('concurrent start requests create one delivery and one start timeline', async () => {
  const { db, sent, start } = fixture()
  const results = await Promise.all([start(), start()])
  assert.ok(results.some(row => row.ok))
  assert.equal(sent.length, 1)
  assert.equal(db.state.order_timeline.filter(row => row.type === 'started').length, 1)
})

for (const sameStaff of [true, false]) {
  test(`parallel starts for ${sameStaff ? 'one staff are mutually exclusive' : 'different staff both succeed'}`, async () => {
    const { db, api, start, sent, cloud } = fixture()
    const staffOpenid = sameStaff ? 'staff' : 'staff2'
    if (!sameStaff) db.state.users.push({ _id: 'staff2', openid: 'staff2', roles: ['staff'], status: 'active' })
    db.state.orders.push({ ...structuredClone(db.state.orders[0]), _id: 'other', orderNo: 'OTHER', staffOpenid })
    db.state.checkin_logs.push({ ...structuredClone(db.state.checkin_logs[0]), _id: 'other-photo', orderId: 'other', staffOpenid })
    const events = []
    const transaction = db.runTransaction
    db.runTransaction = callback => transaction(tx => callback({ collection(name) {
      const collection = tx.collection(name)
      if (name === 'users') {
        const doc = collection.doc
        collection.doc = id => {
          const ref = doc(id)
          return { ...ref,
            get: async () => { events.push(`read:${id}`); return ref.get() },
            update: async input => { events.push(`write:${id}`); assert.ok(input.data.staffAssignmentRevision); return ref.update(input) }
          }
        }
      }
      if (name === 'orders') {
        const where = collection.where
        collection.where = input => {
          if (input.status === 'in_service') events.push(`active:${input.staffOpenid}`)
          return where(input)
        }
      }
      return collection
    } }))
    const otherApi = sameStaff ? api : loadCloudFunction('api', db, 'staff2', cloud)
    const results = await Promise.all([start(), otherApi.main({ module: 'order', action: 'startService', data: { id: 'other', currentLatitude: 31.2, currentLongitude: 121.5 } })])
    assert.equal(results.filter(result => result.ok).length, sameStaff ? 1 : 2, JSON.stringify(results))
    assert.equal(db.state.orders.filter(row => row.status === 'in_service').length, sameStaff ? 1 : 2)
    assert.equal(sent.length, sameStaff ? 1 : 2)
    assert.equal(db.state.order_timeline.filter(row => row.type === 'started').length, sameStaff ? 1 : 2)
    if (sameStaff) assert.match(results.find(result => !result.ok).message, /已有订单正在服务中/)
    for (const id of sameStaff ? ['staff'] : ['staff', 'staff2']) {
      assert.ok(events.includes(`read:${id}`))
      assert.ok(events.includes(`write:${id}`))
      assert.ok(events.includes(`active:${id}`))
      assert.ok(db.state.users.find(row => row._id === id).staffAssignmentRevision)
    }
  })
}

test('active service query failure rolls back start and shared staff revision', async () => {
  const { db, start, sent } = fixture()
  const transaction = db.runTransaction
  db.runTransaction = callback => transaction(tx => callback({ collection(name) {
    const collection = tx.collection(name)
    if (name === 'orders') collection.where = () => { throw new Error('active query unavailable') }
    return collection
  } }))
  const result = await start()
  assert.equal(result.ok, false)
  assert.match(result.message, /active query unavailable/)
  assert.equal(db.state.orders[0].status, 'assigned')
  assert.equal(db.state.users[0].staffAssignmentRevision, undefined)
  assert.equal(sent.length, 0)
  assert.equal((db.state.subscription_logs || []).length, 0)
})

test('start preserves latest service session fields rather than overwriting a stale snapshot', async () => {
  const { db, start } = fixture()
  const transaction = db.runTransaction
  db.runTransaction = callback => {
    db.state.orders[0].serviceSessions[0].endTime = '2099-01-01T00:00:00Z'
    return transaction(callback)
  }
  const result = await start()
  assert.equal(result.ok, true, result.message)
  assert.equal(db.state.orders[0].serviceSessions[0].endTime, '2099-01-01T00:00:00Z')
})

test('failed sanitization validation never sends a started notification', async () => {
  const { db, sent, start } = fixture()
  db.state.checkin_logs = []
  assert.equal((await start()).ok, false)
  assert.equal(sent.length, 0)
  assert.equal((db.state.subscription_logs || []).length, 0)
})

test('departure proximity and early-start request use progress template, not started template', async () => {
  const { db, sent, api } = fixture()
  const order = db.state.orders[0]
  order.startTime = new Date(Date.now() + 3600000).toISOString()
  order.serviceSessions[0].startTime = order.startTime
  order.addressLatitude = 31.2
  order.addressLongitude = 121.5
  const departure = await api.main({ module: 'order', action: 'departForService', data: { id: 'order', latitude: 31.2, longitude: 121.5 } })
  assert.equal(departure.ok, true, departure.message)
  const early = await api.main({ module: 'order', action: 'requestEarlyStart', data: { id: 'order' } })
  assert.equal(early.ok, true, early.message)
  assert.ok(sent.some(row => row.templateId === 'progress'))
  assert.ok(!sent.some(row => row.templateId === 'start-71479'))
})

for (const statusText of ['服务中', '待确认提前开始', '服务已超时未开始']) {
  test('legacy queued start payload is safely handled: ' + statusText, async () => {
    const { db, sent, cloud } = fixture()
    const ctx = createContext({ db, cloud })
    await db.runTransaction(tx => ctx.enqueueSubscription(tx, { openid: 'client', templateKey: 'serviceStart',
      page: 'pages/client/orders/detail/index?id=order', messageData: { thing9: { value: '旧提示' },
        thing4: { value: statusText }, character_string5: { value: 'OLD001' }, thing10: { value: '喂猫' }, date3: { value: '2026-10-11' } }, orderId: 'order' }))
    await ctx.retryFailedSubscriptions()
    assert.equal(sent.length, statusText === '服务中' ? 1 : 0)
    if (sent.length) assert.deepEqual(Object.keys(sent[0].data).sort(), ['character_string1', 'thing2'])
    else assert.equal(db.state.subscription_logs.find(row => row.delivery).error, 'legacy_service_start_not_started')
  })
}

test('upcoming reminder cannot fall back to actual service start template', async () => {
  const { db, sent, cloud } = fixture()
  db.state.platform_configs[0].value.subscription.templates.serviceProgress = ''
  const ctx = createContext({ db, cloud })
  const result = await ctx.notifyOrder('staff', 'upcomingServiceReminder', db.state.orders[0])
  assert.equal(result.error, 'template_not_configured')
  assert.equal(sent.length, 0)
})

test('admin saves distinct started and progress template IDs', async () => {
  const { db } = fixture()
  const api = loadCloudFunction('api', db, 'admin')
  const saved = await api.main({ module: 'admin', action: 'saveSystemSettings', data: {
    subscription: { enabled: true, templates: { serviceStart: ' start-new ', serviceProgress: ' progress-new ' } }
  } })
  assert.equal(saved.ok, true, saved.message)
  const result = await api.main({ module: 'system', action: 'getSettings', data: {} })
  assert.equal(result.data.subscription.templates.serviceStart, 'start-new')
  assert.equal(result.data.subscription.templates.serviceProgress, 'progress-new')
})

test('completion before transaction commit cannot be reverted by start', async () => {
  const { db, start, sent } = fixture()
  const transaction = db.runTransaction
  db.runTransaction = callback => {
    db.state.orders[0].status = 'completed'
    return transaction(callback)
  }
  assert.equal((await start()).ok, false)
  assert.equal(db.state.orders[0].status, 'completed')
  assert.equal(sent.length, 0)
  assert.equal((db.state.subscription_logs || []).length, 0)
})

test('notification failure keeps service started and queued payload can recover', async () => {
  const { db, start, cloud, sent } = fixture()
  const send = cloud.openapi.subscribeMessage.send
  cloud.openapi.subscribeMessage.send = async () => { throw new Error('temporary network error') }
  const result = await start()
  assert.equal(result.ok, true, result.message)
  assert.equal(db.state.orders[0].status, 'in_service')
  const row = db.state.subscription_logs.find(item => item.delivery)
  assert.equal(row.status, 'queued')
  row.nextAttemptAt = new Date(0)
  cloud.openapi.subscribeMessage.send = send
  await createContext({ db, cloud }).retryFailedSubscriptions()
  assert.equal(sent.length, 1)
  assert.equal(db.state.subscription_logs.find(item => item._id === row._id).status, 'sent')
})

test('queue write failure rolls back service start', async () => {
  const { db, start, sent } = fixture()
  const transaction = db.runTransaction
  db.runTransaction = callback => transaction(tx => callback({ collection(name) {
    if (name !== 'subscription_logs') return tx.collection(name)
    return { doc(id) {
      const doc = tx.collection(name).doc(id)
      return { ...doc, set: async () => { throw new Error('queue unavailable') } }
    } }
  } }))
  assert.equal((await start()).ok, false)
  assert.equal(db.state.orders[0].status, 'assigned')
  assert.equal(db.state.users.find(row => row.openid === 'staff').staffAssignmentRevision, undefined)
  assert.equal(sent.length, 0)
})
