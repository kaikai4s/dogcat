const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')

const id = 'map_community_' + 'a'.repeat(24)
function community(extra = {}) { return { _id: id, key: 'service_community', enabled: true, name: '阳光花园', aliases: ['阳光花园东门'],
  city: '上海市', cityKey: '上海', latitude: 31.2, longitude: 121.5, revision: 1, matchRadiusKm: 1, ...extra } }
function profile(i = 1, extra = {}) { return { _id: `p${i}`, openid: `s${i}`, auditStatus: 'approved', staffLevel: 'certified',
  serviceCity: '上海市', serviceAddress: '阳光花园私人点', serviceLatitude: 31.201, serviceLongitude: 121.501,
  publicMapEnabled: true, publicServiceCommunityId: id, publicCommunityRevision: 1, publicServiceCommunityName: '阳光花园',
  publicBookingPolicyVersion: 1, publicBookingLatitude: 31.2, publicBookingLongitude: 121.5, publicBookingRadiusKm: 5, ...extra } }
function task(i, extra = {}) { return { _id: `o${String(i).padStart(3, '0')}`, status: 'paid', paymentStatus: 'paid', publishMode: 'open',
  city: '上海市', serviceAddress: '阳光花园', addressLatitude: 31.201234, addressLongitude: 121.501234,
  addressDetail: 'PRIVATE-1602', doorplate: 'SECRET', contactPhone: '13800000000',
  startTime: '2099-12-01 10:00', endTime: '2099-12-01 11:00', payAmount: 50, ...extra } }
function setup(extra = {}) {
  return createCollectionStore({ users: [{ _id: 'u', openid: 'client', roles: ['client'], status: 'active' },
    ...(extra.staff_profiles || [profile()]).map((p, index) => ({ _id: index === 0 ? 'us' : `us${index}`, openid: p.openid, roles: ['staff'], status: 'active' })),
    { _id: 'admin', openid: 'admin', roles: ['admin'], status: 'active' }],
    staff_profiles: [profile()], platform_configs: [community()], orders: [], ...extra })
}
test('map only emits verified public community points and counts sitters across pages', async () => {
  const db = setup({ staff_profiles: Array.from({ length: 26 }, (_, i) => profile(i + 1)) })
  const api = loadCloudFunction('api', db, 'client')
  const first = await api.main({ module: 'communityMap', action: 'listSitters', data: { city: '上海市', communityId: id } })
  assert.equal(first.ok, true, first.message)
  assert.equal(first.data.communities[0].count, 26)
  assert.equal(first.data.communities[0].latitude, 31.2)
  assert.equal(first.data.list.length, 10)
  assert.equal(first.data.total, 26)
  assert.equal(first.data.hasMore, true)
  assert.ok(first.data.nextCursor)
  const second = await api.main({ module: 'communityMap', action: 'listSitters', data: { city: '上海市', communityId: id, page: 2 } })
  assert.equal(second.data.list.length, 10)
  assert.equal(new Set([...first.data.list, ...second.data.list].map(row => row._id)).size, 20)
  const serialized = JSON.stringify(first.data)
  for (const secret of ['serviceLatitude', 'serviceLongitude', '31.201', 'openid', '私人点']) assert.equal(serialized.includes(secret), false, secret)
})
test('sitter map cursor stays stable when an earlier profile disappears', async () => {
  const db = setup({ staff_profiles: Array.from({ length: 15 }, (_, i) => profile(i + 1, { ratingAverage: 5 - i / 100 })) })
  const fn = require('../../cloudfunctions/api/handlers/communityMap')(createContext({ db, cloud: {} }))
  const first = await fn('client', 'listSitters', { city: '上海市', communityId: id })
  db.state.staff_profiles = db.state.staff_profiles.filter(row => row._id !== 'p2')
  const second = await fn('client', 'listSitters', { city: '上海市', communityId: id, page: 2, cursor: first.nextCursor })
  assert.deepEqual(second.list.map(row => row._id), ['p11', 'p12', 'p13', 'p14', 'p15'])
  assert.equal(new Set([...first.list, ...second.list].map(row => row._id)).size, 15)
})
test('visibility, community revision, paused direct booking and gender filters are enforced', async () => {
  const db = setup({ staff_profiles: [profile(1, { gender: 'female' }), profile(2, { publicMapEnabled: false }),
    profile(3, { publicCommunityRevision: 0 }), profile(4, { acceptDirectOrders: false, gender: 'female' }), profile(5, { gender: 'male' })] })
  const fn = require('../../cloudfunctions/api/handlers/communityMap')(createContext({ db, cloud: {} }))
  const result = await fn('client', 'listSitters', { city: '上海市', communityId: id, onlyDirect: true, staffGenderRequirement: 'female' })
  assert.equal(result.communities[0].count, 1)
  assert.deepEqual(result.list.map(row => row._id), ['p1'])
  db.state.platform_configs[0].enabled = false
  const disabled = await fn('client', 'listSitters', { city: '上海市', communityId: id })
  assert.equal(disabled.list.length, 0)
  assert.equal(disabled.communities.length, 0)
})
test('ordinary users cannot obtain the order map', async () => {
  const db = setup({ orders: [task(1)] }), api = loadCloudFunction('api', db, 'client')
  const result = await api.main({ module: 'communityMap', action: 'listOrders', data: { city: '上海市' } })
  assert.equal(result.ok, false)
  assert.match(result.message, /员工/)
})
test('order map counts all pages, retains unlocated tasks in unmatched count and never emits home coordinates', async () => {
  const db = setup({ orders: [...Array.from({ length: 25 }, (_, i) => task(i)), task(99, { serviceAddress: '未识别小区' }), task(100, { publishMode: 'direct', requestedStaffOpenid: 'other' })] })
  const api = loadCloudFunction('api', db, 's1')
  const result = await api.main({ module: 'communityMap', action: 'listOrders', data: { city: '上海市', communityId: id } })
  assert.equal(result.ok, true, result.message)
  assert.equal(result.data.communities[0].count, 25)
  assert.equal(result.data.total, 25)
  assert.equal(result.data.list.length, 10)
  assert.equal(result.data.unmatchedCount, 1)
  for (const value of ['31.201234', '121.501234', 'PRIVATE', 'SECRET', '13800000000', 'clientOpenid']) assert.equal(JSON.stringify(result.data).includes(value), false, value)
})
test('order map uses public-safe chronological cursor order instead of private distance order', async () => {
  const orders = Array.from({ length: 15 }, (_, i) => task(i, {
    startTime: `2099-12-${String(i + 1).padStart(2, '0')} 10:00`,
    endTime: `2099-12-${String(i + 1).padStart(2, '0')} 11:00`,
    addressLatitude: 31.2 + (15 - i) / 20000,
    addressLongitude: 121.5
  }))
  const db = setup({ orders }), fn = require('../../cloudfunctions/api/handlers/staff')(createContext({ db, cloud: {} }))
  const first = await fn('s1', 'listOrderMap', { city: '上海市', communityId: id })
  assert.deepEqual(first.list.map(row => row._id), orders.slice(0, 10).map(row => row._id))
  db.state.orders = db.state.orders.filter(row => row._id !== 'o001')
  const second = await fn('s1', 'listOrderMap', { city: '上海市', communityId: id, page: 2, cursor: first.nextCursor })
  assert.deepEqual(second.list.map(row => row._id), orders.slice(10).map(row => row._id))
  assert.equal(new Set([...first.list, ...second.list].map(row => row._id)).size, 15)
})
test('map bundles stay whole and a date filter matches later sessions', async () => {
  const db = setup({ orders: [task(1, { serviceSessions: [{ startTime: '2099-12-01 10:00', endTime: '2099-12-01 11:00' }, { startTime: '2099-12-03 10:00', endTime: '2099-12-03 11:00' }] }),
    task(2, { groupBuyId: 'g', groupBuyStatus: 'formed' }), task(3, { groupBuyId: 'g', groupBuyStatus: 'formed' })] })
  const fn = require('../../cloudfunctions/api/handlers/staff')(createContext({ db, cloud: {} }))
  const result = await fn('s1', 'listOrderMap', { city: '上海市', communityId: id })
  assert.equal(result.total, 2)
  assert.equal(result.list.find(row => row.isGroupBuyBundle).householdCount, 2)
  const later = await fn('s1', 'listOrderMap', { city: '上海市', communityId: id, filterDate: '2099-12-03' })
  assert.equal(later.total, 1)
  assert.equal(later.list[0]._id, 'o001')
})
test('clients cannot forge public coordinates and ambiguous estates are not auto-merged', async () => {
  const db = setup(), context = createContext({ db, cloud: {} })
  const rows = [community(), community({ _id: 'map_community_' + 'b'.repeat(24), latitude: 31.2001 })]
  assert.equal(context.matchMapCommunity(task(1), rows), null)
  assert.equal(context.matchMapCommunity(task(1, { addressLatitude: 30.1 }), [community()]), null)
  const api = loadCloudFunction('api', db, 'client')
  const save = await api.main({ module: 'communityMap', action: 'saveAdmin', data: { name: '伪造小区', city: '上海市', latitude: 31.2, longitude: 121.5, confirmPublic: true } })
  assert.equal(save.ok, false)
})
test('map publication requires consent, matching service community and can be revoked', async () => {
  const db = setup(), api = loadCloudFunction('api', db, 's1')
  const noConsent = await api.main({ module: 'communityMap', action: 'setVisibility', data: { enabled: true, communityId: id } })
  assert.equal(noConsent.ok, false)
  const consent = await api.main({ module: 'communityMap', action: 'setVisibility', data: { enabled: true, communityId: id, confirmPublic: true, radiusKm: 5, communityRevision: 1 } })
  assert.equal(consent.ok, true, consent.message)
  assert.equal(db.state.staff_profiles[0].publicBookingLatitude, 31.2)
  const revoke = await api.main({ module: 'communityMap', action: 'setVisibility', data: { enabled: false } })
  assert.equal(revoke.ok, true)
  assert.equal(db.state.staff_profiles[0].publicMapEnabled, false)
})
test('public calendar hides order identifiers, summaries and exception remarks', async () => {
  const db = setup({ orders: [task(1, { staffOpenid: 's1', status: 'assigned', serviceSummary: 'PRIVATE-SERVICE' })],
    staff_schedule_exceptions: [{ _id: 'exception', staffOpenid: 's1', dateKey: '2099-12-01', status: 'available', slots: [{ start: 8, end: 18 }], remark: 'PRIVATE-REMARK' }] })
  const api = loadCloudFunction('api', db, 'client')
  const result = await api.main({ module: 'staff', action: 'listScheduleAvailability', data: { staffProfileId: 'p1', startDate: '2099-12-01', days: 1 } })
  assert.equal(result.ok, true, result.message)
  for (const secret of ['o001', 'PRIVATE-SERVICE', 'PRIVATE-REMARK']) assert.equal(JSON.stringify(result.data).includes(secret), false)
  assert.equal(result.data[0].busyOrders.length, 1)
})
test('server rejects missing or malformed grab coordinates', async () => {
  const db = setup({ orders: [task(1)] }), api = loadCloudFunction('api', db, 's1')
  for (const coordinates of [{}, { currentLatitude: 91, currentLongitude: 121.5 }, { currentLatitude: 0, currentLongitude: 0 }]) {
    const result = await api.main({ module: 'staff', action: 'acceptOrder', data: { orderId: 'o001', ...coordinates } })
    assert.equal(result.ok, false)
    assert.match(result.message, /有效的实时位置/)
    assert.equal(db.state.orders[0].status, 'paid')
  }
})
test('direct order creation serializes competing holds and keeps the payment deadline as hold lifetime', async () => {
  const db = setup(), context = createContext({ db, cloud: {} })
  const direct = i => ({ ...task(i), status: 'pending_pay', paymentStatus: 'unpaid', clientOpenid: 'client', publishMode: 'direct',
    requestedStaffOpenid: 's1', requestedStaffUserId: 'us', requestedStaffProfileId: 'p1', createdAt: context.now() })
  const results = await Promise.allSettled([1, 2].map(i => context.createOrderWithCouponLock({ collectionName: 'orders', order: direct(i), openid: 'client' })))
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
  assert.match(results.find(row => row.status === 'rejected').reason.message, /已有订单/)
  const order = db.state.orders[0]
  assert.equal(context.getOrderPaymentDeadline(order) - context.toTimeValue(order.createdAt), 30 * 60000)
})

test('payment-in-flight retains the booking hold until reconciliation rather than releasing at timeout', () => {
  const db = setup(), context = createContext({ db, cloud: {} })
  const order = { publishMode: 'direct', status: 'pending_pay', paymentStatus: 'unpaid', createdAt: new Date(context.now().getTime() - 31 * 60000) }
  assert.equal(context.isOrderConflictCandidate(order), false)
  assert.equal(context.isOrderConflictCandidate({ ...order, paymentStatus: 'paying' }), true)
  assert.equal(context.isOrderConflictCandidate({ ...order, paymentNo: 'provider-payment' }), true)
  assert.equal(context.isOrderConflictCandidate({ ...order, paymentStatus: 'closed' }), false)
})
test('notification failures after assignment do not report a failed grab and retries confirm ownership', async () => {
  const db = setup({ orders: [task(1)] }), context = createContext({ db, cloud: {} })
  const fn = require('../../cloudfunctions/api/handlers/staff')({ ...context,
    appendOrderTimeline: async () => { throw new Error('timeline temporarily unavailable') },
    appendOrderClientMessage: async () => { throw new Error('message temporarily unavailable') },
    notifyOrderAccepted: async () => { throw new Error('delivery temporarily unavailable') }
  })
  const data = { orderId: 'o001', currentLatitude: 31.2, currentLongitude: 121.5 }
  const result = await fn('s1', 'acceptOrder', data)
  assert.equal(result.status, 'assigned')
  assert.equal(result.notifyStatus, 'pending')
  assert.equal(db.state.orders[0].staffOpenid, 's1')
  const retry = await fn('s1', 'acceptOrder', data)
  assert.equal(retry.alreadyAssigned, true)
  const own = await fn('s1', 'getGrabResult', { orderId: 'o001' })
  assert.equal(own.state, 'assigned')
  await assert.rejects(() => fn('client', 'getGrabResult', { orderId: 'o001' }), /宠托师/)
})
test('mapped public distance uses the confirmed public centre, never either sitter private point', async () => {
  const db = setup({ staff_profiles: [profile(1), profile(2, { serviceLatitude: 31.205, serviceLongitude: 121.505 })] })
  const api = loadCloudFunction('api', db, 'client')
  const result = await api.main({ module: 'staff', action: 'listApprovedSitters', data: { latitude: 31.21, longitude: 121.51 } })
  assert.equal(result.ok, true, result.message)
  assert.equal(result.data.list.length, 2)
  assert.equal(result.data.list[0].distanceKm, result.data.list[1].distanceKm)
  assert.match(result.data.list[0].distanceText, /距小区约/)
})
test('changing a mapped sitter service radius requires fresh public confirmation', async () => {
  const db = setup(), api = loadCloudFunction('api', db, 's1')
  const result = await api.main({ module: 'staff', action: 'updateStaffProfileConfig', data: { serviceRadiusKm: 10 } })
  assert.equal(result.ok, true, result.message)
  assert.equal(db.state.staff_profiles[0].publicMapEnabled, false)
  assert.equal(db.state.staff_profiles[0].publicBookingNeedsConfirmation, true)
  const client = loadCloudFunction('api', db, 'client')
  const range = await client.main({ module: 'staff', action: 'checkSitterRange', data: { staffProfileId: 'p1', latitude: 31.2, longitude: 121.5 } })
  assert.equal(range.data.canDirectBook, false)
})

test('sitter card refresh preserves requested order and excludes hidden, filtered, and other-community profiles', async () => {
  const otherId = 'map_community_' + 'b'.repeat(24)
  const db = setup({ platform_configs: [community(), community({ _id: otherId, name: '另一个小区' })],
    staff_profiles: [profile(1), profile(2, { publicMapEnabled: false }), profile(3, { publicServiceCommunityId: otherId }),
      profile(4, { ratingAverage: 5 }), profile(5, { acceptDirectOrders: false })] })
  const fn = require('../../cloudfunctions/api/handlers/communityMap')(createContext({ db, cloud: {} }))
  const result = await fn('client', 'listSitters', { city: '上海市', communityId: id, onlyDirect: true,
    refreshIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'nonexistent', 'p1'] })
  assert.deepEqual(result.list.map(row => row._id), ['p4', 'p1'])
  assert.deepEqual(result.visibleList.map(row => row._id), ['p1', 'p4'])
  for (const secret of ['serviceLatitude', 'serviceLongitude', '31.201', 'openid', '私人点']) {
    assert.equal(JSON.stringify(result.visibleList).includes(secret), false, secret)
  }
  const noCommunity = await fn('client', 'listSitters', { city: '上海市', refreshIds: ['p1'] })
  assert.deepEqual(noCommunity.visibleList, [])
  db.state.users.find(user => user.openid === 's1').status = 'disabled'
  const afterDisabled = await fn('client', 'listSitters', { city: '上海市', communityId: id, refreshIds: ['p1', 'p4'] })
  assert.deepEqual(afterDisabled.visibleList.map(row => row._id), ['p4'])
})

test('order card refresh revalidates availability, community, and whole group-buy bundles', async () => {
  const otherId = 'map_community_' + 'b'.repeat(24)
  const db = setup({ platform_configs: [community(), community({ _id: otherId, name: '其他花园', aliases: [] })],
    orders: [task(1), task(2, { status: 'assigned', staffOpenid: 'someone' }), task(3, { publishMode: 'direct', requestedStaffOpenid: 'other' }),
      task(4, { serviceAddress: '其他花园' }), task(5, { groupBuyId: 'g', groupBuyStatus: 'formed' }), task(6, { groupBuyId: 'g', groupBuyStatus: 'formed' })] })
  const fn = require('../../cloudfunctions/api/handlers/staff')(createContext({ db, cloud: {} }))
  const first = await fn('s1', 'listOrderMap', { city: '上海市', communityId: id })
  const bundle = first.list.find(row => row.isGroupBuyBundle)
  assert.ok(bundle)
  const result = await fn('s1', 'listOrderMap', { city: '上海市', communityId: id,
    refreshIds: [bundle._id, 'o001', 'o002', 'o003', 'o004', 'nonexistent'] })
  assert.deepEqual(result.visibleList.map(row => row._id), [bundle._id, 'o001'])
  assert.equal(result.visibleList[0].householdCount, 2)
  for (const secret of ['31.201234', '121.501234', 'PRIVATE', 'SECRET', '13800000000', 'staffOpenid']) {
    assert.equal(JSON.stringify(result.visibleList).includes(secret), false, secret)
  }
  await assert.rejects(fn('client', 'listOrderMap', { city: '上海市', communityId: id, refreshIds: ['o001'] }), /员工/)
  db.state.orders.find(row => row._id === 'o001').status = 'cancelled'
  const updated = await fn('s1', 'listOrderMap', { city: '上海市', communityId: id, refreshIds: ['o001'] })
  assert.deepEqual(updated.visibleList, [])
})

test('both card refresh endpoints reject malformed or unbounded identifier lists', async () => {
  const db = setup(), context = createContext({ db, cloud: {} })
  const sitters = require('../../cloudfunctions/api/handlers/communityMap')(context)
  const staff = require('../../cloudfunctions/api/handlers/staff')(context)
  for (const refreshIds of [null, 'p1', [123], [''], ['a'.repeat(129)], Array(2001).fill('p1')]) {
    for (const call of [() => sitters('client', 'listSitters', { city: '上海市', refreshIds }),
      () => staff('s1', 'listOrderMap', { city: '上海市', refreshIds })]) {
      await assert.rejects(call, /地图刷新参数无效/)
    }
  }
})
