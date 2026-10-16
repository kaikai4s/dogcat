const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const optimistic = require('./optimisticTransactions')
const createContext = require('../../cloudfunctions/api/services/context')

function completionSetup(count = 0) {
  const db = createCollectionStore({
    users: [{ _id: 'client', openid: 'client', status: 'active', roles: ['client'], points: 0, totalPoints: 0, completedOrderCount: count, retroCardCount: 0 }],
    orders: ['a', 'b'].map(_id => ({ _id, clientOpenid: 'client', clientUserId: 'client', staffOpenid: 'staff', status: 'in_service', payAmount: 60 })),
    point_logs: [], retro_card_logs: [], staff_earnings: [], subscription_logs: []
  })
  const retries = optimistic(db)
  return { db, retries, context: createContext({ db, cloud: {} }) }
}

test('concurrent finalization commits points, ordinal, milestone, earning and outbox once', async () => {
  const { db, retries, context } = completionSetup(2)
  const order = structuredClone(db.state.orders[0])
  const firstTime = new Date('2026-10-01T02:00:00Z')
  const finish = time => context.ensureOrderCompletionRewards(order, time, {
    completionPatch: { status: 'completed', completedAt: time },
    notifications: [{ openid: 'client', detail: { statusText: '已完成' }, role: 'client' }]
  })
  await Promise.all([finish(firstTime), finish(new Date(firstTime.getTime() + 1000))])
  assert.ok(retries() > 0)
  assert.equal(db.state.users[0].completedOrderCount, 3)
  assert.equal(db.state.users[0].points, 6)
  assert.equal(db.state.users[0].retroCardCount, 1)
  assert.equal(db.state.point_logs.length, 1)
  assert.equal(db.state.retro_card_logs.length, 1)
  assert.equal(db.state.staff_earnings.length, 1)
  assert.equal(db.state.subscription_logs.length, 1)
  assert.equal(db.state.orders[0].completionOrdinal, 3)
  assert.equal(db.state.orders[0].completedAt.getTime(), firstTime.getTime())
})

test('concurrent different orders for one client allocate consecutive completion ordinals', async () => {
  const { db, context } = completionSetup(1)
  await Promise.all(db.state.orders.map(order => context.ensureOrderCompletionRewards(order, new Date(), { completionPatch: { status: 'completed' } })))
  assert.equal(db.state.users[0].completedOrderCount, 3)
  assert.equal(db.state.users[0].points, 12)
  assert.equal(db.state.users[0].retroCardCount, 1)
  assert.deepEqual(db.state.orders.map(row => row.completionOrdinal).sort(), [2, 3])
  await context.ensureOrderCompletionRewards(db.state.orders.find(row => row.completionOrdinal === 2))
  assert.equal(db.state.retro_card_logs.length, 1)
})

test('outbox persistence failure rolls back completed state and financial rewards', async () => {
  const { db, context } = completionSetup(2)
  const run = db.runTransaction
  db.runTransaction = callback => run(tx => callback({ collection(name) {
    if (name === 'subscription_logs') return { doc() { return { async get() { return { data: null } }, async set() { throw new Error('outbox unavailable') } } } }
    return tx.collection(name)
  } }))
  await assert.rejects(context.ensureOrderCompletionRewards(db.state.orders[0], new Date(), {
    completionPatch: { status: 'completed' }, notifications: [{ openid: 'client', detail: {}, role: 'client' }]
  }), /outbox unavailable/)
  assert.equal(db.state.orders[0].status, 'in_service')
  assert.equal(db.state.users[0].points, 0)
  assert.equal(db.state.users[0].completedOrderCount, 2)
  assert.equal(db.state.users[0].retroCardCount, 0)
  assert.equal(db.state.staff_earnings.length, 0)
  assert.equal(db.state.point_logs.length, 0)
})

test('retro cards prevent concurrent duplicate grants and overspending', async () => {
  const { db, context } = completionSetup()
  await Promise.all([1, 2].map(() => context.grantRetroCards('client', 'client', 1, 'reward', 'same', 'grant')))
  assert.equal(db.state.users[0].retroCardCount, 1)
  const results = await Promise.allSettled([1, 2].map(() => context.grantRetroCards('client', 'client', -1, 'use', '', 'use')))
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
  assert.equal(db.state.users[0].retroCardCount, 0)
})

test('old counted orders without an ordinal never infer a milestone from a later user total', async () => {
  const { db, context } = completionSetup(3)
  Object.assign(db.state.orders[0], { status: 'completed', pointsAwarded: true, clientOrderCounted: true })
  await context.ensureOrderCompletionRewards(db.state.orders[0])
  assert.equal(db.state.users[0].retroCardCount, 0)
  assert.equal(db.state.orders[0].completionOrdinalNeedsReview, true)
  assert.equal(db.state.orders[0].completionOrdinal, undefined)
})

test('oversized track batches are rejected before any point is stored', async () => {
  const db = createCollectionStore({ users: [{ _id: 'staff', openid: 'staff', roles: ['staff'], status: 'active' }],
    orders: [{ _id: 'order', staffOpenid: 'staff', status: 'in_service' }] })
  const result = await loadCloudFunction('api', db, 'staff').main({ module: 'track', action: 'batchUploadTrack',
    data: { orderId: 'order', points: Array.from({ length: 201 }, () => ({ latitude: 31.2, longitude: 121.5 })) } })
  assert.equal(result.ok, false)
  assert.match(result.message, /每批最多/)
  assert.equal((db.state.track_logs || []).length, 0)
})

test('same track ID inside one batch and concurrent uploads produce one point', async () => {
  const time = Date.now() - 5000
  const db = createCollectionStore({ users: [{ _id: 'staff', openid: 'staff', roles: ['staff'], status: 'active' }],
    orders: [{ _id: 'order', staffOpenid: 'staff', status: 'in_service', startedAt: new Date(time - 10000) }], track_logs: [] })
  optimistic(db)
  const api = loadCloudFunction('api', db, 'staff')
  const point = { clientPointId: 'p', latitude: 31.2, longitude: 121.5, accuracy: 10, recordedAt: time }
  const upload = points => api.main({ module: 'track', action: 'batchUploadTrack', data: { orderId: 'order', points } })
  const results = await Promise.all([upload([point, point]), upload([point])])
  assert.ok(results.every(row => row.ok))
  assert.equal(results.reduce((sum, row) => sum + row.data.count, 0), 1)
  assert.equal(db.state.track_logs.length, 1)
  assert.equal(db.state.orders[0].trackRevision, 1)
})

test('transactional delivery survives commit and consumes estimated subscription count once', async () => {
  const db = createCollectionStore({ subscription_balances: [], subscription_balance_events: [] })
  let time = new Date('2026-10-01T00:00:00Z')
  const service = require('../../cloudfunctions/api/services/subscriptionDelivery')({ db, crypto, now: () => time })
  await service.recordSubscriptionBalance('client', 'tpl_refund', 'consent-1')
  await service.recordSubscriptionBalance('client', 'tpl_refund', 'consent-1')
  await service.recordSubscriptionBalance('client', 'tpl_refund', 'consent-2')
  assert.equal((await service.getSubscriptionBalanceSummary('client', ['tpl_refund'])).tpl_refund.estimatedRemaining, 2)

  const message = { openid: 'client', templateKey: 'refundResult', page: 'pages/client/orders/detail/index?id=o', messageData: {}, orderId: 'o', deliveryKey: 'refund-a' }
  await db.runTransaction(tx => service.enqueueSubscription(tx, message))
  let calls = 0
  await service.retrySubscriptionDeliveries(async () => { calls++; return { status: 'failed', templateId: 'tpl_refund' } })
  assert.equal(calls, 1)
  time = new Date(time.getTime() + 3600000)
  await service.retrySubscriptionDeliveries(async () => { calls++; return { status: 'sent', templateId: 'tpl_refund' } })
  await service.deliverSubscription(message, async () => { calls++; return { status: 'sent', templateId: 'tpl_refund' } })
  assert.equal(calls, 2)
  assert.equal(db.state.subscription_logs.length, 1)
  assert.equal(db.state.subscription_logs[0].status, 'sent')
  assert.equal((await service.getSubscriptionBalanceSummary('client', ['tpl_refund'])).tpl_refund.estimatedRemaining, 1)
  assert.equal(db.state.subscription_balance_events.filter(row => row.type === 'consume').length, 1)
  assert.equal((await service.listSubscriptionDeliveries({ status: 'sent' })).list[0].openid, undefined)
})

test('quota exhaustion marks balance resubscribe needed and race condition preserves newer consent', async () => {
  const db = createCollectionStore({ subscription_balances: [], subscription_balance_events: [] })
  let currentTime = new Date('2026-10-01T00:00:00Z')
  const service = require('../../cloudfunctions/api/services/subscriptionDelivery')({ db, crypto, now: () => currentTime })

  await service.recordSubscriptionBalance('client', 'tpl_status', 'consent-1')
  assert.equal((await service.getSubscriptionBalanceSummary('client', ['tpl_status'])).tpl_status.estimatedRemaining, 1)

  // 1. Quota exhausted normal case
  const msg1 = { openid: 'client', templateKey: 'orderPaid', page: 'p', messageData: {}, orderId: 'o1', deliveryKey: 'k1' }
  await db.runTransaction(tx => service.enqueueSubscription(tx, msg1))
  await service.deliverSubscription(msg1, async () => ({
    status: 'failed', templateId: 'tpl_status', isQuotaExhausted: true, code: 43101
  }))
  const exhausted = (await service.getSubscriptionBalanceSummary('client', ['tpl_status'])).tpl_status
  assert.equal(exhausted.needsResubscribe, true)
  assert.equal(exhausted.estimatedRemaining, 0)

  // 2. Race condition: user consents again while an in-flight send encounters quota exhaustion
  currentTime = new Date('2026-10-01T01:00:00Z')
  const msg2 = { openid: 'client', templateKey: 'orderPaid', page: 'p', messageData: {}, orderId: 'o2', deliveryKey: 'k2' }
  await db.runTransaction(tx => service.enqueueSubscription(tx, msg2))
  await service.deliverSubscription(msg2, async () => {
    // During send execution, time advances and user authorizes anew
    currentTime = new Date('2026-10-01T01:00:05Z')
    await service.recordSubscriptionBalance('client', 'tpl_status', 'consent-fresh')
    return { status: 'failed', templateId: 'tpl_status', isQuotaExhausted: true, code: 43101 }
  })
  const preserved = (await service.getSubscriptionBalanceSummary('client', ['tpl_status'])).tpl_status
  assert.equal(preserved.needsResubscribe, false)
  assert.equal(preserved.estimatedRemaining, 2)

  // 3. Consumptions beyond balance floor remaining count at 0
  const msg3 = { openid: 'client', templateKey: 'orderPaid', page: 'p', messageData: {}, orderId: 'o3', deliveryKey: 'k3' }
  const msg4 = { openid: 'client', templateKey: 'orderPaid', page: 'p', messageData: {}, orderId: 'o4', deliveryKey: 'k4' }
  const msg5 = { openid: 'client', templateKey: 'orderPaid', page: 'p', messageData: {}, orderId: 'o5', deliveryKey: 'k5' }
  await service.deliverSubscription(msg3, async () => ({ status: 'sent', templateId: 'tpl_status' }))
  assert.equal((await service.getSubscriptionBalanceSummary('client', ['tpl_status'])).tpl_status.estimatedRemaining, 1)
  await service.deliverSubscription(msg4, async () => ({ status: 'sent', templateId: 'tpl_status' }))
  assert.equal((await service.getSubscriptionBalanceSummary('client', ['tpl_status'])).tpl_status.estimatedRemaining, 0)
  await service.deliverSubscription(msg5, async () => ({ status: 'sent', templateId: 'tpl_status' }))
  const floored = (await service.getSubscriptionBalanceSummary('client', ['tpl_status'])).tpl_status
  assert.equal(floored.estimatedRemaining, 0)
  assert.equal(floored.consumedCount, 3)
  assert.equal(floored.acceptedCount, 2)
})


test('delivery event identity preserves queued payload and retry audit, and distinguishes service days', async () => {
  const db = createCollectionStore()
  const service = require('../../cloudfunctions/api/services/subscriptionDelivery')({ db, crypto, now: () => new Date() })
  const message = { openid: 'client', templateKey: 'serviceFinish', orderId: 'o', page: 'p', messageData: { date: 'original' }, deliveryKey: 'finish:day:1' }
  const id = await db.runTransaction(tx => service.enqueueSubscription(tx, message))
  await service.deliverSubscription({ ...message, messageData: { date: 'changed' } }, async payload => {
    assert.equal(payload.messageData.date, 'original')
    return { status: 'sent' }
  })
  await db.runTransaction(tx => service.enqueueSubscription(tx, { ...message, deliveryKey: 'finish:day:2' }))
  assert.equal(db.state.subscription_logs.length, 2)
  Object.assign(db.state.subscription_logs.find(row => row._id === id), { status: 'failed', attempts: 6, expiresAt: new Date() })
  await service.requeueSubscriptionDelivery(id, 'admin')
  assert.equal(db.state.subscription_logs.find(row => row._id === id).expiresAt, undefined)
  await service.deliverSubscription(message, async () => ({ status: 'sent' }))
  const row = db.state.subscription_logs.find(row => row._id === id)
  assert.equal(row.manualRetries, 1)
  assert.equal(row.previousAttempts, 6)
  assert.equal(row.retriedBy, 'admin')
})

test('performance logs report timing and cold start without request data or user identity', async () => {
  const db = createCollectionStore()
  const api = loadCloudFunction('api', db, 'private-openid')
  const logs = []
  const original = console.info
  console.info = (label, data) => { logs.push({ label, data }) }
  try {
    await api.main({ module: 'auth', action: 'login', data: { nickname: 'private-name' } })
    await api.main({ module: 'private-unknown-module', action: 'private-action', data: { password: 'private-secret' } })
  } finally { console.info = original }
  assert.equal(logs.length, 2)
  assert.equal(logs[0].data.coldStart, true)
  assert.equal(logs[1].data.coldStart, false)
  assert.equal(logs[1].data.success, false)
  assert.ok(logs.every(row => row.data.durationMs >= 0))
  assert.doesNotMatch(JSON.stringify(logs), /private-/)
})

test('message cursor traverses tied timestamps without skipping; server list scopes and sorts unread first', async () => {
  const db = createCollectionStore({ users: [{ _id: 'u', openid: 'client', roles: ['client'], status: 'active' }],
    order_message_threads: [
      { _id: 't', clientOpenid: 'client', lastMessageAt: '2026-10-01 10:00', unreadCount: 1 },
      { _id: 'new', clientOpenid: 'client', lastMessageAt: '2026-10-02T10:00:00+08:00', unreadCount: 0 },
      { _id: 'hidden', clientOpenid: 'client', unreadCount: 50, hiddenForClient: true },
      { _id: 'other', clientOpenid: 'other', unreadCount: 50 }
    ], order_messages: Array.from({ length: 135 }, (_, i) => ({ _id: `m${String(i).padStart(3, '0')}`, threadId: 't', createdAt: '2026-10-01 10:00', title: 'status' })) })
  const api = loadCloudFunction('api', db, 'client')
  const list = await api.main({ module: 'message', action: 'listThreads', data: { pageSize: 1 } })
  assert.equal(list.ok, true)
  assert.equal(list.data.total, 2)
  assert.equal(list.data.list[0]._id, 't')
  const ids = []
  let before
  do {
    const page = await api.main({ module: 'message', action: 'getThreadMessages', data: { threadId: 't', pageSize: 30, before } })
    assert.equal(page.ok, true, page.message)
    ids.unshift(...page.data.messages.map(row => row._id))
    before = page.data.hasMore ? page.data.before : null
  } while (before)
  assert.equal(ids.length, 135)
  assert.equal(new Set(ids).size, 135)
  const denied = await api.main({ module: 'message', action: 'getThreadMessages', data: { threadId: 'other', pageSize: 30 } })
  assert.equal(denied.ok, false)
  const unread = await api.main({ module: 'message', action: 'getUnreadSummary', data: {} })
  assert.equal(unread.data.orderUnread, 1)
})
