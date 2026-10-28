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

test('deleting a community is a versioned retirement and cannot be bypassed by editing or re-creation', async () => {
  const { admin, handler, db } = fixture({ platform_configs: [publicRow()], orders: [order()] })
  const saved = structuredClone(db.state.platform_configs[0])
  await assert.rejects(admin('deleteAdmin', { id, editVersion: 0 }), /已更新/)
  assert.equal(db.state.platform_configs[0].retiredAt, undefined)
  assert.deepEqual(await admin('deleteAdmin', { id, editVersion: 1 }), { id, retired: true })
  const retired = structuredClone(db.state.platform_configs[0])
  assert.equal(retired.enabled, false)
  assert.equal(retired.revision, saved.revision + 1)
  assert.equal(retired.editVersion, 2)
  assert.equal(db.state.orders[0].serviceAddress, '阳光花园南门')
  assert.equal((await admin('listAdmin', { view: 'catalog', paginated: true })).total, 0)
  assert.equal((await admin('listAdmin', { view: 'retired', paginated: true })).list[0].retiredAt != null, true)
  assert.deepEqual(await admin('deleteAdmin', { id, editVersion: 1 }), { id, retired: true })
  assert.deepEqual(db.state.platform_configs.find(row => row._id === id), retired)
  await assert.rejects(admin('saveAdmin', { ...saveData(retired), enabled: true }), /已删除/)
  await assert.rejects(admin('saveAdmin', { ...saveData(saved), id: undefined, latitude: 31.201 }), /已删除/)
  const application = await handler('staff', 'applyCommunity', { name: saved.name, city: saved.city, district: saved.district })
  assert.match(application.message, /已删除/)
  assert.equal(db.state.platform_configs.filter(row => row.key === 'map_community_application').length, 0)
  assert.equal((await handler('staff', 'nearbyForOrder', { city: saved.city, latitude: saved.latitude, longitude: saved.longitude })).total, 0)
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

const applicationData = { name: '阳光花园', city: '上海市', district: '浦东新区' }
const applicationRows = db => db.state.platform_configs.filter(row => row.key === 'map_community_application')
const applicationNotices = db => (db.state.system_notifications || []).filter(row => row.extra?.applicationId)
const newPointData = () => ({ ...saveData(publicRow()), id: undefined, revision: undefined })
function applicationFixture(data = {}) {
  const f = fixture(data)
  f.db.state.users.push(...['client-a', 'client-b'].map(openid => ({ _id: openid, openid, roles: ['client'], status: 'active' })))
  return { ...f, apply: (openid = 'client-a', value = {}) => f.handler(openid, 'applyCommunity', { ...applicationData, ...value }) }
}

// Pause the first transaction after its caller has read the city catalog, then
// commit the competing operation. The paused request must discard its stale scan.
async function commitSecondBeforeFirst(db, first, second) {
  const run = db.runTransaction.bind(db)
  let enter, release, transactions = 0
  const entered = new Promise(resolve => { enter = resolve })
  const released = new Promise(resolve => { release = resolve })
  db.runTransaction = async callback => {
    if (++transactions === 1) { enter(); await released }
    return run(callback)
  }
  const firstResult = first()
  await entered
  let secondResult
  try { secondResult = await second() } finally { release() }
  return { first: await firstResult, second: secondResult, transactions }
}

test('applications distinguish creation, own retry and another applicant without replacing the first applicant', async () => {
  const { apply, db } = applicationFixture()
  const created = await apply()
  assert.equal(created.status, 'pending'); assert.equal(created.outcome, 'created')
  const original = structuredClone(applicationRows(db)[0])
  const own = await apply(), other = await apply('client-b')
  assert.equal(own.status, 'pending'); assert.equal(own.outcome, 'self_duplicate')
  assert.equal(other.status, 'pending'); assert.equal(other.outcome, 'other_duplicate')
  assert.equal(own.applicationId, created.applicationId); assert.equal(other.applicationId, created.applicationId)
  assert.deepEqual(applicationRows(db), [original])
  assert.equal(original.firstApplicantOpenid, 'client-a')
  assert.deepEqual(applicationNotices(db), [])
})

test('maintained enabled and disabled communities return existing without creating applications', async () => {
  for (const enabled of [true, false]) {
    const { apply, db } = applicationFixture({ platform_configs: [publicRow({ enabled })] })
    const result = await apply()
    assert.equal(result.status, 'existing'); assert.equal(result.outcome, 'existing')
    assert.equal(result.applicationId, undefined)
    if (enabled) assert.equal(result.community._id, id)
    else assert.match(result.message, /暂未启用/)
    assert.deepEqual(applicationRows(db), [])
  }
})

test('approved applications retain resolved history and only notify their original applicant', async () => {
  const { apply, admin, db } = applicationFixture()
  const created = await apply()
  await apply('client-b')
  const saved = await admin('saveAdmin', { ...newPointData(), applicationIds: [created.applicationId] })
  const history = structuredClone(applicationRows(db))
  for (const openid of ['client-a', 'client-b']) {
    const result = await apply(openid)
    assert.equal(result.status, 'resolved'); assert.equal(result.outcome, 'existing')
    assert.equal(result.applicationId, created.applicationId); assert.equal(result.community._id, saved.id)
  }
  assert.deepEqual(applicationRows(db), history)
  assert.equal(history[0].status, 'resolved'); assert.equal(history[0].serviceCommunityId, saved.id)
  const notices = applicationNotices(db)
  assert.equal(notices.length, 1); assert.equal(notices[0].targetOpenid, 'client-a')
  assert.equal(notices[0].extra.status, 'resolved'); assert.equal(notices[0].extra.communityId, saved.id)
  await assert.rejects(admin('rejectApplication', { applicationIds: [created.applicationId], reason: '不能重复处理' }), /已处理/)
  assert.deepEqual(applicationRows(db), history)
  assert.equal(applicationNotices(db).length, 1)
})

test('pending counts only count pending applications and never scan community candidates', async () => {
  const { apply, admin, db, context } = applicationFixture({ orders: [order()], staff_profiles: [staff()], platform_configs: [publicRow({ name: '已维护花园' })] })
  const pending = await apply()
  const rejected = await apply('client-b', { name: '驳回花园' })
  await admin('rejectApplication', { applicationIds: [rejected.applicationId], reason: '名称不实' })
  const resolved = await apply('client-b', { name: '通过花园' })
  await admin('saveAdmin', { ...newPointData(), name: '通过花园', applicationIds: [resolved.applicationId] })
  // A non-application row with the same status must not inflate the badge.
  db.state.platform_configs.push({ _id: 'unrelated', key: 'unrelated_config', status: 'pending' })
  context.readCommunityCandidates = async () => { assert.fail('count must not read order/staff candidates') }
  const collection = db.collection.bind(db)
  let counts = 0
  db.collection = name => {
    const query = collection(name), where = query.where.bind(query)
    query.where = condition => {
      const filtered = where(condition)
      if (name === 'platform_configs') {
        assert.deepEqual(condition, { key: 'map_community_application', status: 'pending' })
        const count = filtered.count.bind(filtered)
        filtered.count = async () => { counts++; return count() }
        filtered.get = async () => { assert.fail('count must not fetch application rows') }
      }
      return filtered
    }
    return query
  }
  assert.deepEqual(await admin('listAdmin', { pendingCountsOnly: true, view: 'pending', city: '深圳市' }), { pendingApplicationCount: 1 })
  assert.equal(counts, 1); assert.equal(applicationRows(db).find(row => row._id === pending.applicationId).status, 'pending')
})

test('list-only administrators may count but need the explicit reject permission to reject', async () => {
  const { apply, admin, db } = applicationFixture({
    admin_access_config: [{ _id: 'policy', enabled: true, ownerOpenid: 'owner' }],
    admin_groups: [{ _id: 'map-reader', enabled: true, permissions: ['communityMap.listAdmin'] }],
    admin_memberships: [{ _id: 'admin', groupIds: ['map-reader'] }]
  })
  const created = await apply()
  assert.deepEqual(await admin('listAdmin', { pendingCountsOnly: true }), { pendingApplicationCount: 1 })
  const data = { applicationIds: [created.applicationId], reason: '公共名称无法核验' }
  await assert.rejects(admin('rejectApplication', data), { code: 'ADMIN_FORBIDDEN' })
  assert.equal(applicationRows(db)[0].status, 'pending'); assert.equal(applicationNotices(db).length, 0)
  const { tree } = require('../../cloudfunctions/api/config/adminPermissions')
  const permission = tree.flatMap(group => group.children).find(row => row.id === 'communityMap.rejectApplication')
  assert.ok(permission.requires.includes('communityMap.listAdmin'))
  db.state.admin_groups[0].permissions.push('communityMap.rejectApplication')
  assert.deepEqual(await admin('rejectApplication', data), { rejectedCount: 1 })
  assert.equal(applicationRows(db)[0].status, 'rejected')
  assert.deepEqual(await admin('listAdmin', { pendingCountsOnly: true }), { pendingApplicationCount: 0 })
})

test('reject requires a nonblank reason of at most 200 characters and same-reason retries are idempotent', async () => {
  const { apply, admin, db } = applicationFixture()
  const created = await apply(), applicationIds = [created.applicationId]
  for (const reason of [undefined, '', '  \n ', '驳'.repeat(201)]) {
    await assert.rejects(admin('rejectApplication', { applicationIds, reason }), /驳回原因.*200/)
    assert.equal(applicationRows(db)[0].status, 'pending'); assert.equal(applicationNotices(db).length, 0)
  }
  const reason = '驳'.repeat(200)
  assert.deepEqual(await admin('rejectApplication', { applicationIds: [...applicationIds, ...applicationIds], reason: ` ${reason} ` }), { rejectedCount: 1 })
  const history = structuredClone(applicationRows(db)), notices = structuredClone(applicationNotices(db))
  assert.equal(history[0].rejectionReason, reason); assert.equal(history[0].rejectedByOpenid, 'admin')
  assert.ok(history[0].rejectedAt)
  assert.deepEqual(await admin('rejectApplication', { applicationIds, reason }), { rejectedCount: 1 })
  await assert.rejects(admin('rejectApplication', { applicationIds, reason: '不同的原因' }), /已处理|原因已变化/)
  for (const openid of ['client-a', 'client-b']) {
    const result = await apply(openid)
    assert.equal(result.status, 'rejected'); assert.equal(result.outcome, 'rejected')
    assert.equal(result.applicationId, created.applicationId); assert.equal(result.rejectionReason, reason)
    assert.ok(result.message.includes(reason))
  }
  await assert.rejects(admin('saveAdmin', { ...newPointData(), applicationIds }), /已被驳回/)
  assert.deepEqual(applicationRows(db), history); assert.deepEqual(applicationNotices(db), notices)
  assert.equal(notices.length, 1); assert.equal(notices[0].targetOpenid, 'client-a')
  assert.equal(notices[0].extra.status, 'rejected'); assert.ok(notices[0].content.includes(reason))
})

test('notification failure rolls back rejection and the city catalog in the same transaction', async () => {
  const { apply, admin, db, context } = applicationFixture()
  const created = await apply()
  const before = structuredClone(db.state.platform_configs)
  const notify = context.notifyCommunityApplicationResult
  context.notifyCommunityApplicationResult = async (...args) => {
    await notify(...args)
    throw new Error('injected notification failure')
  }
  await assert.rejects(admin('rejectApplication', { applicationIds: [created.applicationId], reason: '无法核验' }), /injected notification failure/)
  assert.deepEqual(db.state.platform_configs, before); assert.equal(applicationNotices(db).length, 0)
  context.notifyCommunityApplicationResult = notify
  await admin('rejectApplication', { applicationIds: [created.applicationId], reason: '无法核验' })
  assert.equal(applicationRows(db)[0].status, 'rejected'); assert.equal(applicationNotices(db).length, 1)
})

test('batch rejection is atomic when another application has already been resolved', async () => {
  const { apply, admin, db } = applicationFixture()
  const pending = await apply(), resolved = await apply('client-b', { name: '已通过花园' })
  await admin('saveAdmin', { ...newPointData(), name: '已通过花园', applicationIds: [resolved.applicationId] })
  const before = structuredClone(db.state.platform_configs), notices = structuredClone(applicationNotices(db))
  await assert.rejects(admin('rejectApplication', { applicationIds: [pending.applicationId, resolved.applicationId], reason: '批量驳回' }), /已处理/)
  assert.deepEqual(db.state.platform_configs, before); assert.deepEqual(applicationNotices(db), notices)
})

test('rejecting an application preserves original orders, staff profiles and their pending candidates', async () => {
  const { apply, admin, db } = applicationFixture({ orders: [order()], staff_profiles: [staff()] })
  const created = await apply()
  const originals = structuredClone([db.state.orders, db.state.staff_profiles])
  await admin('rejectApplication', { applicationIds: [created.applicationId], reason: '需核对公共名称' })
  assert.deepEqual([db.state.orders, db.state.staff_profiles], originals)
  const result = await admin('listAdmin', { view: 'pending' })
  const candidate = result.list.find(row => row.name === '阳光花园')
  assert.ok(candidate); assert.equal(candidate.orderCount, 1); assert.equal(candidate.staffCount, 1)
  assert.deepEqual(await admin('listAdmin', { pendingCountsOnly: true }), { pendingApplicationCount: 0 })
})

test('concurrent approval and rejection commit exactly one terminal state and its matching notification', async () => {
  for (const rejectFirst of [false, true]) {
    const { apply, admin, db } = applicationFixture()
    const created = await apply()
    const retries = require('./optimisticTransactions')(db)
    const approve = () => admin('saveAdmin', { ...newPointData(), applicationIds: [created.applicationId] })
    const reject = () => admin('rejectApplication', { applicationIds: [created.applicationId], reason: '无法核验公共名称' })
    const results = await Promise.allSettled((rejectFirst ? [reject, approve] : [approve, reject]).map(run => run()))
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.match(results.find(result => result.status === 'rejected').reason.message, /已处理|已被驳回/)
    assert.ok(retries() > 0, 'overlapping snapshots must exercise conflict retry')
    const application = applicationRows(db)[0], notices = applicationNotices(db)
    assert.ok(['resolved', 'rejected'].includes(application.status))
    assert.equal(notices.length, 1); assert.equal(notices[0].extra.status, application.status)
    assert.equal(notices[0].targetOpenid, 'client-a')
    const points = db.state.platform_configs.filter(row => row.key === 'service_community')
    assert.equal(points.length, application.status === 'resolved' ? 1 : 0)
    if (application.status === 'resolved') {
      assert.equal(notices[0].extra.communityId, application.serviceCommunityId)
      assert.equal(points[0]._id, application.serviceCommunityId)
    } else assert.ok(notices[0].content.includes(application.rejectionReason))
  }
})

test('two first-time concurrent applicants create one application and retain the winning original applicant', async () => {
  const { apply, db } = applicationFixture()
  const retries = require('./optimisticTransactions')(db)
  const openids = ['client-a', 'client-b']
  const results = await Promise.all(openids.map(openid => apply(openid)))
  assert.deepEqual(results.map(row => row.outcome).sort(), ['created', 'other_duplicate'])
  assert.ok(results.every(row => row.status === 'pending'))
  assert.equal(results[0].applicationId, results[1].applicationId)
  assert.ok(retries() > 0)
  const rows = applicationRows(db)
  assert.equal(rows.length, 1)
  const winner = openids[results.findIndex(row => row.outcome === 'created')]
  assert.equal(rows[0].firstApplicantOpenid, winner)
  const original = structuredClone(rows[0])
  assert.equal((await apply(winner)).outcome, 'self_duplicate')
  assert.equal((await apply(openids.find(openid => openid !== winner))).outcome, 'other_duplicate')
  assert.deepEqual(applicationRows(db), [original])
})

test('application and public point creation retry stale city catalogs in either commit order without duplicate applications', async () => {
  for (const applicationCommitsFirst of [false, true]) {
    const { apply, admin, db } = applicationFixture()
    require('./optimisticTransactions')(db)
    const application = () => apply()
    const create = () => admin('saveAdmin', newPointData())
    const result = await commitSecondBeforeFirst(db,
      applicationCommitsFirst ? create : application,
      applicationCommitsFirst ? application : create)
    assert.ok(result.transactions >= 3, 'stale city snapshot must trigger a fresh catalog scan')
    const applied = applicationCommitsFirst ? result.second : result.first
    assert.equal(applied.status, applicationCommitsFirst ? 'pending' : 'existing')
    assert.equal(applied.outcome, applicationCommitsFirst ? 'created' : 'existing')
    const history = structuredClone(applicationRows(db))
    // Creating a point without linking an earlier application may leave pending
    // history; it must still prevent any subsequent duplicate application.
    assert.equal(history.length, applicationCommitsFirst ? 1 : 0)
    if (history.length) { assert.equal(history[0].status, 'pending'); assert.equal(history[0].firstApplicantOpenid, 'client-a') }
    const later = await apply('client-b')
    assert.equal(later.status, 'existing'); assert.equal(later.outcome, 'existing')
    assert.deepEqual(applicationRows(db), history)
    assert.equal(db.state.platform_configs.filter(row => row.key === 'service_community').length, 1)
    assert.equal(applicationNotices(db).length, 0)
  }
})

test('published sitters with legacy province-prefixed service cities remain visible on their city map', async () => {
  const { handler } = fixture({ platform_configs: [publicRow({ city: '深圳市', cityKey: '深圳', latitude: 22.5, longitude: 114 })],
    staff_profiles: [staff({ staffLevel: 'certified', serviceCity: '广东省深圳市', serviceLatitude: 22.501, serviceLongitude: 114.001,
      publicMapEnabled: true, publicServiceCommunityId: id, publicCommunityRevision: 1 })] })
  const result = await handler('client', 'listSitters', { city: '深圳市', communityId: id })
  assert.equal(result.total, 1); assert.equal(result.communities[0].count, 1)
})
