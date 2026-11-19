const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createHandler = require('../../cloudfunctions/api/handlers/playground')
const createShared = require('../../cloudfunctions/api/services/playground-shared')
const world = require('../../cloudfunctions/api/services/playground-world')

function fixture() {
  const community = { name: '松溪小区', address: '一号路' }
  const db = createCollectionStore({ users: [
    { _id: 'user_a', openid: 'a', residentialCommunity: community },
    { _id: 'user_b', openid: 'b', residentialCommunity: community },
    { _id: 'user_c', openid: 'c', residentialCommunity: { name: '梅溪小区' } }
  ] })
  const context = { db, nowMs: () => 1_800_000_000_000, nowText: () => '2027-01-15T00:00:00Z',
    getUser: async openid => db.state.users.find(row => row.openid === openid), checkTextSecurity: async () => {} }
  const shared = createShared(context), handler = createHandler(context)
  const enter = async (openid, options = {}) => shared.enter(openid, await context.getUser(openid), options, [])
  const auth = ({ sceneId, session }) => ({ sceneId, session })
  const get = (openid, scene) => shared.snapshot(openid, auth(scene))
  const place = (openid, scene, overrides) => handler(openid, 'placeManor3dBuilding', {
    ...auth(scene), buildingId: 'songying_courtyard', plotId: 'M86', x: 14, z: 172, rotation: 90, ...overrides
  })
  return { db, community, enter, place, get, context }
}

test('placement validates actual rotated bounds and preserves both villa choices', async () => {
  const f = fixture(), scene = await f.enter('a', { solo: true })
  assert.equal(scene.canBuildManor3d, true)
  await assert.rejects(f.place('a', scene, { rotation: 0 }), /超出/)
  await assert.rejects(f.place('a', scene, { rotation: '90' }), /朝向/)
  await assert.rejects(f.place('a', scene, { x: 15.01 }), /超出/)
  await assert.rejects(f.place('a', scene, { z: 170.99 }), /超出/)
  await assert.rejects(f.place('a', scene, { x: '14' }), /位置无效/)
  await assert.rejects(f.place('a', scene, { buildingId: 'unknown', width: 1, depth: 1 }), /请选择可建造/)
  const red = { buildingId: 'red_tile_villa', plotId: 'M150', x: -106, z: 88, rotation: 270 }
  await assert.rejects(f.place('a', scene, { ...red, plotId: 'M151', x: 54 }), /不能建造/)
  await assert.rejects(f.place('a', scene, { ...red, plotId: 'M999' }), /不能建造/)
  const { record: courtyard } = await f.place('a', scene, { x: 15, z: 173 })
  const { record: redVilla } = await f.place('a', scene, red)
  assert.deepEqual([courtyard.x, courtyard.z, courtyard.rotation], [15, 173, 90])
  assert.deepEqual([redVilla.buildingId, redVilla.plotId, redVilla.rotation], [red.buildingId, red.plotId, red.rotation])
  const again = await f.enter('a', { solo: true })
  const stored = (await f.get('a', again)).records.filter(row => row.kind === 'manor3dBuilding')
  assert.deepEqual(new Map(stored.map(record => [record.id, record])), new Map([[courtyard.id, courtyard], [redVilla.id, redVilla]]))
  await assert.rejects(f.place('a', scene, { ...red, plotId: 'M72', x: -90, z: 124 }), /场景已切换/)
})

test('simultaneous community claims reserve one tile, publish safely and do not change 2D plots', async () => {
  const f = fixture()
  const user = await f.context.getUser('a')
  const existing = await world.create(f.context).claim('a', user, { x: 280, z: 280 })
  const a = await f.enter('a'), b = await f.enter('b'), c = await f.enter('c', { community: f.community })
  assert.equal(a.canBuildManor3d, true)
  assert.equal(b.canBuildManor3d, true)
  assert.equal(c.canBuildManor3d, false)
  await assert.rejects(f.place('c', c), /所属小区/)
  const legacyPlots = () => f.db.state.pet_playground_plots.filter(row => row.kind === 'plot')
  const before = structuredClone(legacyPlots())
  assert.ok(before.some(row => row._id === existing.id))
  const racing = await Promise.allSettled([f.place('a', a), f.place('b', b, { rotation: 270 })])
  assert.equal(racing.filter(result => result.status === 'fulfilled').length, 1)
  assert.match(racing.find(result => result.status === 'rejected').reason.message, /已经有建筑/)
  const winner = racing.findIndex(result => result.status === 'fulfilled')
  const owner = winner === 0 ? 'a' : 'b', scene = winner === 0 ? a : b
  const { record } = racing[winner].value
  assert.deepEqual((await f.place(owner, scene, { rotation: record.rotation })).record, record)
  assert.deepEqual(legacyPlots(), before)
  const visible = (await f.get('c', c)).records.find(row => row.id === record.id)
  assert.deepEqual(visible, { ...record, mine: false })
  assert.ok(!('ownerOpenid' in visible))
  const live = f.db.state.pet_playground_live.flatMap(doc => Object.values(doc.records || {})).find(row => row.id === record.id)
  const { mine, ...publicRecord } = visible
  assert.deepEqual(live, publicRecord)
  const solo = await f.enter(owner, { solo: true })
  const { record: soloRecord } = await f.place(owner, solo)
  assert.notEqual(soloRecord.id, record.id)
  assert.equal((await f.get(owner, solo)).records.some(row => row.id === record.id), false)
})

test('a scene credential no longer permits building after a residential community change', async () => {
  const f = fixture(), scene = await f.enter('a')
  await f.db.collection('users').doc('user_a').update({ data: { residentialCommunity: { name: '新小区' } } })
  await assert.rejects(f.place('a', scene), /所属小区/)
  assert.equal(f.db.state.pet_playground_plots.some(row => row.kind === 'manor3dBuilding'), false)
})
