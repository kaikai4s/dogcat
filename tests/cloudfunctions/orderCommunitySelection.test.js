const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const id = 'map_community_' + 'd'.repeat(24)
const community = (extra = {}) => ({ _id: id, key: 'service_community', enabled: true, city: '成都市', cityKey: '成都',
  district: '双流区', name: '双流区红瓦小区（华府大道二段）', aliases: ['红瓦小区（华府大道二段）'],
  latitude: 30.5, longitude: 104, matchRadiusKm: 1, revision: 1, ...extra })
const orderData = (extra = {}) => ({ petId: 'pet', serviceTypes: ['visit_fee', 'walk'], publishMode: 'open', city: '成都市',
  serviceAddress: '红瓦小区（华府大道二段）', addressDetail: '1栋', doorplate: 'PRIVATE-102',
  addressLatitude: 30.519, addressLongitude: 104, startTime: '2099-12-01 10:00', endTime: '2099-12-01 11:00', ...extra })
function fixture(rows = [community()]) {
  const db = createCollectionStore({ users: [
    { _id: 'client', openid: 'client', roles: ['client'], status: 'active', phone: '13800000000' },
    { _id: 'staff', openid: 'staff', roles: ['staff'], status: 'active' },
    { _id: 'admin', openid: 'admin', roles: ['admin'], status: 'active' }],
    pets: [{ _id: 'pet', openid: 'client', name: '狗狗', species: 'dog', weight: 10 }], orders: [], user_addresses: [],
    staff_profiles: [{ _id: 'profile', openid: 'staff', auditStatus: 'approved', staffLevel: 'certified',
      serviceCity: '成都市', serviceRadiusKm: 5 }], platform_configs: rows })
  const context = createContext({ db, cloud: { openapi: { security: { msgSecCheck: async () => ({ result: { suggest: 'pass' } }) } } } })
  const handler = require('../../cloudfunctions/api/handlers/communityMap')(context)
  const admin = (action, data) => context.runAdminRequest('communityMap', action, data, () => handler('admin', action, data))
  const api = loadCloudFunction('api', db, 'client')
  return { db, context, handler, admin, create: data => api.main({ module: 'order', action: 'createOrder', data }),
    rebook: orderId => api.main({ module: 'order', action: 'prepareRebook', data: { orderId } }) }
}
const save = row => ({ id: row._id, name: row.name, city: row.city, district: row.district, aliases: row.aliases,
  latitude: row.latitude, longitude: row.longitude, enabled: true, matchRadiusKm: row.matchRadiusKm,
  revision: row.revision, confirmPublic: true })

test('Hongwa estate names match with aliases or an administrative prefix, but old automatic distance still applies', () => {
  const { context } = fixture()
  const source = orderData({ addressLatitude: 30.501 })
  assert.equal(context.matchMapCommunity(source, [community()])._id, id)
  assert.equal(context.matchMapCommunity(source, [community({ aliases: [] })])._id, id)
  assert.equal(context.matchMapCommunity(orderData(), [community()]), null)
  assert.equal(context.matchMapCommunity({ ...source, addressLatitude: 0 }, [community()]), null)
  assert.equal(context.matchMapCommunity({ ...source, serviceAddress: '红瓦小区二期' }, [community()]), null)
})

test('nearby choices are enabled public points within three kilometres, sorted and paginated with alias search', async () => {
  const rows = Array.from({ length: 25 }, (_, i) => community({ _id: 'map_community_' + i.toString(16).padStart(24, '0'), latitude: 30.5 + i / 10000 }))
  rows.push(community({ _id: 'far', latitude: 31 }), community({ _id: 'disabled', enabled: false }),
    community({ _id: 'other-city', cityKey: '上海', city: '上海市' }))
  const { handler, admin } = fixture(rows)
  const data = { city: '成都', latitude: 30.5, longitude: 104 }
  const first = await handler('client', 'nearbyForOrder', data)
  const next = await handler('client', 'nearbyForOrder', { ...data, offset: 20 })
  assert.equal(first.total, 25); assert.equal(first.list.length, 20); assert.equal(next.list.length, 5)
  assert.equal(first.list[0].distanceKm, 0); assert.equal(first.radiusKm, 3)
  assert.equal(new Set([...first.list, ...next.list].map(row => row._id)).size, 25)
  assert.equal((await handler('client', 'nearbyForOrder', { ...data, keyword: '红瓦小区' })).total, 25)
  assert.equal((await handler('client', 'nearbyForOrder', { ...data, keyword: '红瓦小区(华府大道二段)' })).total, 25)
  assert.equal((await handler('client', 'catalog', { city: '成都市', keyword: '红瓦小区(华府大道二段)' })).total, 26)
  assert.ok((await admin('listAdmin', { city: '成都市', keyword: '红瓦小区(华府大道二段)', paginated: true })).list.length > 0)
  assert.equal(first.list[0].aliases, undefined)
})

test('choosing an estate records the public ID, keeps the private service address, and counts the paid order on the map', async () => {
  const { create, db, handler } = fixture()
  const result = await create(orderData({ serviceAddress: '附近临街商铺', serviceCommunityId: id, serviceCommunityName: 'unused client label', saveAddress: true }))
  assert.equal(result.ok, true, result.message)
  assert.equal(result.data.serviceCommunityId, id)
  assert.equal(result.data.serviceCommunityName, community().name)
  assert.equal(result.data.serviceCommunitySelection, 'client')
  assert.equal(result.data.serviceAddress, '附近临街商铺'); assert.equal(result.data.addressLatitude, 30.519)
  assert.equal(db.state.user_addresses[0].city, '成都市')
  assert.equal(db.state.user_addresses[0].latitude, 30.519)
  db.state.orders[0].status = 'paid'; db.state.orders[0].paymentStatus = 'paid'
  const map = await handler('staff', 'listOrders', { city: '成都市', communityId: id })
  assert.equal(map.total, 1); assert.equal(map.unmatchedCount, 0)
  assert.equal(JSON.stringify(map).includes('PRIVATE-102'), false)
})

test('selected estates must remain enabled, in the service city and within the nearby choice radius', async () => {
  const { context } = fixture()
  for (const source of [orderData({ serviceCommunityId: id, addressLatitude: 31 }),
    orderData({ serviceCommunityId: id, city: '上海市' }), orderData({ serviceCommunityId: id, addressLatitude: 0 })]) {
    await assert.rejects(context.resolveOrderCommunity(source), /附近3公里|城市不一致/)
  }
  const { context: disabled } = fixture([community({ enabled: false })])
  await assert.rejects(disabled.resolveOrderCommunity(orderData({ serviceCommunityId: id })), /停用或不存在/)
  const resolved = await context.resolveOrderCommunity(orderData({ serviceCommunityId: id, city: '' }))
  assert.equal(resolved.city, '成都市')
})

test('a new-estate application is deduplicated, reviewed in the pending queue and connects an existing paid order after approval', async () => {
  const { handler, admin, create, context, db } = fixture([])
  const application = await handler('client', 'applyCommunity', { name: '红瓦小区（华府大道二段）', city: '成都市', district: '双流区' })
  const again = await handler('client', 'applyCommunity', { name: '红瓦小区(华府大道二段)', city: '成都', district: '双流区' })
  assert.equal(again.applicationId, application.applicationId)
  const stored = db.state.platform_configs.find(row => row._id === application.applicationId)
  assert.equal(stored.latitude, undefined); assert.equal(stored.openid, undefined); assert.equal(stored.doorplate, undefined)
  assert.equal((await context.readMapCommunities('成都市')).length, 0)
  const created = await create(orderData({ serviceAddress: '临街商铺', serviceCommunityApplicationId: application.applicationId }))
  assert.equal(created.ok, true, created.message)
  db.state.orders[0].status = 'paid'; db.state.orders[0].paymentStatus = 'paid'
  const before = await handler('staff', 'listOrders', { city: '成都市' })
  assert.equal(before.communities.length, 0); assert.equal(before.unmatchedCount, 1)
  const pending = await admin('listAdmin', { view: 'pending', city: '成都市', paginated: true })
  const candidate = pending.list.find(row => row.applicationIds.includes(application.applicationId))
  assert.equal(pending.total, 1)
  assert.equal(candidate.orderCount, 1)
  assert.equal(candidate.applicationCount, 1)
  const approved = await admin('saveAdmin', { ...save(community()), id: undefined, revision: undefined,
    applicationIds: candidate.applicationIds, requestId: 'approve_hongwa_123' })
  assert.equal(db.state.platform_configs.find(row => row._id === application.applicationId).status, 'resolved')
  const after = await handler('staff', 'listOrders', { city: '成都市', communityId: approved.id })
  assert.equal(after.total, 1); assert.equal(after.unmatchedCount, 0)
  assert.equal(db.state.orders[0].serviceAddress, '临街商铺')
  assert.equal((await admin('listAdmin', { view: 'pending', city: '成都市', paginated: true })).total, 0)
})

test('applications can be linked to an existing public point without invalidating sitter consent, and save retries remain idempotent', async () => {
  const { handler, admin, db } = fixture()
  const application = await handler('client', 'applyCommunity', { name: '红瓦小区', city: '成都市' })
  const data = { ...save(community()), applicationIds: [application.applicationId], requestId: 'review_existing_123' }
  await admin('saveAdmin', data); await admin('saveAdmin', data)
  const row = db.state.platform_configs.find(row => row._id === id)
  assert.equal(row.revision, 1); assert.deepEqual(row.applicationIds, [application.applicationId])
  const resolved = await handler('client', 'applyCommunity', { name: '红瓦小区', city: '成都市' })
  assert.equal(resolved.status, 'resolved'); assert.equal(resolved.community._id, id)
})

test('new-estate applications request a public name and a city rather than a household description', async () => {
  const { handler } = fixture()
  await assert.rejects(handler('client', 'applyCommunity', { name: '红瓦小区1栋102室', city: '成都市' }), /不要填写/)
  await assert.rejects(handler('client', 'applyCommunity', { name: '红瓦小区', city: '' }), /所在城市/)
})

test('saved address city follows location edits, preserves an unchanged legacy city and supports explicitly clearing it', async () => {
  const { context, db } = fixture()
  const base = { serviceAddress: '红瓦小区', city: '成都市', addressDetail: '1栋', doorplate: '101', latitude: 30.5, longitude: 104 }
  const user = { _id: 'client' }
  const created = await context.saveUserAddress('client', user, base)
  const { city, ...legacy } = { ...base, id: created._id }
  await context.saveUserAddress('client', user, legacy)
  assert.equal(db.state.user_addresses[0].city, '成都市')
  await context.saveUserAddress('client', user, { ...legacy, city: '' })
  assert.equal(db.state.user_addresses[0].city, '')
  await context.saveUserAddress('client', user, { ...base, id: created._id })
  await context.saveUserAddress('client', user, { ...legacy, serviceAddress: '其他地点', latitude: 31.2, longitude: 121.5 })
  assert.equal(db.state.user_addresses[0].city, '')
  await context.saveUserAddress('client', user, { ...legacy, serviceAddress: '上海新址', latitude: 31.2, longitude: 121.5, city: '上海市' })
  assert.equal(db.state.user_addresses[0].city, '上海市')
})

test('a direct booking remains creatable after its earlier public-map choice has been disabled', async () => {
  const { db, create } = fixture([community({ enabled: false })])
  Object.assign(db.state.staff_profiles[0], { serviceAddress: '红瓦小区', serviceLatitude: 30.5, serviceLongitude: 104,
    weeklySchedule: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map(day => [day, [{ start: 0, end: 24 }]])) })
  const result = await create(orderData({ publishMode: 'direct', staffProfileId: 'profile', serviceCommunityId: id }))
  assert.equal(result.ok, true, result.message)
  assert.equal(result.data.publishMode, 'direct')
  assert.equal(result.data.serviceCommunityId, undefined)
})

test('rebooking retains an explicit nearby estate even when the service POI name cannot match automatically', async () => {
  const { create, rebook, db, handler } = fixture()
  const first = await create(orderData({ serviceAddress: '附近临街商铺', serviceCommunityId: id }))
  assert.equal(first.ok, true, first.message)
  const template = await rebook(first.data._id)
  assert.equal(template.ok, true, template.message)
  assert.equal(template.data.serviceCommunityId, id)
  assert.equal(template.data.serviceCommunitySelection, 'client')
  assert.equal(template.data.orderCommunity.name, community().name)
  assert.equal(template.data.orderCommunity.aliases, undefined)
  assert.equal(template.data.orderCommunity.applicationIds, undefined)
  assert.equal(template.data.addressLatitude, 30.519)
  const second = await create(orderData({ ...template.data }))
  assert.equal(second.ok, true, second.message)
  for (const order of db.state.orders) Object.assign(order, { status: 'paid', paymentStatus: 'paid' })
  assert.equal((await handler('staff', 'listOrders', { city: '成都市', communityId: id })).total, 2)
})

test('rebooking retains pending applications and restores the current public point after approval', async () => {
  const { create, rebook, handler, admin } = fixture()
  const application = await handler('client', 'applyCommunity', { name: '红瓦小区', city: '成都市', district: '双流区' })
  const first = await create(orderData({ serviceAddress: '临街商铺', serviceCommunityApplicationId: application.applicationId }))
  assert.equal(first.ok, true, first.message)
  const pending = await rebook(first.data._id)
  assert.equal(pending.ok, true, pending.message)
  assert.equal(pending.data.serviceCommunityApplicationId, application.applicationId)
  assert.deepEqual(pending.data.orderCommunityApplication, { name: '红瓦小区', city: '成都市', district: '双流区', status: 'pending' })
  assert.equal(pending.data.orderCommunity, null)
  await admin('saveAdmin', { ...save(community()), applicationIds: [application.applicationId], requestId: 'rebook_approval_123' })
  const approved = await rebook(first.data._id)
  assert.equal(approved.ok, true, approved.message)
  assert.equal(approved.data.serviceCommunityId, id)
  assert.equal(approved.data.serviceCommunityApplicationId, application.applicationId)
  assert.equal(approved.data.orderCommunity._id, id)
  assert.equal(approved.data.orderCommunityApplication, null)
})

test('invalid historical choices are cleared without blocking rebooking, and automatic matches are not promoted to explicit choices', async () => {
  const { rebook, db } = fixture()
  const base = { ...orderData(), _id: 'history', clientOpenid: 'client', status: 'completed',
    serviceCommunityId: id, serviceCommunitySelection: 'client' }
  db.state.orders.push(base)
  for (const changes of [ { city: '上海市' }, { addressLatitude: 31 }, { addressLatitude: 0 },
    { serviceCommunityId: 'map_community_' + 'e'.repeat(24) }, { serviceCommunityApplicationId: 'map_application_' + 'a'.repeat(32) } ]) {
    db.state.orders[0] = { ...base, ...changes }
    const result = await rebook('history')
    assert.equal(result.ok, true, result.message)
    assert.equal(result.data.serviceCommunityId, undefined)
    assert.equal(result.data.serviceCommunityApplicationId, undefined)
    assert.match(result.data.communitySelectionNotice, /已失效/)
    assert.equal(result.data.serviceAddress, base.serviceAddress)
  }
  db.state.orders[0] = base
  db.state.platform_configs.find(row => row._id === id).enabled = false
  assert.match((await rebook('history')).data.communitySelectionNotice, /已失效/)
  db.state.orders[0] = { ...base, serviceCommunitySelection: undefined }
  const legacy = await rebook('history')
  assert.equal(legacy.ok, true)
  assert.equal(legacy.data.serviceCommunityId, undefined)
  assert.equal(legacy.data.orderCommunity, undefined)
})

test('database failures during rebooking are propagated instead of being treated as an invalid historical choice', async () => {
  const { context, db } = fixture()
  const collection = db.collection.bind(db)
  db.collection = name => name === 'platform_configs'
    ? { doc: () => ({ get: async () => { throw new Error('database temporarily unavailable') } }) }
    : collection(name)
  await assert.rejects(context.prepareRebookCommunity(orderData({ serviceCommunityId: id, serviceCommunitySelection: 'client' })), /database temporarily unavailable/)
})

test('expired or conflicting applications cannot become order map associations', async () => {
  const { context, db } = fixture()
  const applicationId = 'map_application_' + 'a'.repeat(32)
  const application = { _id: applicationId, key: 'map_community_application', city: '成都市', cityKey: '成都', name: '红瓦小区', status: 'rejected' }
  db.state.platform_configs.push(application)
  const source = orderData({ serviceCommunityApplicationId: applicationId })
  await assert.rejects(context.resolveOrderCommunity(source), /已失效/)
  Object.assign(application, { status: 'resolved', serviceCommunityId: '' })
  await assert.rejects(context.resolveOrderCommunity(source), /关联已变化/)
  application.serviceCommunityId = 'map_community_' + 'e'.repeat(24)
  await assert.rejects(context.resolveOrderCommunity({ ...source, serviceCommunityId: id }), /关联已变化/)
})
