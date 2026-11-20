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
  const enter = async (openid, options = {}) => shared.enter(openid, await context.getUser(openid), { manor3d: true, ...options }, [])
  const auth = ({ sceneId, session }) => ({ sceneId, session })
  const get = (openid, scene) => shared.snapshot(openid, { ...auth(scene), manor3d: true })
  const place = (openid, scene, overrides) => handler(openid, 'placeManor3dBuilding', {
    ...auth(scene), buildingId: 'songying_courtyard', plotId: 'M86', x: 14, z: 172, rotation: 90, ...overrides
  })
  return { db, community, enter, place, get, auth, context, handler }
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

test('any active 3D community allows building while simultaneous claims reserve one tile', async () => {
  const f = fixture()
  const user = await f.context.getUser('a')
  const existing = await world.create(f.context).claim('a', user, { x: 280, z: 280 })
  const a = await f.enter('a'), b = await f.enter('b'), c = await f.enter('c', { community: f.community })
  assert.equal(a.canBuildManor3d, true)
  assert.equal(b.canBuildManor3d, true)
  assert.equal(c.canBuildManor3d, true)
  const legacyPlots = () => f.db.state.pet_playground_plots.filter(row => row.kind === 'plot')
  const before = structuredClone(legacyPlots())
  assert.ok(before.some(row => row._id === existing.id))
  const racing = await Promise.allSettled([f.place('a', a), f.place('b', b, { rotation: 270 }), f.place('c', c)])
  assert.equal(racing.filter(result => result.status === 'fulfilled').length, 1)
  assert.match(racing.find(result => result.status === 'rejected').reason.message, /已经有建筑/)
  const winner = racing.findIndex(result => result.status === 'fulfilled')
  const owner = ['a', 'b', 'c'][winner], scene = [a, b, c][winner]
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

test('an active 3D community session remains usable after the user changes residential community', async () => {
  const f = fixture(), scene = await f.enter('a')
  await f.db.collection('users').doc('user_a').update({ data: { residentialCommunity: { name: '新小区' } } })
  assert.equal(scene.canBuildManor3d, true)
  const { record } = await f.place('a', scene)
  assert.equal(record.kind, 'manor3dBuilding')
})

test('a red villa owns one private Copper GT whose position restores across entries', async () => {
  const f = fixture(), scene = await f.enter('a')
  const placement = { buildingId: 'red_tile_villa', plotId: 'M150', x: -106, z: 88, rotation: 270 }
  const placed = await f.place('a', scene, placement)
  assert.equal(placed.vehicle.kind, 'manor3dVehicle')
  assert.equal(placed.vehicle.ownerId, 'presence_' + world.hash('a'))
  const saved = f.db.state.pet_playground_plots.find(row => row._id === placed.vehicle.id)
  assert.equal(saved.ownerOpenid, 'a')
  assert.equal(saved.buildingId, placed.record.id)
  assert.equal(saved.position3d.y, 0)

  const moved = { x: saved.position3d.x + 4, y: 0, z: saved.position3d.z + 7 }
  const synced = await f.handler('a', 'syncManor3dVehicle', {
    ...f.auth(scene), seq: saved.seq + 1, position3d: moved, yaw: saved.yaw + .35, moving: true
  })
  assert.equal(synced.accepted, true)
  const parked = await f.handler('a', 'syncManor3dVehicle', {
    ...f.auth(scene), seq: synced.ackSeq + 1, position3d: moved, yaw: saved.yaw + .35, moving: false, online: false
  })
  assert.equal(parked.vehicle.online, false)

  const restored = await f.enter('a')
  assert.deepEqual(restored.manor3dVehicle.position3d, moved)
  assert.equal(restored.manor3dVehicle.yaw, saved.yaw + .35)
  assert.equal(restored.manor3dVehicle.seq, parked.ackSeq)
  const resumedSnapshot = await f.get('a', restored)
  assert.deepEqual(resumedSnapshot.records.find(row => row.id === saved._id), {
    ...restored.manor3dVehicle, mine: true
  })

  const visitor = await f.enter('b', { community: f.community })
  const publicCar = (await f.get('b', visitor)).records.find(row => row.id === saved._id)
  assert.equal(publicCar.ownerId, 'presence_' + world.hash('a'))
  assert.ok(!Object.hasOwn(publicCar, 'ownerOpenid'))
  await assert.rejects(f.handler('b', 'syncManor3dVehicle', {
    ...f.auth(visitor), seq: 1, position3d: moved, yaw: 0, moving: false
  }), /没有属于你的 Copper GT/)
})

test('the occupied community endpoint returns only the caller’s public home locations', async () => {
  const f = fixture(), solo = await f.enter('a', { solo: true })
  assert.equal(solo.hasAnyManor3dHome, false)
  await f.place('a', solo, { buildingId: 'red_tile_villa', plotId: 'M150', x: -106, z: 88, rotation: 0 })
  const firstCommunity = await f.enter('a')
  assert.equal(firstCommunity.hasAnyManor3dHome, false)
  await f.place('a', firstCommunity, { buildingId: 'red_tile_villa', plotId: 'M150', x: -106, z: 88, rotation: 0 })
  const scene = await f.enter('a')
  assert.equal(scene.hasAnyManor3dHome, true)
  const result = await f.handler('a', 'listManor3dHomes', {})
  assert.deepEqual(result.communities.map(item => ({ id: item.id, name: item.community.name, address: item.community.address })), [
    { id: scene.sceneId, name: f.community.name, address: f.community.address }
  ])
  assert.equal(JSON.stringify(result).includes('ownerOpenid'), false)
  assert.deepEqual(await f.handler('b', 'listManor3dHomes', {}), { communities: [] })
})

test('the occupied community endpoint resolves a legacy managed home after its owner changes communities', async () => {
  const f = fixture()
  const communityId = 'map_community_aaaaaaaaaaaaaaaaaaaaaaaa'
  const oldCommunity = { serviceCommunityId: communityId, name: '旧小区', city: '上海', district: '浦东', latitude: 31, longitude: 121 }
  await f.db.collection('platform_configs').doc(communityId).set({ data: {
    key: 'service_community', enabled: true, name: oldCommunity.name, city: oldCommunity.city,
    district: oldCommunity.district, latitude: oldCommunity.latitude, longitude: oldCommunity.longitude
  } })
  await f.db.collection('users').doc('user_a').update({ data: { residentialCommunity: oldCommunity } })
  const scene = await f.enter('a')
  const { record } = await f.place('a', scene, {
    buildingId: 'red_tile_villa', plotId: 'M150', x: -106, z: 88, rotation: 0
  })
  const savedHome = f.db.state.pet_playground_plots.find(row => row._id === record.id)
  delete savedHome.community
  await f.db.collection('users').doc('user_a').update({ data: {
    residentialCommunity: { name: '新小区', city: '上海', address: '二号路' }
  } })

  const result = await f.handler('a', 'listManor3dHomes', {})
  assert.deepEqual(result.communities.map(item => ({ id: item.id, name: item.community.name })), [
    { id: scene.sceneId, name: oldCommunity.name }
  ])
})

test('different owners in one community receive different cars bound to their own villas', async () => {
  const f = fixture(), a = await f.enter('a'), b = await f.enter('b')
  const first = await f.place('a', a, { buildingId: 'red_tile_villa', plotId: 'M150', x: -106, z: 88, rotation: 0 })
  const second = await f.place('b', b, { buildingId: 'red_tile_villa', plotId: 'M149', x: -266, z: 88, rotation: 0 })
  assert.notEqual(first.vehicle.id, second.vehicle.id)
  assert.equal(f.db.state.pet_playground_plots.find(row => row._id === first.vehicle.id).ownerOpenid, 'a')
  assert.equal(f.db.state.pet_playground_plots.find(row => row._id === first.vehicle.id).buildingId, first.record.id)
  assert.equal(f.db.state.pet_playground_plots.find(row => row._id === second.vehicle.id).ownerOpenid, 'b')
  assert.equal(f.db.state.pet_playground_plots.find(row => row._id === second.vehicle.id).buildingId, second.record.id)
})

test('2D playground entry sessions cannot create 3D buildings or sync 3D cars', async () => {
  const f = fixture(), scene = await f.enter('a', { manor3d: false })
  assert.equal(scene.canBuildManor3d, false)
  await assert.rejects(f.place('a', scene), /3D 小区建造/)
  assert.equal(f.db.state.pet_playground_plots.some(row => row.kind === 'manor3dBuilding'), false)
})
