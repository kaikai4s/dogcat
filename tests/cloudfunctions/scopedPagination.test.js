const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const createRepository = require('../../cloudfunctions/api/services/repository')
const timeUtils = require('../../cloudfunctions/api/utils/time')

const rows = (count, fields = {}) => Array.from({ length: count }, (_, i) => ({ _id: `r${String(i).padStart(3, '0')}`, ...fields }))
// Enforce the cloud query ceiling even when a caller forgets an explicit limit.
function cappedStore(initial) {
  const db = createCollectionStore(initial)
  const collection = db.collection
  db.collection = name => {
    const query = collection(name)
    const get = query.get.bind(query)
    query.get = async () => ({ data: (await get()).data.slice(0, 100) })
    return query
  }
  return db
}

test('scoped reads return all equal-timestamp rows deterministically without leaking other users', async () => {
  const owned = rows(205, { openid: 'owner', createdAt: '2026-09-22' })
  const db = cappedStore({ records: [...owned].reverse().concat({ _id: 'other', openid: 'other' }) })
  const repository = createRepository({ db, ...timeUtils })
  const result = await repository.readScopedDocuments('records', { openid: 'owner' }, 'createdAt', 'desc')
  assert.deepEqual(result, owned)
  assert.equal((await repository.readScopedDocuments('records', { openid: 'missing' })).length, 0)
})

test('batch deletion covers all pages and filtered deletion advances over a fully excluded page', async () => {
  const db = cappedStore({ records: rows(205, { owner: 'owner' }).concat({ _id: 'other', owner: 'other' }) })
  const repository = createRepository({ db, ...timeUtils })
  assert.equal(await repository.removeAllByQuery('records', { owner: 'owner' }, row => row._id >= 'r100'), 105)
  assert.equal(await repository.removeByQuery('records', { owner: 'owner' }), 100)
  assert.deepEqual(db.state.records, [{ _id: 'other', owner: 'other' }])
  db.state.records.push(...rows(205, { owner: 'owner' }))
  assert.equal(await repository.removeByQuery('records', { owner: 'owner' }), 205)
})

test('batch update continues when mutations remove earlier rows from its query', async () => {
  const db = cappedStore({ records: rows(205, { status: 'pending' }) })
  const repository = createRepository({ db, ...timeUtils })
  assert.equal(await repository.updateByQuery('records', { status: 'pending' }, row => ({ status: 'done', copiedId: row._id })), 205)
  assert.ok(db.state.records.every(row => row.status === 'done' && row.copiedId === row._id))
})

for (const staff of [false, true]) {
  test(`${staff ? 'staff' : 'client'} unread count and message history include rows after 100`, async () => {
    const ownerKey = staff ? 'staffOpenid' : 'clientOpenid'
    const threadCollection = staff ? 'order_staff_message_threads' : 'order_message_threads'
    const messageCollection = staff ? 'order_staff_messages' : 'order_messages'
    const db = cappedStore({
      [threadCollection]: rows(205, { [ownerKey]: 'owner', unreadCount: 1 }).concat({ _id: 'other', [ownerKey]: 'other', unreadCount: 999 }),
      [messageCollection]: rows(205, { threadId: 'r000', createdAt: '2026-09-22' }).concat({ _id: 'other', threadId: 'other' })
    })
    const context = createContext({ db, cloud: {} })
    const handler = require(`../../cloudfunctions/api/handlers/${staff ? 'staffMessage' : 'message'}`)({
      ...context, getUser: async () => ({ roles: ['staff'] })
    })
    assert.equal((await handler('owner', 'getUnreadSummary', {})).totalUnread, 205)
    const result = await handler('owner', 'getThreadMessages', { threadId: 'r000' })
    assert.equal(result.messages.length, 205)
    await assert.rejects(handler('owner', 'getThreadMessages', { threadId: 'other' }), /消息会话不存在/)
  })
}

test('service reports and checkin requirements include valid evidence after 100 historical photos', async () => {
  const db = cappedStore({
    checkin_logs: rows(205, { orderId: 'order', eventType: 'feed', mediaFileId: 'photo', createdAt: '2026-09-22', recordedAt: '2026-09-22' }),
    track_logs: rows(205, { orderId: 'order', latitude: 31.2, longitude: 121.5, accuracy: 10 }).map((row, index) => ({ ...row, recordedAt: Date.UTC(2026, 8, 22) + index * 10000 }))
  })
  db.state.checkin_logs[0].deletedAt = '2026-09-22'
  db.state.checkin_logs.slice(0, 204).forEach(row => { row.eventType = 'arrival' })
  const context = createContext({ db, cloud: {} })
  const order = { _id: 'order' }
  const handler = require('../../cloudfunctions/api/handlers/order')({ ...context, requireServiceReportAccess: async () => ({ order }) })
  const report = await handler('owner', 'getServiceReport', { id: 'order' })
  assert.equal(report.tracks.length, 205)
  assert.equal(report.checkins.length, 204)
  const completionOrder = { ...order, requiredCheckins: ['feed'] }
  assert.equal((await context.evaluateCheckinCompletion(completionOrder)).isComplete, true)
  db.state.checkin_logs[204].deletedAt = '2026-09-22'
  assert.equal((await context.evaluateCheckinCompletion(completionOrder)).isComplete, false)
})

test('finance balance includes all earnings and withdrawal history for the current staff', async () => {
  const db = cappedStore({
    staff_earnings: rows(205, { staffOpenid: 'owner', status: 'available', amount: 1 }),
    withdraw_requests: rows(205, { staffOpenid: 'owner', createdAt: '2026-09-22' })
  })
  db.state.staff_earnings.push({ _id: 'other', staffOpenid: 'other', status: 'available', amount: 999 })
  const context = createContext({ db, cloud: {} })
  const handler = require('../../cloudfunctions/api/handlers/finance')({
    ...context, getUser: async () => ({}), getSystemSettings: async () => ({ settlement: { minWithdrawAmount: 10 } })
  })
  const balance = await handler('owner', 'getStaffBalance', {})
  assert.equal(balance.total, 205)
  assert.equal(balance.available, 205)
  assert.equal(balance.withdraws.length, 205)
})

test('address defaults and available coupons are found beyond the first page', async () => {
  const db = cappedStore({
    user_addresses: rows(205, { openid: 'owner', isDefault: true }),
    user_coupons: rows(205, { openid: 'owner', status: 'used' })
  })
  db.state.user_coupons[204].status = 'available'
  const context = createContext({ db, cloud: {} })
  const handler = require('../../cloudfunctions/api/handlers/client')({ ...context, getUser: async () => ({}) })
  await handler('owner', 'setDefaultAddress', { id: 'r204' })
  assert.deepEqual(db.state.user_addresses.filter(row => row.isDefault).map(row => row._id), ['r204'])
  assert.deepEqual((await context.getAvailableUserCoupons('owner')).map(row => row._id), ['r204'])
})

test('admin order pagination preserves newest-first order after cursor-based reads', async () => {
  const db = cappedStore({ orders: rows(205).map((row, i) => ({ ...row, createdAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString() })) })
  const context = createContext({ db, cloud: {} })
  const handler = require('../../cloudfunctions/api/handlers/admin')({
    ...context, requireAdmin: async () => ({}), requireAdminAction: async () => {},
    processOverdueUnstartedOrders: async () => {}, processOverdueUnfinishedOrders: async () => {},
    attachAdminOrderContactData: async row => row
  })
  const result = await handler('admin', 'listOrders', { page: 1, pageSize: 20 })
  assert.equal(result.total, 205)
  assert.equal(result.list[0]._id, 'r204')
  assert.equal(result.list[19]._id, 'r185')
})

test('expiration processes every page even as paid orders leave the query', async () => {
  const db = cappedStore({ orders: rows(205, { status: 'paid', startTime: '2026-09-01' }) })
  const service = require('../../cloudfunctions/api/scheduled/expireOrders')({
    db, ...timeUtils, ORDER_STATUS: { PAID: 'paid', EXPIRED: 'expired' }, safeText: value => String(value || ''),
    now: () => new Date('2026-09-22T12:00:00Z'),
    appendOrderTimeline: async () => {}, appendOrderClientMessage: async () => {}
  })
  await service.expireDueUnacceptedOrders()
  assert.equal(db.state.orders.filter(row => row.status === 'expired').length, 205)
})

test('staff completed orders have stable ordering and continue past deleted records', async () => {
  const source = rows(205, { staffOpenid: 'owner', status: 'completed', completedAt: '2026-09-22' })
  source.slice(0, 100).forEach(row => { row.adminDeletedAt = '2026-09-22' })
  const db = cappedStore({ orders: [...source].reverse() })
  const context = createContext({ db, cloud: {} })
  const all = await context.getCompletedStaffOrders('owner')
  assert.equal(all.length, 105)
  assert.deepEqual(all.map(row => row._id), source.slice(100).map(row => row._id))
  assert.deepEqual((await context.getCompletedStaffOrders('owner', 3)).map(row => row._id), ['r100', 'r101', 'r102'])
})

test('direct and urgent orders retain service-time ordering after reading multiple pages', async () => {
  const db = cappedStore({
    staff_profiles: [{ _id: 'profile', openid: 'owner' }],
    orders: rows(205, { status: 'paid', publishMode: 'direct', requestedStaffOpenid: 'owner', isUrgent: true })
      .map((row, i) => ({ ...row, startTime: new Date(Date.UTC(2026, 8, 22, 0, 205 - i)).toISOString() }))
  })
  const context = createContext({ db, cloud: {} })
  const handler = require('../../cloudfunctions/api/handlers/staff')({
    ...context, getUser: async () => ({ roles: ['staff'] }), getSystemSettings: async () => ({}),
    validateStaffTakeOrderAbility: () => ({ can: true }), expireDueUnacceptedOrders: async () => {},
    attachOrderDisplayData: async row => row, maskOrderForStaffPreview: row => row
  })
  for (const action of ['listDirectOrders', 'listUrgentOrders']) {
    const result = await handler('owner', action, { page: 1, pageSize: 20 })
    assert.equal(result.total, 205)
    assert.equal(result.list[0]._id, 'r204')
  }
})
