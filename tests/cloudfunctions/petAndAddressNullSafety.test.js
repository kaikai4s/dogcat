const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('pet and address operations null safety: getPet, updatePet, deletePet, saveAddress, getClientPetsByIds', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u1', openid: 'openid_client_1', roles: ['client'], status: 'active', phone: '13800000001' },
      { _id: 'u2', openid: 'openid_client_2', roles: ['client'], status: 'active', phone: '13800000002' }
    ],
    pets: [
      {
        _id: 'pet_1',
        openid: 'openid_client_1',
        name: '旺财',
        species: 'dog',
        breed: '金毛',
        avatarFileId: 'cloud://photo_1.jpg',
        createdAt: '2026-09-01 10:00:00'
      },
      {
        _id: 'pet_other',
        openid: 'openid_client_2',
        name: '咪咪',
        species: 'cat',
        breed: '英短',
        avatarFileId: 'cloud://photo_2.jpg',
        createdAt: '2026-09-01 11:00:00'
      }
    ],
    user_addresses: [
      {
        _id: 'addr_1',
        openid: 'openid_client_1',
        label: '家',
        serviceAddress: '测试小区A栋',
        addressDetail: '1单元101',
        doorplate: '101',
        isDefault: true,
        updatedAt: '2026-09-01 10:00:00'
      },
      {
        _id: 'addr_other',
        openid: 'openid_client_2',
        label: '他人地址',
        serviceAddress: '远方小区B栋',
        addressDetail: '2单元202',
        doorplate: '202',
        isDefault: true,
        updatedAt: '2026-09-01 11:00:00'
      }
    ],
    user_pet_titles: [],
    platform_configs: []
  })

  const client1Api = loadCloudFunction('api', db, 'openid_client_1')

  // --- 1. getPet 测试 ---
  // 缺少 ID
  const getPetEmpty = await client1Api.main({ module: 'pet', action: 'getPet', data: {} })
  assert.equal(getPetEmpty.ok, false)
  assert.equal(getPetEmpty.message, '缺少宠物ID')

  // 不存在的 ID
  const getPetNonExistent = await client1Api.main({ module: 'pet', action: 'getPet', data: { id: 'non_existent_pet' } })
  assert.equal(getPetNonExistent.ok, false)
  assert.equal(getPetNonExistent.message, '宠物不存在')

  // 他人宠物
  const getPetOther = await client1Api.main({ module: 'pet', action: 'getPet', data: { id: 'pet_other' } })
  assert.equal(getPetOther.ok, false)
  assert.equal(getPetOther.message, '无权访问')

  // 正常访问本人宠物
  const getPetOk = await client1Api.main({ module: 'pet', action: 'getPet', data: { id: 'pet_1' } })
  assert.equal(getPetOk.ok, true)
  assert.equal(getPetOk.data._id, 'pet_1')
  assert.equal(getPetOk.data.name, '旺财')

  // --- 2. updatePet 测试 ---
  // 缺少 ID
  const updatePetEmpty = await client1Api.main({ module: 'pet', action: 'updatePet', data: {} })
  assert.equal(updatePetEmpty.ok, false)
  assert.equal(updatePetEmpty.message, '缺少宠物ID')

  // 不存在的 ID
  const updatePetNonExistent = await client1Api.main({ module: 'pet', action: 'updatePet', data: { id: 'non_existent_pet', avatarFileId: 'cloud://new.jpg' } })
  assert.equal(updatePetNonExistent.ok, false)
  assert.equal(updatePetNonExistent.message, '宠物不存在')

  // 他人宠物
  const updatePetOther = await client1Api.main({ module: 'pet', action: 'updatePet', data: { id: 'pet_other', avatarFileId: 'cloud://new.jpg' } })
  assert.equal(updatePetOther.ok, false)
  assert.equal(updatePetOther.message, '无权访问')

  // 正常更新本人宠物
  const updatePetOk = await client1Api.main({ module: 'pet', action: 'updatePet', data: { id: 'pet_1', name: '大旺财', avatarFileId: 'cloud://photo_1.jpg' } })
  assert.equal(updatePetOk.ok, true)
  const petInDb = db.state.pets.find((p) => p._id === 'pet_1')
  assert.equal(petInDb.name, '大旺财')

  // --- 3. deletePet 测试 ---
  // 缺少 ID
  const deletePetEmpty = await client1Api.main({ module: 'pet', action: 'deletePet', data: {} })
  assert.equal(deletePetEmpty.ok, false)
  assert.equal(deletePetEmpty.message, '缺少宠物ID')

  // 不存在的 ID
  const deletePetNonExistent = await client1Api.main({ module: 'pet', action: 'deletePet', data: { id: 'non_existent_pet' } })
  assert.equal(deletePetNonExistent.ok, false)
  assert.equal(deletePetNonExistent.message, '宠物不存在')

  // 他人宠物
  const deletePetOther = await client1Api.main({ module: 'pet', action: 'deletePet', data: { id: 'pet_other' } })
  assert.equal(deletePetOther.ok, false)
  assert.equal(deletePetOther.message, '无权访问')

  // 正常删除本人宠物
  const deletePetOk = await client1Api.main({ module: 'pet', action: 'deletePet', data: { id: 'pet_1' } })
  assert.equal(deletePetOk.ok, true)
  assert.equal(db.state.pets.some((p) => p._id === 'pet_1'), false)

  // 二次删除已被删除的宠物
  const deletePetAgain = await client1Api.main({ module: 'pet', action: 'deletePet', data: { id: 'pet_1' } })
  assert.equal(deletePetAgain.ok, false)
  assert.equal(deletePetAgain.message, '宠物不存在')

  // --- 4. saveAddress 编辑地址空判空测试 ---
  // 传入不存在的已删除地址 ID
  const saveAddressNonExistent = await client1Api.main({
    module: 'client',
    action: 'saveAddress',
    data: {
      id: 'non_existent_addr',
      serviceAddress: '新地址123号',
      addressDetail: '1单元101',
      doorplate: '101'
    }
  })
  assert.equal(saveAddressNonExistent.ok, false)
  assert.equal(saveAddressNonExistent.message, '地址不存在')

  // 传入他人地址 ID 进行越权修改
  const saveAddressOther = await client1Api.main({
    module: 'client',
    action: 'saveAddress',
    data: {
      id: 'addr_other',
      serviceAddress: '恶意修改地址',
      addressDetail: '2单元202',
      doorplate: '202'
    }
  })
  assert.equal(saveAddressOther.ok, false)
  assert.equal(saveAddressOther.message, '无权操作地址')

  // 正常修改本人地址
  const saveAddressOk = await client1Api.main({
    module: 'client',
    action: 'saveAddress',
    data: {
      id: 'addr_1',
      serviceAddress: '测试小区A栋-修改后',
      addressDetail: '1单元101',
      doorplate: '101'
    }
  })
  assert.equal(saveAddressOk.ok, true)
  const addrInDb = db.state.user_addresses.find((a) => a._id === 'addr_1')
  assert.equal(addrInDb.serviceAddress, '测试小区A栋-修改后')

  // --- 5. getClientPetsByIds 异常安全测试（通过下单校验宠物触发）---
  const orderResNonExistentPet = await client1Api.main({
    module: 'order',
    action: 'createOrder',
    data: {
      petId: 'pet_non_existent',
      serviceType: 'door_dog',
      serviceAddress: '测试小区A栋',
      addressDetail: '1单元101',
      doorplate: '101',
      startTime: '2099-01-01 10:00',
      endTime: '2099-01-01 11:00'
    }
  })
  assert.equal(orderResNonExistentPet.ok, false)
  assert.equal(orderResNonExistentPet.message, '宠物不存在')
})
