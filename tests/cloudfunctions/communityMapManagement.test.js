const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const { communityName, communityAddress } = require('../../cloudfunctions/api/utils/communityNames')
const { mapConcurrent } = require('../../cloudfunctions/api/utils/mapCards')

const id = 'map_community_' + 'a'.repeat(24)
const publicRow = (extra = {}) => ({ _id: id, key: 'service_community', name: '阳光花园', city: '上海市', cityKey: '上海', district: '浦东新区',
  latitude: 31.2, longitude: 121.5, matchRadiusKm: 1, enabled: true, aliases: [], revision: 1, ...extra })
const order = (extra = {}) => ({ _id: 'order', status: 'paid', publishMode: 'open', city: '上海市', serviceAddress: '阳光花园南门',
  addressLatitude: 31.201, addressLongitude: 121.501, ...extra })
const staff = (extra = {}) => ({ _id: 'profile', openid: 'staff', auditStatus: 'approved', serviceCity: '上海市', serviceAddress: '阳光花园',
  serviceLatitude: 31.201, serviceLongitude: 121.501, publicMapEnabled: false, ...extra })
function fixture(data = {}) {
  const db = createCollectionStore({ users: [{ _id: 'admin', openid: 'admin', roles: ['admin'], status: 'active' },
    { _id: 'staff-user', openid: 'staff', roles: ['staff'], status: 'active' }], orders: [], staff_profiles: [], platform_configs: [], ...data })
  const context = createContext({ db, cloud: { openapi: { security: { msgSecCheck: async () => ({ errCode: 0, result: { suggest: 'pass' } }) } } } })
  const handler = require('../../cloudfunctions/api/handlers/communityMap')(context)
  const admin = (action, value = {}) => context.runAdminRequest('communityMap', action, value, () => handler('admin', action, value))
  return { db, context, handler, admin }
}
const saveData = row => ({ id: row._id, name: row.name, city: row.city, district: row.district || '', latitude: row.latitude,
  longitude: row.longitude, enabled: row.enabled, aliases: row.aliases || [], matchRadiusKm: row.matchRadiusKm, revision: row.revision,
  ...(row.editVersion ? { editVersion: row.editVersion } : {}), confirmPublic: true })

test('entrances, full-width numbers, building suffixes and city prefixes match without per-door aliases', () => {
  const { context } = fixture()
  for (const name of ['阳光花园南门', '阳光花园（西门）', '阳光花园１２号楼２单元１６０２室', '上海市浦东新区阳光花园北门',
    '阳光花园1号楼（南门）', '阳光花园-1号楼-2单元1602室', '阳光花园（南门）1号楼']) {
    assert.equal(context.matchMapCommunity(order({ serviceAddress: name }), [publicRow()])?._id, id, name)
  }
  for (const suffix of ['一期', '二期', '南区', '北区']) {
    assert.equal(communityName('阳光花园' + suffix + '南门'), '阳光花园' + suffix)
    assert.equal(context.matchMapCommunity(order({ serviceAddress: '阳光花园' + suffix }), [publicRow()]), null)
  }
  assert.equal(context.matchMapCommunity(order({ addressLatitude: 30 }), [publicRow()]), null)
  assert.equal(context.matchMapCommunity(order({ serviceAddress: '上海市浦东新区阳光花园' }), [publicRow({ city: '上海' })])?._id, id)
})

test('pending list groups unmapped addresses and excludes already matched, completed and deleted records', async () => {
  const { admin, db } = fixture({ platform_configs: [publicRow({ name: '已维护花园' })],
    orders: [order(), order({ _id: 'o2', serviceAddress: '阳光花园东门' }), order({ _id: 'o3', serviceAddress: '已维护花园' }),
      order({ _id: 'o4', status: 'completed' }), order({ _id: 'o5', deletedAt: new Date() })], staff_profiles: [staff()] })
  const before = JSON.stringify([db.state.orders, db.state.staff_profiles])
  const result = await admin('listAdmin', { view: 'pending' })
  assert.equal(result.total, 1); assert.equal(result.list[0].name, '阳光花园')
  assert.equal(result.list[0].orderCount, 2); assert.equal(result.list[0].staffCount, 1)
  for (const key of ['addressLatitude', 'serviceLatitude', 'openid', 'latitude']) assert.equal(JSON.stringify(result).includes(key), false)
  assert.equal(JSON.stringify([db.state.orders, db.state.staff_profiles]), before)
})

test('one public point setup clears matching candidates without rewriting addresses or publishing staff consent', async () => {
  const { admin, db, context } = fixture({ orders: [order()], staff_profiles: [staff()] })
  const saved = await admin('saveAdmin', { ...saveData(publicRow()), id: undefined, revision: undefined })
  assert.ok(saved.id)
  const result = await admin('listAdmin', { view: 'pending', city: '上海市' })
  assert.equal(result.total, 0)
  assert.equal(db.state.orders[0].serviceAddress, '阳光花园南门')
  assert.equal(db.state.staff_profiles[0].publicMapEnabled, false)
  const resolved = await context.resolveOrderCommunity(db.state.orders[0])
  assert.equal(resolved.serviceCommunityId, saved.id)
})

test('unmatched existing and disabled communities are linked for correction and missing cities are counted', async () => {
  const { admin } = fixture({ platform_configs: [publicRow({ enabled: false })], orders: [order(), order({ _id: 'o2', city: '', serviceAddress: '城市未填写花园' })] })
  const result = await admin('listAdmin', { view: 'pending' })
  assert.equal(result.list[0].existingId, id); assert.match(result.list[0].reason, /未启用/)
  assert.equal(result.missingCityCount, 1)
})

test('alias and matching-radius edits retain public consent revision while edit conflicts remain detectable', async () => {
  const { admin, db } = fixture({ platform_configs: [publicRow()] })
  await admin('saveAdmin', { ...saveData(publicRow()), aliases: ['阳光苑'], matchRadiusKm: 1.2 })
  const current = db.state.platform_configs[0]
  assert.equal(current.revision, 1); assert.equal(current.editVersion, 2)
  await assert.rejects(admin('saveAdmin', { ...saveData(publicRow()), aliases: ['旧修改'] }), /已更新/)
  const rows = await admin('listAdmin', { paginated: true })
  assert.equal(rows.list[0].editVersion, 2)
  await admin('saveAdmin', { ...saveData(rows.list[0]), aliases: ['阳光苑', '阳光小区'] })
  assert.equal(db.state.platform_configs[0].revision, 1)
  assert.equal(db.state.platform_configs[0].editVersion, 3)
})

test('changing a public point increments the consent revision but saving unchanged data does not', async () => {
  const { admin, db } = fixture({ platform_configs: [publicRow()] })
  await admin('saveAdmin', saveData(publicRow()))
  assert.equal(db.state.platform_configs[0].revision, 1)
  const rows = await admin('listAdmin', { paginated: true })
  await admin('saveAdmin', { ...saveData(rows.list[0]), latitude: 31.2005 })
  assert.equal(db.state.platform_configs[0].revision, 2)
})

test('repeated point creation does not produce duplicate nearby community records', async () => {
  const { admin, db } = fixture()
  const data = { ...saveData(publicRow()), id: undefined, revision: undefined }
  await admin('saveAdmin', data)
  await assert.rejects(admin('saveAdmin', data), /已存在/)
  await assert.rejects(admin('saveAdmin', { ...data, name: '阳光花园南门', latitude: 31.2001 }), /同名/)
  assert.equal(db.state.platform_configs.filter(row => row.key === 'service_community').length, 1)
})

test('admin catalog supports city, alias search, pagination and fetching an existing candidate target', async () => {
  const rows = Array.from({ length: 35 }, (_, i) => publicRow({ _id: 'map_community_' + i.toString(16).padStart(24, '0'), name: `花园${String(i).padStart(2, '0')}`, aliases: [`旧名${i}`] }))
  const { admin } = fixture({ platform_configs: [...rows, publicRow({ city: '深圳市', cityKey: '深圳' })] })
  const first = await admin('listAdmin', { city: '上海市', paginated: true })
  const second = await admin('listAdmin', { city: '上海市', paginated: true, offset: 30 })
  assert.equal(first.total, 35); assert.equal(first.list.length, 30); assert.equal(second.list.length, 5)
  const named = await admin('listAdmin', { city: '上海市', keyword: '旧名34', paginated: true })
  assert.equal(named.list[0]._id, rows[34]._id)
  const single = await admin('listAdmin', { id: rows[34]._id, paginated: true })
  assert.equal(single.list[0]._id, rows[34]._id)
})

test('staff recommendations use the own fixed address, paginate nearest points and exclude distant ones', async () => {
  const rows = Array.from({ length: 35 }, (_, i) => publicRow({ _id: 'map_community_' + i.toString(16).padStart(24, '0'), name: `花园${i}`, latitude: 31.2 + i / 100000 }))
  const { handler } = fixture({ staff_profiles: [staff()], platform_configs: [...rows, publicRow({ _id: 'map_community_' + 'f'.repeat(24), latitude: 32 })] })
  const first = await handler('staff', 'catalog', { recommended: true, latitude: 32, longitude: 120, city: '深圳市' })
  const second = await handler('staff', 'catalog', { recommended: true, offset: 30 })
  assert.equal(first.total, 35); assert.equal(first.list.length, 30); assert.equal(second.list.length, 5)
  assert.equal(first.hasMore, true)
  assert.ok(first.list.every(row => row.city === '上海市'))
  assert.equal(JSON.stringify(first).includes('serviceLatitude'), false)
})

test('map order enrichment bounds concurrency and keeps source ordering despite out-of-order completion', async () => {
  let active = 0, peak = 0
  const rows = Array.from({ length: 40 }, (_, i) => i)
  const result = await mapConcurrent(rows, async value => {
    active++; peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, value % 3))
    active--; return value * 2
  })
  assert.equal(peak, 12); assert.deepEqual(result, rows.map(value => value * 2))
})

test('order aggregation and task matching share a single public community snapshot per request', async () => {
  const { handler, context } = fixture({ platform_configs: [publicRow()], staff_profiles: [staff({ staffLevel: 'certified' })],
    orders: [order({ startTime: '2099-12-01 10:00', endTime: '2099-12-01 11:00', paymentStatus: 'paid', payAmount: 50 })] })
  let snapshots = 0, matchers = 0
  const read = context.readMapCommunities
  const create = context.createCommunityMatcher
  context.readMapCommunities = async city => { snapshots++; return read(city) }
  context.createCommunityMatcher = rows => { matchers++; return create(rows) }
  const result = await handler('staff', 'listOrders', { city: '上海市', communityId: id })
  assert.equal(result.total, 1); assert.equal(snapshots, 1); assert.equal(matchers, 1)
})

test('indexed matching retains aliases, location checks and ambiguous-name behavior', () => {
  const { context } = fixture()
  const otherId = 'map_community_' + 'b'.repeat(24)
  const rows = [publicRow({ aliases: ['阳光苑'] }), publicRow({ _id: otherId, latitude: 31.202 }),
    publicRow({ _id: 'map_community_' + 'c'.repeat(24), city: '南宁市', district: '青秀区', enabled: false })]
  const matcher = context.createCommunityMatcher(rows)
  for (const source of [order(), order({ serviceAddress: '上海市浦东新区阳光苑1号楼（南门）' }),
    order({ serviceCommunityId: id }), order({ addressLatitude: 0 }), order({ addressLatitude: 32 }),
    order({ city: '南宁市', serviceAddress: '广西壮族自治区南宁市青秀区阳光花园' })]) {
    const expected = rows.filter(row => context.publicCommunity(row) &&
      context.normalizeCityName(row.city) === context.normalizeCityName(source.city) &&
      (source.serviceCommunityId ? row._id === source.serviceCommunityId : context.sameCommunityName(source.serviceAddress, row)) &&
      context.hasCoordinate(source.addressLatitude, source.addressLongitude) &&
      context.calcDistanceKm(source.addressLatitude, source.addressLongitude, row.latitude, row.longitude) <= row.matchRadiusKm)
    assert.equal(matcher.match(source)?._id || null, expected.length === 1 ? expected[0]._id : null)
  }
  assert.equal(matcher.match(order()), null)
  assert.equal(matcher.match(order({ serviceAddress: '上海市浦东新区阳光苑北门' }))._id, id)
  assert.equal(matcher.findByName('广西壮族自治区南宁市青秀区阳光花园南门', '南宁市').length, 1)
})

test('a request matcher does not scan the community catalog again for each unmatched address', () => {
  const { context } = fixture()
  let reads = 0
  const rows = Array.from({ length: 1000 }, (_, i) => {
    const row = publicRow({ _id: String(i) })
    Object.defineProperty(row, 'name', { get() { reads++; return '花园' + i } })
    return row
  })
  const matcher = context.createCommunityMatcher(rows), indexedReads = reads
  for (let i = 0; i < 2000; i++) assert.equal(matcher.match(order({ serviceAddress: '尚未维护' + i })), null)
  assert.equal(reads, indexedReads)
})

test('admin save receipts make lost-response create and edit retries idempotent', async () => {
  const { admin, db } = fixture()
  const data = { ...saveData(publicRow()), id: undefined, revision: undefined, requestId: 'community_create_123' }
  const first = await admin('saveAdmin', data)
  assert.deepEqual(await admin('saveAdmin', data), first)
  let row = db.state.platform_configs.find(row => row._id === first.id)
  assert.equal(row.editVersion, 1)
  const edit = { ...saveData(row), aliases: ['旧名'], requestId: 'community_edit_123' }
  await admin('saveAdmin', edit)
  await admin('saveAdmin', edit)
  row = db.state.platform_configs.find(row => row._id === first.id)
  assert.equal(row.editVersion, 2); assert.equal(row.revision, 1)
  await assert.rejects(admin('saveAdmin', { ...edit, name: '改过的内容' }), /内容已变化/)
  await assert.rejects(admin('saveAdmin', { ...edit, requestId: 'community_stale_123' }), /已更新/)
  assert.equal((await admin('listAdmin', { paginated: true })).total, 1, 'receipts and locks are excluded from the catalog')
})

test('competing nearby creates recheck the city snapshot before committing', async () => {
  const { admin, db } = fixture()
  const data = { ...saveData(publicRow()), id: undefined, revision: undefined }
  const results = await Promise.allSettled([
    admin('saveAdmin', { ...data, requestId: 'community_concurrent_a' }),
    admin('saveAdmin', { ...data, latitude: 31.2001, requestId: 'community_concurrent_b' })
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.match(results.find(result => result.status === 'rejected').reason.message, /同名/)
  assert.equal(db.state.platform_configs.filter(row => row.key === 'service_community').length, 1)
})

test('the city limit rejects the 1001st point but still allows editing existing points', async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => publicRow({ _id: 'map_community_' + i.toString(16).padStart(24, '0'), name: `独立花园${i}` }))
  const { admin, db } = fixture({ platform_configs: rows })
  await assert.rejects(admin('saveAdmin', { ...saveData(publicRow()), id: undefined, revision: undefined }), /上限/)
  await admin('saveAdmin', { ...saveData(rows[0]), aliases: ['可编辑旧名'] })
  assert.equal(db.state.platform_configs.find(row => row._id === rows[0]._id).editVersion, 2)
  assert.equal(db.state.platform_configs.filter(row => row.key === 'service_community').length, 1000)
})

test('pending addresses with province, city and district prefixes share a usable public label', async () => {
  const { admin } = fixture({ orders: [order({ city: '上海', serviceAddress: '上海市浦东新区阳光花园1号楼（南门）' }),
    order({ _id: 'o2', serviceAddress: '阳光花园东门' }),
    order({ _id: 'o3', city: '上海', serviceAddress: '上海市浦东新区阳光花园（北门）' })], staff_profiles: [staff()] })
  const result = await admin('listAdmin', { view: 'pending' })
  assert.equal(result.total, 1)
  const candidate = result.list[0]
  assert.equal(candidate.name, '阳光花园'); assert.equal(candidate.district, '浦东新区')
  assert.equal(candidate.orderCount, 3); assert.equal(candidate.staffCount, 1)
  await admin('saveAdmin', { ...saveData(publicRow()), id: undefined, revision: undefined, name: candidate.name, city: candidate.city, district: candidate.district })
  assert.equal((await admin('listAdmin', { view: 'pending' })).total, 0)
})

test('candidate grouping separates known districts and preserves estate phases and areas', async () => {
  const { admin } = fixture({ orders: [order({ serviceAddress: '上海市浦东新区阳光花园' }),
    order({ _id: 'o2', serviceAddress: '上海市闵行区阳光花园' }), order({ _id: 'o3' }),
    order({ _id: 'o4', serviceAddress: '上海市阳光花园南区二期南门' }),
    order({ _id: 'o5', serviceAddress: '上海市阳光花园北区二期南门' })] })
  const result = await admin('listAdmin', { view: 'pending' })
  assert.equal(result.total, 5)
  const same = result.list.filter(row => row.name === '阳光花园')
  assert.deepEqual(same.map(row => row.district).sort(), ['', '浦东新区', '闵行区'].sort())
  assert.ok(result.list.some(row => row.name === '阳光花园南区二期'))
  assert.ok(result.list.some(row => row.name === '阳光花园北区二期'))
  assert.deepEqual(communityAddress('重庆市渝北区阳光花园', '重庆市'), { name: '阳光花园', district: '渝北区' })
  assert.deepEqual(communityAddress('广西壮族自治区南宁市青秀区阳光花园', '南宁'), { name: '阳光花园', district: '青秀区' })
  assert.deepEqual(communityAddress('上海花园南门', '上海市'), { name: '上海花园', district: '' })
})

test('a retry committed between the initial receipt and point reads is recognized for creates and edits', async () => {
  for (const editing of [false, true]) {
    const { admin, db } = fixture({ platform_configs: editing ? [publicRow()] : [] })
    const data = { ...saveData(publicRow()), ...(editing ? {} : { id: undefined, revision: undefined }), requestId: 'community_race_' + editing }
    const collection = db.collection.bind(db)
    let committed = false
    db.collection = name => {
      const query = collection(name), doc = query.doc.bind(query)
      query.doc = pointId => {
        const point = doc(pointId), get = point.get.bind(point)
        point.get = async () => {
          if (!committed && name === 'platform_configs' && /^map_community_[a-f0-9]{24}$/.test(pointId)) {
            committed = true
            await admin('saveAdmin', data)
          }
          return get()
        }
        return point
      }
      return query
    }
    const saved = await admin('saveAdmin', data)
    assert.equal(committed, true)
    const rows = db.state.platform_configs.filter(row => row.key === 'service_community')
    assert.equal(rows.length, 1); assert.equal(rows[0]._id, saved.id)
    assert.equal(rows[0].editVersion, editing ? 2 : 1)
  }
})

test('explicitly empty list references never fall back to an older saved GPS fix', async () => {
  const { context } = fixture({ staff_profiles: [staff({ staffLevel: 'certified', currentLatitude: 31.201, currentLongitude: 121.501 })],
    platform_configs: [publicRow()], orders: [order({ _id: 'normal', startTime: '2099-12-01 10:00', endTime: '2099-12-01 11:00', paymentStatus: 'paid', payAmount: 50 }),
      order({ _id: 'urgent', isUrgent: true, startTime: '2099-12-01 10:00', endTime: '2099-12-01 11:00', paymentStatus: 'paid', payAmount: 50 }),
      order({ _id: 'direct', publishMode: 'direct', requestedStaffOpenid: 'staff', startTime: '2099-12-01 10:00', endTime: '2099-12-01 11:00', paymentStatus: 'paid', payAmount: 50 })] })
  const handler = require('../../cloudfunctions/api/handlers/staff')(context)
  for (const action of ['listNearbyOrders', 'listDirectOrders', 'listUrgentOrders']) {
    const absent = await handler('staff', action, { latitude: 0, longitude: 0 })
    assert.ok(absent.length > 0, action)
    assert.ok(absent.every(row => row.distanceKm === null), action)
    const legacy = await handler('staff', action, {})
    assert.ok(legacy.every(row => Number.isFinite(row.distanceKm)), action)
  }
  const map = await handler('staff', 'listOrderMap', { city: '上海市', latitude: 0, longitude: 0, inServiceRange: true, communityId: id })
  assert.equal(map.total, 0)
})

test('city-filtered candidates include legacy province prefixes and exclude other cities', async () => {
  const { admin } = fixture({ orders: [order({ city: '广东省深圳市' }), order({ _id: 'other', city: '广东省广州市' })],
    staff_profiles: [staff({ serviceCity: '广东省深圳市' })] })
  const result = await admin('listAdmin', { view: 'pending', city: '深圳' })
  assert.equal(result.total, 1); assert.equal(result.list[0].orderCount, 1); assert.equal(result.list[0].staffCount, 1)
})

test('published sitters with legacy province-prefixed service cities remain visible on their city map', async () => {
  const { handler } = fixture({ platform_configs: [publicRow({ city: '深圳市', cityKey: '深圳', latitude: 22.5, longitude: 114 })],
    staff_profiles: [staff({ staffLevel: 'certified', serviceCity: '广东省深圳市', serviceLatitude: 22.501, serviceLongitude: 114.001,
      publicMapEnabled: true, publicServiceCommunityId: id, publicCommunityRevision: 1 })] })
  const result = await handler('client', 'listSitters', { city: '深圳市', communityId: id })
  assert.equal(result.total, 1); assert.equal(result.communities[0].count, 1)
})
