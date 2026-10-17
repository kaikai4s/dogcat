const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createHandler = require('../../cloudfunctions/api/handlers/playground')

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
