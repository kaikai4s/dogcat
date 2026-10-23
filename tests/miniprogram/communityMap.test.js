const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { clusterCommunities } = require('../../miniprogram/utils/community-map')

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
function pageFixture() {
  let page
  const requests = []
  vm.runInNewContext(fs.readFileSync(require.resolve('../../miniprogram/pages/common/community-map/index.js'), 'utf8'), {
    Page(value) { page = value }, require(name) { return name.endsWith('community-map') ? require('../../miniprogram/utils/community-map') : {
      callFunction(module, action, data) { return new Promise((resolve, reject) => requests.push({ module, action, data, resolve, reject })) }
    } }, wx: {}, setTimeout, clearTimeout
  })
  page.data = { ...page.data, city: '上海市', selected: { _id: 'a', name: 'A' } }
  page._panelSeq = 0
  page.setData = function (patch) { Object.assign(this.data, patch) }
  return { page, requests }
}
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
