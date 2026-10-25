const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { clusterCommunities, locationCity, viewportKey, readViewport, storeViewport } = require('../../miniprogram/pages/common/community-map/utils')

test('map clusters preserve every community and count while keeping at most 60 markers', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ _id: String(i), latitude: 22 + i / 1000, longitude: 114 + (i % 30) / 100, count: 5 }))
  const groups = clusterCommunities(rows, 15)
  assert.ok(groups.length <= 60)
  assert.equal(groups.reduce((sum, row) => sum + row.count, 0), 5000)
  assert.equal(new Set(groups.flatMap(row => row.members.map(member => member._id))).size, 1000)
})
test('zoom separates nearby communities and never merges the underlying identities', () => {
  const rows = [{ _id: 'a', latitude: 31.2, longitude: 121.5, count: 2 }, { _id: 'b', latitude: 31.202, longitude: 121.502, count: 3 }]
  const far = clusterCommunities(rows, 8), close = clusterCommunities(rows, 19)
  assert.equal(far.length, 1)
  assert.equal(far[0].count, 5)
  assert.equal(close.length, 2)
})
function pageFixture(options = {}) {
  let page
  const requests = [], errors = [], navigation = [], storage = new Map()
  let identityListener
  const wx = { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
    getLocation: args => args.success({ latitude: 31.25, longitude: 121.55 }),
    requirePrivacyAuthorize: args => args.success(), showToast() {},
    navigateTo: args => navigation.push(args), navigateBack: args => navigation.push(args), redirectTo: args => navigation.push(args),
    ...options.wx }
  // Load the real cloud exports, including privacy authorization, without inventing a GPS export.
  const cloudFile = require.resolve('../../miniprogram/utils/cloud')
  const cloudModule = { exports: {} }
  const app = { globalData: { ...options.globalData } }
  vm.runInNewContext(fs.readFileSync(cloudFile, 'utf8'), { module: cloudModule, require: createRequire(cloudFile), wx, getApp: () => app, setTimeout, clearTimeout })
  const cloud = { ...cloudModule.exports, getSelectedLocation: () => ({ latitude: 31.2, longitude: 121.5, city: '上海市' }),
    getCloudEnv: () => 'test', showError: error => errors.push(error),
    ensureLogin: async () => ({}), requestSubscribeTemplates: async () => null,
    subscribeIdentityChange(listener) { identityListener = listener; return () => { identityListener = null } },
    callFunction(module, action, data) { return new Promise((resolve, reject) => requests.push({ module, action, data, resolve, reject })) },
    ...options.cloud }
  vm.runInNewContext(fs.readFileSync(require.resolve('../../miniprogram/pages/common/community-map/index.js'), 'utf8'), {
    Page(value) { page = value }, require(name) { return name === './utils' ? require('../../miniprogram/pages/common/community-map/utils') : cloud },
    wx, getApp: () => app, getCurrentPages: () => options.pages || [], setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer }, clearTimeout
  })
  page.data = { ...page.data, city: '上海市', checkingIdentity: false, selected: { _id: 'a', name: 'A' }, ...options.data }
  page._seq = 0; page._panelSeq = 0; page._authSeq = 0; page._cameraSeq = 0; page._opSeq = 0; page._communities = []
  page.setData = function (patch, callback) { Object.assign(this.data, patch); callback?.() }
  return { page, requests, errors, navigation, storage, cloud, identity: user => identityListener?.(user) }
}
async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve() }
test('late response for the previous community cannot replace the selected sitter cards', async () => {
  const { page, requests } = pageFixture()
  const old = page.loadCards(1)
  page.data.selected = { _id: 'b', name: 'B' }
  const current = page.loadCards(1)
  requests[1].resolve({ list: [{ _id: 'sitter-b' }], total: 1, hasMore: false })
  await current
  requests[0].resolve({ list: [{ _id: 'sitter-a' }], total: 1, hasMore: false })
  await old
  assert.equal(page.data.cards[0]._id, 'sitter-b')
})
test('closing a sheet invalidates in-flight card requests', async () => {
  const { page, requests } = pageFixture()
  page.renderMarkers = () => {}
  const pending = page.loadCards(1)
  page.closePanel()
  requests[0].resolve({ list: [{ _id: 'late' }], total: 1 })
  await pending
  assert.equal(page.data.selected, null)
  assert.equal(page.data.cards.length, 0)
})
test('card pagination forwards the stable cursor returned by the previous page', async () => {
  const { page, requests } = pageFixture()
  const first = page.loadCards(1)
  requests[0].resolve({ list: [{ _id: 'first' }], total: 2, hasMore: true, nextCursor: 'cursor-1' })
  await first
  const second = page.loadCards(2)
  assert.equal(requests[1].data.cursor, 'cursor-1')
  requests[1].resolve({ list: [{ _id: 'second' }], total: 2, hasMore: false, nextCursor: '' })
  await second
  assert.equal(page.data.cards.map(row => row._id).join(','), 'first,second')
})

test('native marker identities stay stable when viewport changes and cannot select another estate', () => {
  const { page } = pageFixture()
  page._communities = [{ _id: 'a', name: 'A', latitude: 31.2, longitude: 121.5, count: 2 },
    { _id: 'b', name: 'B', latitude: 31.4, longitude: 121.7, count: 3 }]
  page.data.scale = 16
  page.renderMarkers()
  const id = page.data.markers.find(marker => marker.latitude === 31.4).id
  page._communities = [page._communities[1]]
  page.renderMarkers()
  assert.equal(page.data.markers[0].id, id)
  assert.equal(page._markerLookup.get(id).members[0]._id, 'b')
})

test('viewport cache expires, isolates accounts and filters, and stores only bounded camera geometry', () => {
  const now = 1000000000, point = { latitude: 31.2, longitude: 121.5, scale: 15, cards: ['private'], selected: 'private' }
  const data = { mode: 'orders', city: '上海市', filterDate: '2099-12-01', orderKind: 'normal' }
  const key = viewportKey('env:user', data, point)
  let cache = storeViewport([], key, point, now)
  assert.deepEqual(readViewport(cache, key, now), { latitude: 31.2, longitude: 121.5, scale: 15 })
  for (const other of [viewportKey('env:other', data, point), viewportKey('other:user', data, point),
    viewportKey('env:user', { ...data, filterDate: '' }, point), viewportKey('env:user', { ...data, mode: 'sitters' }, point),
    viewportKey('env:user', data, { ...point, latitude: 31.3 })]) assert.equal(readViewport(cache, other, now), null)
  assert.equal(readViewport(cache, key, now + 7 * 86400000 + 1), null)
  assert.equal(readViewport(cache, key, now - 1), null)
  assert.equal(readViewport([{ ...cache[0], scale: 50 }], key, now), null)
  assert.equal(readViewport([{ ...cache[0], latitude: 0 }], key, now), null)
  cache[0].cards = ['old-private-card']
  for (let i = 0; i < 20; i++) cache = storeViewport(cache, 'key-' + i, point, now + i)
  assert.equal(cache.length, 12)
  assert.equal(JSON.stringify(cache).includes('private'), false)
  assert.deepEqual(Object.keys(cache[0]).sort(), ['key', 'latitude', 'longitude', 'savedAt', 'scale'])
})

test('silent card refresh retains later pages and cursor, removes stale cards and offers new content manually', async () => {
  const { page, requests } = pageFixture()
  page.data.cards = Array.from({ length: 20 }, (_, i) => ({ _id: 'p' + i }))
  page.data.page = 2; page._nextCursor = 'cursor-2'; page._scrollTop = 320
  const refresh = page.loadCards(1, true)
  assert.equal(requests[0].data.refreshIds.length, 20)
  const visibleList = page.data.cards.filter(row => row._id !== 'p3').map(row => ({ ...row, updated: true }))
  requests[0].resolve({ list: [{ _id: 'new' }, ...visibleList.slice(0, 9)], visibleList, total: 25, hasMore: true })
  await refresh
  assert.equal(page.data.cards.map(row => row._id).join(','), visibleList.map(row => row._id).join(','))
  assert.equal(page.data.page, 2); assert.equal(page._nextCursor, 'cursor-2'); assert.equal(page._scrollTop, 320)
  assert.equal(page.data.pendingUpdates, true); assert.equal(page.data.panelRefreshing, false)
  const more = page.more()
  assert.equal(requests[1].data.cursor, 'cursor-2')
  requests[1].resolve({ list: [{ _id: 'p20' }], total: 25, hasMore: false })
  await more
  assert.equal(page.data.cards.at(-1)._id, 'p20')
  assert.equal(page.data.pendingUpdates, true)
})

test('stale touched-card response cannot replace a newer deferred update', async () => {
  const { page, requests } = pageFixture()
  page.data.cards = [{ _id: 'old' }]; page.cardTouchStart()
  const old = page.loadCards(1, true), current = page.loadCards(1, true)
  requests[1].resolve({ visibleList: [{ _id: 'old', updated: true }], list: [], total: 1 })
  await current
  const deferred = page._deferredCards
  requests[0].resolve({ visibleList: [], list: [], total: 0 })
  await old
  assert.equal(page._deferredCards, deferred)
  assert.equal(page.data.cards[0].updated, undefined)
  page._touchingCards = false; deferred()
  assert.equal(page.data.cards[0].updated, true)
})

test('map GPS uses actual exported privacy API and never overwrites the selected service address', async () => {
  let privacyCount = 0, gpsCount = 0
  const { page, storage } = pageFixture({ wx: {
    requirePrivacyAuthorize(args) { privacyCount++; args.success() },
    getLocation(args) { gpsCount++; assert.equal(args.type, 'gcj02'); args.success({ latitude: 31.4, longitude: 121.8 }) }
  } })
  page._reference = { latitude: 31.2, longitude: 121.5 }
  await page.locate()
  assert.equal(privacyCount, 1); assert.equal(gpsCount, 1)
  assert.equal(page.data.latitude, 31.4)
  assert.equal(page._reference.latitude, 31.2)
  assert.equal(storage.size, 0)
})

test('returning during initial authentication restarts loading and ignores the old session response', async () => {
  const { page, requests } = pageFixture({ data: { selected: null } })
  page.onLoad({ city: '上海市' }); page.onHide(); page.onShow()
  assert.equal(requests.length, 2)
  requests[1].resolve({ _id: 'current', roles: ['client'] }); await settle()
  assert.equal(requests[2].action, 'listSitters')
  requests[0].resolve({ _id: 'old', roles: ['staff'] }); await settle()
  assert.equal(requests.length, 3)
  requests[2].resolve({ communities: [] }); await settle()
  assert.equal(page._user._id, 'current'); assert.equal(page.data.checkingIdentity, false); assert.equal(page.data.loading, false)
  page.onUnload()
})

test('session transport failures remain retryable instead of downgrading a staff member', async () => {
  const { page, requests } = pageFixture({ data: { selected: null, mode: 'orders' } })
  const initial = page.initialize()
  requests[0].reject(new Error('network offline')); await initial
  assert.equal(page.data.mode, 'orders'); assert.equal(page.data.checkingIdentity, true)
  const retry = page.retry()
  requests[1].resolve({ _id: 'staff', roles: ['staff'] }); await settle()
  requests[2].resolve({ serviceLatitude: 31.2, serviceLongitude: 121.5 }); await settle()
  assert.equal(requests[3].action, 'listOrders')
  requests[3].resolve({ communities: [] }); await retry
  assert.equal(page.data.checkingIdentity, false)
})

test('guests can browse public sitters and identity changes discard private in-memory map state', async () => {
  const { page, requests, identity } = pageFixture({ data: { selected: null } })
  page.onLoad({ city: '上海市' })
  requests[0].reject(new Error('请先登录')); await settle()
  requests[1].resolve({ communities: [] }); await settle()
  assert.equal(page.data.mode, 'sitters'); assert.equal(page.data.checkingIdentity, false)
  page.data.cards = [{ _id: 'private' }]; page.data.successOrderId = 'private'
  identity({ _id: 'new-account', roles: ['client'] })
  assert.equal(page.data.cards.length, 0); assert.equal(page.data.successOrderId, '')
  page.onUnload()
  requests[2].resolve({ _id: 'new-account', roles: ['client'] }); await settle()
  assert.equal(requests.length, 3)
})

test('client-side entry stays in sitter mode even for a dual-role account and an orders URL', async () => {
  const { page, requests } = pageFixture({ data: { selected: null }, pages: [{ route: 'pages/client/sitters/list/index' }, { route: 'map' }] })
  page.onLoad({ mode: 'orders' })
  requests[0].resolve({ _id: 'dual', roles: ['client', 'staff'], activeRole: 'staff' }); await settle()
  assert.equal(page.data.mode, 'sitters'); assert.equal(page.data.canFindOrders, false)
  assert.equal(requests[1].action, 'listSitters')
  assert.equal(page.changeMode, undefined)
  requests[1].resolve({ communities: [] }); await settle(); page.onUnload()
})

test('staff-side entry stays in orders mode even when the URL asks for sitters', async () => {
  const { page, requests } = pageFixture({ data: { selected: null }, globalData: { activeRole: 'staff' } })
  page.onLoad({ mode: 'sitters' })
  requests[0].resolve({ _id: 'dual', roles: ['client', 'staff'], activeRole: 'client' }); await settle()
  assert.equal(requests[1].action, 'getStaffProfile')
  requests[1].resolve({ serviceLatitude: 31.2, serviceLongitude: 121.5 }); await settle()
  assert.equal(page.data.mode, 'orders'); assert.equal(requests[2].action, 'listOrders')
  requests[2].resolve({ communities: [] }); await settle(); page.onUnload()
})

test('region requests ignore late callbacks after a newer viewport or filter change', async () => {
  const { page, storage } = pageFixture()
  page._initialized = true; page._user = { _id: 'u' }
  const reads = []
  page._map = Object.fromEntries(['getRegion', 'getScale', 'getCenterLocation'].map(name => [name, args => reads.push({ name, args })]))
  const old = page.regionChanged({ type: 'end', causedBy: 'drag' }), current = page.regionChanged({ type: 'end', causedBy: 'scale' })
  function finish(offset, latitude) {
    reads[offset].args.success({ southwest: { latitude: 30, longitude: 120 }, northeast: { latitude: 32, longitude: 123 } })
    reads[offset + 1].args.success({ scale: 16 })
    reads[offset + 2].args.success({ latitude, longitude: 121.5 })
  }
  finish(3, 31.8); await current; finish(0, 31.1); await old
  assert.equal(page._viewport.latitude, 31.8); assert.equal(page.data.dirty, true)
  assert.equal(page.data.latitude, 22.5431, 'native camera observations must not write the bound camera properties')
  assert.equal(page.data.scale, 13); assert.equal(page.data.zoomScale, 16)
  assert.equal(storage.get('communityMapViewportsV1')[0].latitude, 31.8)
  const late = page.regionChanged({ type: 'end' })
  page._cameraSeq++
  finish(6, 31.3); await late
  assert.equal(page._viewport.latitude, 31.8)
})

test('GPS refusal never enters uncertain-grab recovery or sends an accept request', async () => {
  const { page, requests, errors } = pageFixture({ data: { mode: 'orders', canFindOrders: true, cards: [{ _id: 'o1' }] },
    wx: { getLocation: args => args.fail() } })
  await page.submitGrab('o1', false)
  assert.equal(requests.length, 0); assert.equal(errors.length, 1)
  assert.equal(page.data.confirmingOrderId, ''); assert.equal(page.data.submitting, '')
})

test('hiding during risk preflight cancels acceptance and hiding after accept preserves result confirmation', async () => {
  const { page, requests } = pageFixture({ data: { mode: 'orders', canFindOrders: true, cards: [{ _id: 'o1' }] } })
  const grab = page.grab({ currentTarget: { dataset: { id: 'o1' } } }); await settle()
  assert.equal(requests[0].action, 'checkAcceptOrderRisk')
  page.onHide(); requests[0].resolve({ requiresConfirmation: false }); await grab
  assert.equal(requests.length, 1)
  page._hidden = false
  const accept = page.submitGrab('o1', false); await settle()
  assert.equal(requests[1].action, 'acceptOrder')
  assert.equal(requests[1].data.currentLatitude, 31.25)
  page.onHide()
  assert.equal(page.data.confirmingOrderId, 'o1')
  requests[1].resolve({ status: 'assigned' }); await accept
  assert.equal(page.data.successOrderId, ''); assert.equal(page.data.confirmingOrderId, 'o1')
})

test('uncertain accept checks ownership and blocks further grabs until a result is confirmed', async () => {
  const { page, requests } = pageFixture({ data: { mode: 'orders', canFindOrders: true, cards: [{ _id: 'o1' }] } })
  const accept = page.submitGrab('o1', false); await settle()
  requests[0].reject(new Error('timeout')); await settle()
  assert.equal(requests[1].action, 'getGrabResult')
  requests[1].reject(new Error('offline')); await accept
  assert.equal(page.data.confirmingOrderId, 'o1')
  await page.grab({ currentTarget: { dataset: { id: 'o1' } } })
  assert.equal(requests.length, 2)
  const confirm = page.confirmGrabResult()
  requests[2].resolve({ state: 'assigned' }); await settle()
  requests[3].resolve({ communities: [] }); await confirm
  assert.equal(page.data.successOrderId, 'o1'); assert.equal(page.data.confirmingOrderId, '')
})

test('list navigation reuses an existing workbench page and replaces map when opened directly', () => {
  const { page, navigation } = pageFixture({ data: { mode: 'orders' }, pages: [{ route: 'pages/staff/home/index' }, { route: 'map' }] })
  page.listView(); assert.equal(navigation[0].delta, 1)
  const direct = pageFixture({ data: { mode: 'sitters' } })
  direct.page.listView(); assert.equal(direct.navigation[0].url, '/pages/client/sitters/list/index')
})

test('workbench passes all map filters and only the selected reference coordinates', () => {
  let home, navigation
  vm.runInNewContext(fs.readFileSync(require.resolve('../../miniprogram/pages/staff/home/index.js'), 'utf8'), {
    Page(value) { home = value }, require: () => ({}), wx: { navigateTo: args => { navigation = args } }
  })
  home.data = { ...home.data, selectedCity: '上海市', filterDate: '2099-12-01', grabTab: 'urgent', inServiceRange: true, inServiceTime: true,
    currentWorkbenchLocation: { latitude: 31.3, longitude: 121.6, address: 'PRIVATE' } }
  home.openCommunityMap()
  assert.match(navigation.url, /inServiceRange=1&inServiceTime=1/)
  assert.match(navigation.url, /date=2099-12-01&kind=urgent/)
  let context
  navigation.success({ eventChannel: { emit(name, data) { assert.equal(name, 'communityMapContext'); context = data } } })
  assert.equal(context.reference.latitude, 31.3); assert.equal(context.reference.longitude, 121.6)
  assert.equal(JSON.stringify(context).includes('PRIVATE'), false)
})

test('entry reference wins over staff defaults and GPS changes only the camera', async () => {
  const { page, requests } = pageFixture({ data: { selected: null } })
  let contextListener
  page.getOpenerEventChannel = () => ({ on(name, listener) { contextListener = listener } })
  page.onLoad({ mode: 'orders', city: '上海市', inServiceRange: '1', inServiceTime: '1' })
  contextListener({ reference: { latitude: 31.3, longitude: 121.6 } })
  requests[0].resolve({ _id: 'staff', roles: ['staff'] }); await settle()
  requests[1].resolve({ serviceLatitude: 30.1, serviceLongitude: 120.1 }); await settle()
  assert.equal(requests[2].data.latitude, 31.3); assert.equal(requests[2].data.longitude, 121.6)
  assert.equal(requests[2].data.inServiceRange, true); assert.equal(requests[2].data.inServiceTime, true)
  requests[2].resolve({ communities: [] }); await settle()
  await page.locate()
  assert.equal(page.data.latitude, 31.25); assert.equal(page.requestData().latitude, 31.3)
  page.returnToReference(); assert.equal(page.data.latitude, 31.3)
  page.onUnload()
})

test('saved viewport restores before data load without being replaced by automatic fitting', async () => {
  const { page, requests, storage } = pageFixture({ data: { selected: null } })
  const point = { latitude: 31.8, longitude: 121.8, scale: 17 }
  storage.set('communityMapViewportsV1', storeViewport([], viewportKey('test:u', page.data), point))
  let fits = 0
  page._map = { includePoints() { fits++ } }
  const init = page.initialize()
  requests[0].resolve({ _id: 'u', roles: ['client'] }); await settle()
  assert.equal(page.data.latitude, 31.8); assert.equal(page.data.scale, 17)
  requests[1].resolve({ communities: [{ _id: 'c', name: 'C', latitude: 31.2, longitude: 121.5, count: 2 }] }); await init
  assert.equal(fits, 0)
})

test('a previous filter response cannot redraw old communities after changing filters', async () => {
  const { page, requests } = pageFixture({ data: { selected: null } })
  const old = page.refresh()
  const current = page.updateFilters({ onlyDirect: true })
  assert.equal(requests[1].data.onlyDirect, true)
  requests[1].resolve({ communities: [{ _id: 'current', latitude: 31.2, longitude: 121.5, count: 1 }] }); await current
  requests[0].resolve({ communities: [{ _id: 'old', latitude: 31.4, longitude: 121.6, count: 4 }] }); await old
  assert.equal(page._communities[0]._id, 'current'); assert.equal(page.data.visibleCount, 1)
})

test('a background map request started before grabbing cannot clear the active order card', async () => {
  const { page, requests } = pageFixture({ data: { mode: 'orders', canFindOrders: true, cards: [{ _id: 'o1' }] } })
  const refresh = page.refresh(true)
  const grab = page.grab({ currentTarget: { dataset: { id: 'o1' } } }); await settle()
  assert.equal(requests[1].action, 'checkAcceptOrderRisk')
  requests[0].resolve({ communities: [] }); await refresh
  assert.equal(page.data.cards[0]._id, 'o1')
  requests[1].resolve({ requiresConfirmation: true }); await grab
  assert.equal(page.data.pendingOrderId, 'o1'); assert.equal(page.data.submitting, '')
  page.stopRefresh()
})

test('hiding after a confirmed accept during map reload does not mark the result uncertain again', async () => {
  const { page, requests } = pageFixture({ data: { mode: 'orders', canFindOrders: true, cards: [{ _id: 'o1' }] } })
  const accept = page.submitGrab('o1', false); await settle()
  requests[0].resolve({ status: 'assigned' }); await settle()
  assert.equal(page.data.successOrderId, 'o1'); assert.equal(requests[1].action, 'listOrders')
  page.onHide()
  assert.equal(page.data.confirmingOrderId, '')
  requests[1].resolve({ communities: [] }); await accept
  assert.equal(page.data.successOrderId, 'o1')
})

test('failed next-page requests retry the same cursor without discarding loaded cards', async () => {
  const { page, requests } = pageFixture({ data: { cards: [{ _id: 'loaded' }], page: 1, hasMore: true } })
  page._nextCursor = 'stable-cursor'
  const next = page.more()
  requests[0].reject(new Error('暂时离线')); await next
  assert.equal(page.data.cards[0]._id, 'loaded')
  assert.equal(page.data.panelError, '暂时离线')
  page.more()
  assert.equal(requests.length, 1, 'scroll events must not start an automatic error loop')
  const retry = page.retryPanel()
  assert.equal(requests[1].data.page, 2)
  assert.equal(requests[1].data.cursor, 'stable-cursor')
  requests[1].resolve({ list: [{ _id: 'next' }], total: 2, hasMore: false }); await retry
  assert.equal(page.data.cards.map(row => row._id).join(','), 'loaded,next')
})

test('touch events from panel buttons cannot collapse or close the panel as a drag', () => {
  const { page } = pageFixture()
  page.dragEnd({ changedTouches: [{ clientY: 200 }] })
  assert.equal(page.data.selected._id, 'a')
  assert.equal(page.data.expanded, false)
  page.dragStart({ touches: [] })
  assert.equal(page.data.dragging, false)
  page.dragStart({ touches: [{ clientY: 200 }] })
  page.dragEnd({ changedTouches: [{ clientY: 120 }] })
  assert.equal(page.data.expanded, true)
  page.dragEnd({ changedTouches: [{ clientY: 400 }] })
  assert.equal(page.data.expanded, true)
  page.dragStart({ touches: [{ clientY: 200 }] })
  page.dragEnd({ changedTouches: [{ clientY: 300 }] })
  assert.equal(page.data.expanded, false)
  assert.equal(page.data.selected._id, 'a')
})

test('silent card updates wait for the sheet drag to finish', async () => {
  const { page, requests } = pageFixture({ data: { cards: [{ _id: 'o1', value: 'old' }] } })
  page.dragStart({ touches: [{ clientY: 200 }] })
  const refresh = page.loadCards(1, true)
  requests[0].resolve({ list: [{ _id: 'o1' }], visibleList: [{ _id: 'o1', value: 'new' }], total: 1 }); await refresh
  assert.equal(page.data.cards[0].value, 'old')
  assert.equal(page._cardsBusy, true)
  page.dragCancel()
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(page.data.cards[0].value, 'new')
  assert.equal(page._cardsBusy, false)
})

test('map failure clears the broken context and card requests, then supports retry', async () => {
  let contexts = 0, fits = 0
  const { page, requests } = pageFixture({ wx: { createMapContext: () => {
    contexts++; return { includePoints() { fits++ } }
  } } })
  page._communities = [{ _id: 'a', name: '测试小区', latitude: 31.2, longitude: 121.5, count: 1 }]
  const cards = page.loadCards(1)
  page.mapFailed()
  assert.equal(page.data.mapError, true)
  assert.equal(page.data.selected, null)
  assert.equal(page._map, null)
  requests[0].resolve({ list: [{ _id: 'late' }], total: 1 }); await cards
  assert.equal(page.data.cards.length, 0)
  page.retryMap()
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(page.data.mapError, false)
  assert.equal(contexts, 1)
  assert.equal(fits, 1)
  assert.equal(page.data.markers.length, 1)
})

test('fallback list navigation remains usable when session checking failed', () => {
  const { page, navigation } = pageFixture({ data: { checkingIdentity: true, mapError: true, mode: 'sitters' } })
  page.listView()
  assert.equal(navigation[0].url, '/pages/client/sitters/list/index')
})

test('range filtering requires a usable reference and retains the previous filters on failure', () => {
  const toasts = []
  const { page, requests } = pageFixture({ data: { mode: 'orders' }, wx: { showToast: args => toasts.push(args.title) } })
  page._reference = null
  page.toggleRange()
  assert.equal(page.data.inServiceRange, false)
  assert.equal(requests.length, 0)
  assert.equal(toasts[0], '请先选择参考位置')
})

test('long community callouts stay compact without losing the full selected name', () => {
  const { page, requests } = pageFixture()
  const community = { _id: 'a', name: '用于布局验证的超长公共小区名称第一期第二组团', latitude: 31.2, longitude: 121.5, count: 1 }
  page._communities = [community]
  page.renderMarkers()
  assert.equal(page.data.markers[0].callout.content.split('\n')[0].length, 13)
  assert.ok(page.data.markers[0].callout.content.includes('…'))
  page.selectCommunity(community)
  assert.equal(page.data.selected.name, community.name)
  requests[0].resolve({ list: [], total: 0, hasMore: false })
  page.stopRefresh()
})

test('zoom uses the observed pinch scale, numeric steps and the actual dragged centre', () => {
  const { page } = pageFixture()
  page.data.scale = '13'
  page._viewport = { latitude: 31.8, longitude: 121.9, scale: 16.5 }
  page.zoom({ currentTarget: { dataset: { step: '1' } } })
  assert.equal(page.data.scale, 17.5); assert.equal(page.data.latitude, 31.8)
  page.zoom({ currentTarget: { dataset: { step: '1' } } })
  page.zoom({ currentTarget: { dataset: { step: '1' } } })
  assert.equal(page.data.scale, 19)
  page.zoom({ currentTarget: { dataset: { step: 'invalid' } } })
  assert.equal(page.data.scale, 19)
  page._viewport.scale = 5
  page.zoom({ currentTarget: { dataset: { step: '-1' } } })
  assert.equal(page.data.scale, 5)
})

test('zoom invalidates old native camera reads and prevents a late data load from fitting again', async () => {
  const { page, requests } = pageFixture({ data: { selected: null } })
  const reads = []
  let fits = 0
  page._map = { includePoints() { fits++ }, ...Object.fromEntries(['getRegion', 'getScale', 'getCenterLocation'].map(name => [name, args => reads.push(args)])) }
  const refresh = page.refresh(), oldCamera = page.regionChanged({ type: 'end', causedBy: 'update' })
  page.zoom({ currentTarget: { dataset: { step: '1' } } })
  reads[0].success({}); reads[1].success({ scale: 8 }); reads[2].success({ latitude: 30, longitude: 120 })
  await oldCamera
  assert.equal(page._viewport.scale, 14)
  requests[0].resolve({ communities: [{ _id: 'a', latitude: 31.2, longitude: 121.5, count: 1 }] }); await refresh
  assert.equal(fits, 0); assert.equal(page.data.scale, 14)
})

test('cluster taps issue one camera move and open a selector for coincident points at maximum zoom', async () => {
  const { page } = pageFixture()
  let fits = 0
  page._map = { includePoints() { fits++ } }
  page._communities = [{ _id: 'a', latitude: 31.2, longitude: 121.5, count: 1 }, { _id: 'b', latitude: 31.2, longitude: 121.5, count: 2 }]
  page.renderMarkers()
  const tap = () => page.markerTap({ detail: { markerId: page.data.markers[0].id } })
  await tap()
  assert.equal(page.data.scale, 15); assert.equal(fits, 0)
  page.moveCamera({ scale: 19 }); await tap()
  assert.equal(page.data.clusterChoices.length, 2)
})

test('selected community remains above the sheet with a zoom-dependent camera offset', () => {
  const { page, requests } = pageFixture()
  const community = { _id: 'a', latitude: 31.2, longitude: 121.5, count: 1 }
  page.selectCommunity(community)
  const farOffset = 31.2 - page.data.latitude
  page.moveCamera({ scale: 19 }); page.selectCommunity(community)
  const closeOffset = 31.2 - page.data.latitude
  assert.ok(farOffset > closeOffset * 60)
  assert.ok(closeOffset > 0 && closeOffset < .001)
  for (const request of requests) request.resolve({ list: [], total: 0 })
  page.stopRefresh()
})

test('selected city survives location storage and legacy addresses can supply the map city', () => {
  const { cloud } = pageFixture()
  // Use the actual normalizer and persistence path rather than the fixture location reader.
  const point = cloud.saveSelectedLocation({ latitude: 22.5, longitude: 114, city: '深圳市' })
  assert.equal(point.city, '深圳市')
  assert.equal(locationCity({ address: '广东省深圳市南山区某小区' }), '深圳市')
  assert.equal(locationCity({ address: '上海市浦东新区某小区' }), '上海市')
  assert.equal(locationCity({ name: '附近公园' }), '')
})

test('map location choice changes the city and reference, propagates coordinates only and survives returning', async () => {
  let initial, context
  const { page, requests, storage } = pageFixture({ data: { mode: 'orders', canFindOrders: true }, wx: {
    chooseLocation(args) { initial = args; args.success({ latitude: 30.2, longitude: 120.2, name: '新参考点', address: '浙江省杭州市PRIVATE' }) }
  } })
  page._initialized = true; page._reference = { latitude: 31.3, longitude: 121.6 }
  page.getOpenerEventChannel = () => ({ emit(name, value) { assert.equal(name, 'communityMapReferenceChanged'); context = value } })
  const chosen = page.chooseReference(); await settle()
  assert.equal(initial.latitude, 31.3)
  assert.equal(page.data.city, '杭州市'); assert.equal(page.data.latitude, 30.2)
  assert.equal(requests[0].data.latitude, 30.2); assert.equal(requests[0].data.city, '杭州市')
  assert.equal(JSON.stringify(context).includes('PRIVATE'), false)
  assert.equal(storage.has('vip_pet_selected_location'), false, 'staff reference must not replace the client service address')
  requests[0].resolve({ communities: [] }); await chosen
  const init = page.initialize()
  requests[1].resolve({ _id: 's', roles: ['staff'] }); await settle()
  requests[2].resolve({ serviceLatitude: 31.1, serviceLongitude: 121.1 }); await settle()
  assert.equal(requests[3].data.latitude, 30.2)
  requests[3].resolve({ communities: [] }); await init
})

test('cancelled or invalid location choices retain the last reference without changing the address', async () => {
  const { page, requests, errors, storage } = pageFixture({ wx: { chooseLocation(args) { args.fail({ errMsg: 'chooseLocation:fail cancel' }) } } })
  page._initialized = true; page._reference = { latitude: 31.3, longitude: 121.6 }
  await page.chooseReference()
  assert.equal(errors.length, 0); assert.equal(requests.length, 0)
  assert.equal(page._reference.latitude, 31.3); assert.equal(page.data.choosingReference, false)
  assert.equal(storage.size, 0)
  const invalid = pageFixture({ wx: { chooseLocation(args) { args.success({ latitude: 0, longitude: 0 }) } } })
  invalid.page._initialized = true
  await invalid.page.chooseReference()
  assert.equal(invalid.errors.length, 1); assert.equal(invalid.requests.length, 0)
})

test('location picker returning through hide/show does not restore the previous reference over the new one', async () => {
  let complete
  const { page, requests, storage } = pageFixture({ wx: { chooseLocation(args) { complete = args.success } } })
  page._initialized = true
  const chosen = page.chooseReference(); await settle()
  page.onHide(); page.onShow()
  assert.equal(requests.length, 0)
  complete({ latitude: 31.7, longitude: 121.8, city: '上海市', name: '新位置' }); await settle()
  assert.equal(storage.get('vip_pet_selected_location').latitude, 31.7)
  assert.equal(page._reference.latitude, 31.7)
  assert.equal(requests[0].action, 'checkSession')
  requests[0].resolve({ _id: 'client', roles: ['client'] }); await settle()
  assert.equal(requests[1].data.latitude, 31.7)
  requests[1].resolve({ communities: [] }); await chosen
  page.onUnload()
})

test('cancelling the native picker resumes interrupted card loading when onShow arrives first', async () => {
  let cancel
  const { page, requests } = pageFixture({ wx: { chooseLocation(args) { cancel = args.fail } } })
  page._initialized = true; page._loaded = true; page._fitted = true
  page._reference = { latitude: 31.2, longitude: 121.5 }
  const old = page.loadCards(1), choice = page.chooseReference(); await settle()
  page.onHide(); page.onShow()
  cancel({ errMsg: 'chooseLocation:fail cancel' }); await settle()
  requests[0].resolve({ list: [{ _id: 'outdated' }], total: 1 }); await old
  assert.equal(page.data.cards.length, 0)
  assert.equal(requests[1].action, 'checkSession')
  requests[1].resolve({ _id: 'client', roles: ['client'] }); await settle()
  requests[2].resolve({ communities: [{ _id: 'a', latitude: 31.2, longitude: 121.5, count: 1 }] }); await settle()
  assert.equal(requests[3].data.communityId, 'a')
  requests[3].resolve({ list: [{ _id: 'resumed' }], total: 1 }); await choice
  assert.equal(page.data.cards[0]._id, 'resumed'); assert.equal(page._reference.latitude, 31.2)
  page.onUnload()
})

test('picker completion before onShow leaves refresh to the visible page', async () => {
  let complete
  const { page, requests } = pageFixture({ wx: { chooseLocation(args) { complete = args.success } } })
  page._initialized = true
  const choice = page.chooseReference(); await settle()
  page.onHide()
  complete({ latitude: 30.2, longitude: 120.2, city: '杭州市', name: '新参考位置' }); await choice
  assert.equal(requests.length, 0)
  page.onShow()
  assert.equal(requests[0].action, 'checkSession')
  requests[0].resolve({ _id: 'client', roles: ['client'] }); await settle()
  assert.equal(requests[1].data.latitude, 30.2); assert.equal(requests[1].data.city, '杭州市')
  requests[1].resolve({ communities: [] }); await settle()
  page.onUnload()
})

function workbenchFixture(options = {}) {
  let page
  const requests = [], errors = [], navigation = []
  const cloud = { requirePrivacyAuthorize: async () => {}, showError: error => errors.push(error),
    callFunction(module, action, data) { return new Promise((resolve, reject) => requests.push({ action, data, resolve, reject })) },
    ...options.cloud }
  vm.runInNewContext(fs.readFileSync(require.resolve('../../miniprogram/pages/staff/home/index.js'), 'utf8'), {
    Page(value) { page = value }, require: () => cloud,
    wx: { navigateTo: args => navigation.push(args), ...options.wx }
  })
  page.data = { ...page.data, ...options.data }
  page.setData = function (patch, callback) { Object.assign(this.data, patch); callback?.() }
  return { page, requests, errors, navigation }
}

test('workbench map selection becomes its new reference and returning no longer resets the selection', () => {
  const { page, navigation } = workbenchFixture({ data: { currentWorkbenchLocation: { latitude: 31.1, longitude: 121.1 } },
    cloud: { loadSystemSettings: async () => {}, loadMessageUnread() {} } })
  page.openCommunityMap()
  navigation[0].events.communityMapReferenceChanged({ reference: { latitude: 30.2, longitude: 120.2 }, city: '杭州市' })
  page.applyCurrentTheme = () => {}
  let loaded
  page.initStaffHome = () => { loaded = page.data.customLocation }
  page.onShow()
  assert.equal(loaded.latitude, 30.2); assert.equal(page.data.selectedCity, '杭州市')
})

test('workbench location picker starts at its own reference and silently handles cancellation', async () => {
  let initial
  const { page, errors } = workbenchFixture({ data: { currentWorkbenchLocation: { latitude: 31.1, longitude: 121.1 } }, wx: {
    chooseLocation(args) { initial = args; args.fail({ errMsg: 'chooseLocation:fail cancel' }) }
  } })
  await page.refreshNearby()
  assert.equal(initial.latitude, 31.1); assert.equal(errors.length, 0)
  assert.equal(page.choosingWorkbenchLocation, false)
})

test('old workbench results cannot replace newly selected location results', async () => {
  const { page, requests } = workbenchFixture()
  const old = page.loadNearby({ latitude: 31.1, longitude: 121.1 }, '旧位置')
  const current = page.loadNearby({ latitude: 31.2, longitude: 121.2 }, '新位置', true)
  for (const request of requests.slice(3)) request.resolve([])
  await current
  assert.equal(page.data.currentWorkbenchLocation.latitude, 31.2)
  for (const request of requests.slice(0, 3)) request.resolve([])
  await old
  assert.equal(page.data.currentWorkbenchLocation.latitude, 31.2)
})

test('late native update events after rapid zoom taps cannot restore the earlier scale', async () => {
  const { page } = pageFixture()
  let nativeScale = 13
  page._map = { getRegion: args => args.success({}), getScale: args => args.success({ scale: nativeScale }),
    getCenterLocation: args => args.success({ latitude: 31.2, longitude: 121.5 }) }
  page.zoom({ currentTarget: { dataset: { step: '1' } } })
  page.zoom({ currentTarget: { dataset: { step: '1' } } })
  await page.regionChanged({ type: 'end', causedBy: 'update' })
  assert.equal(page._viewport.scale, 15)
  nativeScale = 15
  await page.regionChanged({ type: 'end', causedBy: 'update' })
  assert.equal(page.data.zoomScale, 15)
  page.regionChanged({ type: 'begin', causedBy: 'scale' }); nativeScale = 12
  await page.regionChanged({ type: 'end', causedBy: 'scale' })
  assert.equal(page._viewport.scale, 12, 'a subsequent user pinch must still be observed')
})

test('an initial native update does not disable fitting a city with no reference', async () => {
  const { page, requests } = pageFixture({ data: { selected: null }, cloud: { getSelectedLocation: () => null } })
  let fits = 0
  page._map = { includePoints() { fits++ } }
  const initial = page.initialize()
  requests[0].resolve({ _id: 'client', roles: ['client'] }); await settle()
  page.regionChanged({ type: 'begin', causedBy: 'update' })
  requests[1].resolve({ communities: [{ _id: 'a', latitude: 31.2, longitude: 121.5, count: 1 }] }); await initial
  assert.equal(fits, 1)
})

test('an initial selected reference is not replaced by fitting distant communities', async () => {
  const { page, requests } = pageFixture({ data: { selected: null } })
  let fits = 0
  page._map = { includePoints() { fits++ } }
  const initial = page.initialize()
  requests[0].resolve({ _id: 'client', roles: ['client'] }); await settle()
  requests[1].resolve({ communities: [{ _id: 'a', latitude: 32.2, longitude: 122.5, count: 1 }] }); await initial
  assert.equal(fits, 0); assert.equal(page.data.latitude, 31.2); assert.equal(page.data.scale, 13)
})

test('late native centre updates at the same zoom cannot replace a newly requested location', async () => {
  const { page } = pageFixture()
  let latitude = 31.2
  page._map = { getRegion: args => args.success({}), getScale: args => args.success({ scale: 13 }),
    getCenterLocation: args => args.success({ latitude, longitude: 121.5 }) }
  page.moveCamera({ latitude: 31.8, longitude: 121.5 })
  await page.regionChanged({ type: 'end', causedBy: 'update' })
  assert.equal(page._viewport.latitude, 31.8)
  latitude = 31.8
  await page.regionChanged({ type: 'end', causedBy: 'update' })
  assert.equal(page._cameraTarget, null)
})

test('map recovery recreates the last observed camera instead of the old bound centre', async () => {
  const { page } = pageFixture({ wx: { createMapContext: () => ({}) } })
  page._viewport = { latitude: 31.8, longitude: 121.8, scale: 17 }
  page.mapFailed(); page.retryMap()
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(page.data.latitude, 31.8); assert.equal(page.data.longitude, 121.8); assert.equal(page.data.scale, 17)
})

test('ordinary native updates and late data cannot cancel or overwrite an explicit GPS request', async () => {
  let gps, fits = 0
  const { page, requests } = pageFixture({ data: { selected: null }, wx: { getLocation(args) { gps = args } } })
  page._reference = { latitude: 31.2, longitude: 121.5 }
  page._map = { includePoints() { fits++ }, getRegion: args => args.success({}),
    getScale: args => args.success({ scale: 13 }), getCenterLocation: args => args.success({ latitude: 31.2, longitude: 121.5 }) }
  const pending = page.locate(); await settle()
  assert.equal(page.data.locating, true)
  const load = page.refresh()
  page.regionChanged({ type: 'begin', causedBy: 'update' })
  await page.regionChanged({ type: 'end', causedBy: 'update' })
  requests[0].resolve({ communities: [{ _id: 'a', latitude: 31.2, longitude: 121.5, count: 1 }] }); await load
  assert.equal(fits, 0)
  gps.success({ latitude: 31.8, longitude: 121.8 }); await pending
  assert.equal(page.data.latitude, 31.8); assert.equal(page.data.locating, false)
  assert.equal(page._reference.latitude, 31.2)
})

test('user gestures, camera commands and leaving the map cancel pending GPS results', async () => {
  for (const cancel of [page => page.regionChanged({ type: 'begin', causedBy: 'drag' }),
    page => page.zoom({ currentTarget: { dataset: { step: 1 } } }), page => page.onHide(), page => page.mapFailed()]) {
    let gps
    const { page } = pageFixture({ wx: { getLocation(args) { gps = args } } })
    const pending = page.locate(); await settle()
    cancel(page)
    const expected = page.data.latitude
    assert.equal(page.data.locating, false)
    gps.success({ latitude: 31.8, longitude: 121.8 }); await pending
    assert.equal(page.data.latitude, expected)
  }
})

test('GPS failures clear busy state and an old result cannot win over a newer request', async () => {
  const fixes = []
  const { page, errors } = pageFixture({ wx: { getLocation(args) { fixes.push(args) } } })
  const first = page.locate(); await settle()
  await page.locate()
  assert.equal(fixes.length, 1, 'duplicate taps share the pending location attempt')
  page.regionChanged({ type: 'begin', causedBy: 'scale' })
  const second = page.locate(); await settle()
  fixes[0].success({ latitude: 31.8, longitude: 121.8 }); await first
  assert.equal(page.data.locating, true)
  fixes[1].fail({ errMsg: 'getLocation:fail denied' }); await second
  assert.equal(page.data.locating, false); assert.equal(errors.length, 1)
})

test('workbench starts changed filters immediately and ignores the previous query response', async () => {
  const location = { latitude: 22.5, longitude: 114 }
  const { page, requests } = workbenchFixture({ data: { customLocation: location } })
  const old = page.loadNearby(location, '工作台位置')
  assert.equal(page.loadNearby(location, '工作台位置'), old, 'identical pending queries are deduplicated')
  page.data.filterDate = '2099-12-01'
  const current = page.reFetchOrders()
  assert.equal(requests.length, 6)
  assert.equal(requests[4].data.filterDate, '2099-12-01')
  for (const request of requests.slice(0, 3)) request.resolve([{ _id: 'old', city: '深圳市' }])
  await old
  assert.equal(page.data.loadingNearby, true); assert.equal(page.data.nearbyOrders.length, 0)
  for (const request of requests.slice(3)) request.resolve([{ _id: 'current', city: '深圳市' }])
  await current
  assert.equal(page.data.nearbyOrders[0]._id, 'current'); assert.equal(page.data.loadingNearby, false)
})

test('profile refresh invalidates old orders immediately and awaits its replacement order load', async () => {
  const { page, requests } = workbenchFixture()
  const old = page.loadNearby({ latitude: 22.5, longitude: 114 }, '旧参考位置')
  let finished = false
  const refresh = page.reFetchOrders().then(() => { finished = true })
  for (const request of requests.slice(0, 3)) request.resolve([{ _id: 'old', city: '深圳市' }])
  await old
  assert.equal(page.data.nearbyOrders.length, 0)
  requests[3].resolve({ auditStatus: 'approved', serviceCity: '深圳市', serviceLatitude: 22.6, serviceLongitude: 114.1 })
  await settle()
  assert.equal(finished, false); assert.equal(requests[5].data.latitude, 22.6)
  for (const request of requests.slice(4)) request.resolve([{ _id: 'fresh', city: '深圳市' }])
  await refresh
  assert.equal(page.data.nearbyOrders[0]._id, 'fresh'); assert.equal(finished, true)
})

test('late workbench profiles and responses after unload cannot change the current reference', async () => {
  const { page, requests } = workbenchFixture()
  const old = page.initStaffHome(), current = page.initStaffHome()
  requests[1].resolve({ auditStatus: 'approved', serviceCity: '杭州市', serviceLatitude: 30.2, serviceLongitude: 120.2 })
  await settle()
  requests[0].resolve({ auditStatus: 'approved', serviceCity: '深圳市', serviceLatitude: 22.5, serviceLongitude: 114 })
  await old
  assert.equal(requests.length, 5); assert.equal(page.data.selectedCity, '杭州市')
  page.onUnload()
  for (const request of requests.slice(2)) request.resolve([{ _id: 'late', city: '杭州市' }])
  await current
  assert.equal(page.data.nearbyOrders.length, 0)
})

test('clearing the map city invalidates pending results without repopulating markers', async () => {
  const { page, requests } = pageFixture({ data: { selected: null } })
  const pending = page.refresh()
  page.inputCity({ detail: { value: '' } }); page.confirmCity()
  assert.equal(page.data.city, '')
  requests[0].resolve({ communities: [{ _id: 'old', latitude: 31.2, longitude: 121.5, count: 5 }] }); await pending
  assert.equal(page.data.markers.length, 0); assert.equal(page.data.visibleCount, 0)
  assert.equal(page._communities.length, 0); assert.ok(page.data.error)
})

test('native gesture-begin cancels a pending GPS fix before the gesture ends', async () => {
  let fix
  const { page } = pageFixture({ wx: { getLocation(args) { fix = args } } })
  page.moveCamera({ latitude: 31.2, longitude: 121.5 })
  const pending = page.locate(); await settle()
  page.regionChanged({ type: 'regionchange', detail: { type: 'begin', causedBy: 'gesture' } })
  assert.equal(page.data.locating, false); assert.equal(page._cameraTarget, null)
  fix.success({ latitude: 31.8, longitude: 121.8 }); await pending
  assert.equal(page.data.latitude, 31.2)
})

test('camera callbacks without a cause cannot restore a stale command over a new zoom', async () => {
  const { page } = pageFixture()
  page._map = { getRegion: args => args.success({}), getScale: args => args.success({ scale: 13 }),
    getCenterLocation: args => args.success({ latitude: 31.2, longitude: 121.5 }) }
  page.zoom({ currentTarget: { dataset: { step: 1 } } })
  await page.regionChanged({ type: 'end' })
  assert.equal(page._viewport.scale, 14); assert.equal(page.data.zoomScale, 14)
})

test('an open cluster selector revalidates counts and removes vanished communities', () => {
  const { page, requests } = pageFixture({ data: { clusterChoices: [{ _id: 'a', count: 3 }, { _id: 'b', count: 4 }] } })
  page._communities = [{ _id: 'b', latitude: 31.2, longitude: 121.5, count: 1 }]
  page.renderMarkers()
  assert.equal(page.data.clusterChoices.length, 1); assert.equal(page.data.clusterChoices[0].count, 1)
  page.chooseClusterMember({ currentTarget: { dataset: { id: 'a' } } })
  assert.equal(requests.length, 0)
  page.data.clusterChoices = [{ _id: 'b' }]; page.closePanel()
  assert.equal(page.data.clusterChoices, null)
})

test('workbench reference queries never persist a manually selected point as current GPS', async () => {
  const { page, requests } = workbenchFixture()
  const load = page.loadNearby({ latitude: 31.2, longitude: 121.5 }, '手动参考位置')
  assert.deepEqual(requests.map(request => request.action), ['listDirectOrders', 'listNearbyOrders', 'listUrgentOrders'])
  for (const request of requests) request.resolve([])
  await load
})

test('workbench picker callbacks and authorization cannot reopen or change an unloaded page', async () => {
  let authorize, pickerCalls = 0
  const first = workbenchFixture({ cloud: { requirePrivacyAuthorize: () => new Promise(resolve => { authorize = resolve }) },
    wx: { chooseLocation() { pickerCalls++ } } })
  const beforePicker = first.page.refreshNearby()
  first.page.onUnload(); authorize(); await beforePicker
  assert.equal(pickerCalls, 0); assert.equal(first.requests.length, 0)
  let complete
  const second = workbenchFixture({ wx: { chooseLocation(args) { complete = args.success } } })
  const afterPicker = second.page.refreshNearby(); await settle()
  second.page.onUnload(); complete({ latitude: 30.2, longitude: 120.2, city: '杭州市' }); await afterPicker
  assert.equal(second.page.data.customLocation, null); assert.equal(second.requests.length, 0)
})

test('workbench pagination updates repeated records and preserves unique cards', async () => {
  const { page, requests } = workbenchFixture({ data: { currentWorkbenchLocation: { latitude: 22.5, longitude: 114 },
    nearbyOrders: [{ _id: 'a', city: '深圳市', serviceSummary: '旧标题' }], nearbyPage: 1, nearbyHasMore: true } })
  const more = page.loadMoreNearby()
  requests[0].resolve({ list: [{ _id: 'a', city: '深圳市', serviceSummary: '新标题' }, { _id: 'b', city: '深圳市' }], page: 2, hasMore: false })
  await more
  assert.equal(page.data.nearbyOrders.length, 2); assert.equal(page.data.nearbyOrders[0].serviceSummary, '新标题')
  assert.equal(page.data.nearbyPage, 2)
})

test('clearing a missing saved workbench reference invalidates older order loads', async () => {
  const { page, requests } = workbenchFixture({ cloud: { getSelectedLocation: () => null }, data: { urgentOrders: [{ _id: 'urgent' }] } })
  const old = page.loadNearby({ latitude: 22.5, longitude: 114 }, '旧参考位置')
  page.loadNearbyWithSavedLocation()
  for (const request of requests) request.resolve([{ _id: 'old', city: '深圳市' }])
  await old
  assert.equal(page.data.urgentOrders.length, 0); assert.equal(page.data.nearbyOrders.length, 0)
  assert.equal(page.data.locationReady, false); assert.equal(page.data.currentWorkbenchLocation, null)
})

test('a refused initial GPS request still fits the city after its points finish loading', async () => {
  let fix, fits = 0
  const { page, requests } = pageFixture({ data: { selected: null }, wx: { getLocation(args) { fix = args } } })
  page._map = { includePoints() { fits++ } }
  const gps = page.locate(), load = page.refresh(); await settle()
  requests[0].resolve({ communities: [{ _id: 'a', latitude: 31.2, longitude: 121.5, count: 2 }] }); await load
  assert.equal(fits, 0)
  fix.fail({ errMsg: 'getLocation:fail denied' }); await gps
  assert.equal(fits, 1); assert.equal(page.data.locating, false)
})
