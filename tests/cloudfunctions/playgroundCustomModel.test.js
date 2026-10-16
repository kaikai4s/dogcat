const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createHandler = require('../../cloudfunctions/api/handlers/playground')

function createTestContext(dbState, openid = 'test_owner') {
  const db = createCollectionStore(dbState)
  const context = {
    db,
    getUser: async (id) => ({ _id: `u_${id}`, openid: id, role: 'client' }),
    safeText: (val) => String(val || '').trim(),
    nowText: () => '2026-10-16T16:30:00.000Z'
  }
  const handler = createHandler(context)
  return { db, handler, context, openid }
}

test('playground getOverview returns customModelUrl for pets with exclusive models', async () => {
  const { handler, openid } = createTestContext({
    users: [{ _id: 'u_1', openid: 'test_owner', role: 'client' }],
    pet_playgrounds: [],
    pet_homes: [],
    pet_playground_entities: [],
    pets: [
      {
        _id: 'pet_01',
        openid: 'test_owner',
        name: '旺财',
        species: 'dog',
        breed: '柯基',
        customModelUrl: 'cloud://cloud1.123/playground/custom_models/pet_01.glb'
      },
      {
        _id: 'pet_02',
        openid: 'test_owner',
        name: '咪咪',
        species: 'cat',
        breed: '布偶猫'
      }
    ]
  })

  const result = await handler(openid, 'getOverview')
  assert.ok(result.playground)
  assert.equal(result.pets.length, 2)
  const dog = result.pets.find(p => p._id === 'pet_01')
  const cat = result.pets.find(p => p._id === 'pet_02')
  assert.equal(dog.customModelUrl, 'cloud://cloud1.123/playground/custom_models/pet_01.glb')
  assert.equal(cat.customModelUrl, '')

  // 验证生成的实体中的 activeModelUrl 和 activeModelType
  const dogEntity = result.entities.find(e => e.petId === 'pet_01')
  assert.equal(dogEntity.activeModelType, 'custom')
  assert.equal(dogEntity.activeModelUrl, 'cloud://cloud1.123/playground/custom_models/pet_01.glb')
})

test('playground updatePetModel successfully binds exclusive model to own pet', async () => {
  const { handler, db, openid } = createTestContext({
    users: [{ _id: 'u_1', openid: 'test_owner', role: 'client' }],
    pet_playgrounds: [{ _id: 'pg_1', ownerOpenid: 'test_owner', name: '我的乐园' }],
    pet_homes: [],
    pet_playground_entities: [
      {
        _id: 'entity_01',
        ownerOpenid: 'test_owner',
        petId: 'pet_01',
        activeModelType: 'default',
        activeModelUrl: '',
        scale: 1
      }
    ],
    pets: [
      {
        _id: 'pet_01',
        openid: 'test_owner',
        name: '豆豆',
        species: 'dog',
        breed: '金毛'
      }
    ]
  })

  const updateResult = await handler(openid, 'updatePetModel', {
    petId: 'pet_01',
    modelUrl: 'cloud://cloud1.123/playground/custom_models/pet_01_golden.glb',
    scale: 1.2
  })

  assert.equal(updateResult.success, true)
  assert.equal(updateResult.petId, 'pet_01')

  // 验证数据库 pets 更新
  const updatedPet = db.state.pets.find(p => p._id === 'pet_01')
  assert.equal(updatedPet.customModelUrl, 'cloud://cloud1.123/playground/custom_models/pet_01_golden.glb')

  // 验证数据库 pet_playground_entities 更新
  const updatedEntity = db.state.pet_playground_entities.find(e => e.petId === 'pet_01')
  assert.equal(updatedEntity.activeModelType, 'custom')
  assert.equal(updatedEntity.activeModelUrl, 'cloud://cloud1.123/playground/custom_models/pet_01_golden.glb')
  assert.equal(updatedEntity.scale, 1.2)
})

test('playground updatePetModel rejects tampering other user pet', async () => {
  const { handler, openid } = createTestContext({
    users: [{ _id: 'u_1', openid: 'test_owner', role: 'client' }],
    pets: [
      {
        _id: 'other_pet',
        openid: 'other_user',
        name: '他人宠物'
      }
    ]
  })

  await assert.rejects(async () => {
    await handler(openid, 'updatePetModel', {
      petId: 'other_pet',
      modelUrl: 'cloud://cloud1.123/hack.glb'
    })
  }, /宠物档案不存在或无权配置/)
})

test('playground updatePetModel validates missing petId', async () => {
  const { handler, openid } = createTestContext({
    users: [{ _id: 'u_1', openid: 'test_owner', role: 'client' }],
    pets: []
  })

  await assert.rejects(async () => {
    await handler(openid, 'updatePetModel', {
      modelUrl: 'cloud://cloud1.123/hack.glb'
    })
  }, /缺少宠物ID/)
})
