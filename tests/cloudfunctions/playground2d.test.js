const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createHandler = require('../../cloudfunctions/api/handlers/playground')
const { ownerId } = require('../../cloudfunctions/api/services/playground-world')

function createTestContext(dbState, openid = 'test_owner') {
  const db = createCollectionStore(dbState)
  const context = {
    db,
    getUser: async () => db.state.users.find((user) => user.openid === openid) || {
      _id: `u_${openid}`,
      openid,
      role: 'client'
    },
    safeText: (value) => String(value || '').trim(),
    nowText: () => '2026-10-16T16:30:00.000Z'
  }
  return { db, handler: createHandler(context), openid }
}

test('playground overview returns 2D map state without model fields', async () => {
  const ownerOpenid = 'test_owner'
  const { db, handler, openid } = createTestContext({
    users: [{ _id: 'u_owner', openid: ownerOpenid, role: 'client', status: 'active' }],
    pet_playgrounds: [{
      _id: 'pg_legacy',
      ownerOpenid,
      theme: 'sunny_garden',
      maxVisiblePets: 8,
      camera: { x: 0, y: 8, z: 12 }
    }],
    pet_homes: [{
      _id: 'home_legacy',
      ownerOpenid,
      playgroundId: 'pg_legacy',
      petId: 'pet_01',
      position: { x: 1, y: 0, z: 2 },
      rotation: { x: 0, y: 0, z: 0 },
      style: 'wood'
    }],
    pet_playground_entities: [{
      _id: 'entity_legacy',
      ownerOpenid,
      playgroundId: 'pg_legacy',
      petId: 'pet_01',
      position: { x: 2, y: 0, z: 3 },
      activeModelType: 'custom',
      activeModelUrl: 'cloud://legacy/model.glb',
      equippedOutfitModelId: 'outfit_legacy',
      currentAction: 'idle',
      mood: 'happy'
    }],
    pets: [{
      _id: 'pet_01',
      openid: ownerOpenid,
      name: '豆豆',
      species: 'dog',
      breed: '金毛',
      personality: '亲人',
      avatarFileId: 'cloud://avatar/doudou.png'
    }]
  })

  const result = await handler(openid, 'getOverview')
  assert.equal(result.pets.length, 1)
  assert.equal(result.pets[0].name, '豆豆')
  assert.equal(result.pets[0].avatarFileId, 'cloud://avatar/doudou.png')
  assert.equal(result.entities.length, 1)
  assert.equal(result.entities[0].currentAction, 'idle')
  assert.equal(result.entities[0].mood, 'happy')
  assert.ok(Number.isFinite(result.entities[0].position.x))
  assert.ok(Number.isFinite(result.entities[0].position.z))
  assert.equal(Object.hasOwn(result.entities[0].position, 'y'), false)
  assert.equal(Object.hasOwn(result.entities[0], 'activeModelUrl'), false)
  assert.equal(Object.hasOwn(result.entities[0], 'activeModelType'), false)
  assert.equal(Object.hasOwn(result.entities[0], 'equippedOutfitModelId'), false)
  assert.equal(Object.hasOwn(result.homes[0], 'rotation'), false)
  assert.equal(Object.hasOwn(result.homes[0].position, 'y'), false)
  assert.equal(Object.hasOwn(result.playground, 'camera'), false)
  assert.equal(Object.hasOwn(result.pets[0], 'customModelUrl'), false)
  assert.equal(db.state.pet_3d_models, undefined)
})

test('playground rejects removed model actions', async () => {
  const ownerOpenid = 'test_owner'
  const { handler, openid } = createTestContext({
    users: [{ _id: 'u_owner', openid: ownerOpenid, role: 'client' }],
    pets: [{ _id: 'pet_01', openid: ownerOpenid, name: '豆豆', species: 'dog' }]
  })

  await assert.rejects(
    () => handler(openid, 'updatePetModel', { petId: 'pet_01' }),
    /未知 playground 操作/
  )
})

test('individual pet sizes persist in the overview without changing other pets', async () => {
  const { handler, openid, db } = createTestContext({
    users: [],
    pets: [
      { _id: 'dog', openid: 'test_owner', species: 'dog' },
      { _id: 'cat', openid: 'test_owner', species: 'cat' }
    ]
  })
  assert.deepEqual(await handler(openid, 'setPetScale', { petId: 'dog', scale: 1.75 }),
    { petId: 'dog', scale: 1.75 })
  const overview = await handler(openid, 'getOverview')
  assert.equal(overview.pets.find((p) => p._id === 'dog').playgroundScale, 1.75)
  assert.equal(overview.pets.find((p) => p._id === 'cat').playgroundScale, 1)
  assert.equal(db.state.pets.find((p) => p._id === 'cat').playgroundScale, undefined)
  await handler(openid, 'setPetScale', { petId: 'dog', scale: 1 })
  assert.equal(db.state.pets.find((p) => p._id === 'dog').playgroundScale, 1)
})

test('size changes reject invalid values, deleted pets and pets owned by others', async () => {
  const { handler, openid, db } = createTestContext({
    users: [],
    pets: [
      { _id: 'other', openid: 'another_owner', playgroundScale: 1 },
      { _id: 'deleted', openid: 'test_owner', deletedAt: '2026-10-17' }
    ]
  })
  for (const scale of [0, -1, 2.01, 0.49, NaN, Infinity, '1', null])
    await assert.rejects(handler(openid, 'setPetScale', { petId: 'other', scale }), /50%～200%/)
  for (const petId of ['other', 'deleted', 'missing'])
    await assert.rejects(handler(openid, 'setPetScale', { petId, scale: 1.5 }), /不存在或无权/)
  assert.equal(db.state.pets[0].playgroundScale, 1)
})

test('filling a dog bowl persists for its owner, is idempotent and rejects foreign or old plots', async () => {
  const {handler,openid,db}=createTestContext({
    users:[], pets:[],
    pet_playground_plots:[{_id:ownerId('test_owner'),kind:'owner_plot',
      ownerOpenid:'test_owner',plotId:'mine',x:84,z:84,size:48}]
  })
  await assert.rejects(handler(openid,'fillBowl',{plotId:'neighbor'}),/只能给自己/)
  await assert.rejects(handler(openid,'fillBowl',{}),/请选择/)
  const results=await Promise.all([handler(openid,'fillBowl',{plotId:'mine'}),handler(openid,'fillBowl',{plotId:'mine'})])
  assert.deepEqual(results,[{plotId:'mine',food:100},{plotId:'mine',food:100}])
  const overview=await handler(openid,'getOverview')
  assert.equal(overview.foodBowls.dog,100)
  const record=db.state.pet_playground_plots.find(p=>p._id===ownerId(openid))
  record.plotId='moved'
  await assert.rejects(handler(openid,'fillBowl',{plotId:'mine'}),/只能给自己/)
  await assert.rejects(handler('someone_else','fillBowl',{plotId:'moved'}),/只能给自己/)
})
