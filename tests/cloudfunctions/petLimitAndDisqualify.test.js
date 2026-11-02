const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('createPet enforces maxPetsPerUser dynamic limit and idempotent submission', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client_1', openid: 'openid_client_1', roles: ['client'], status: 'active', phone: '13800000001' },
      { _id: 'u_admin_1', openid: 'openid_admin_1', roles: ['admin'], status: 'active' }
    ],
    pets: [
      { _id: 'pet_1', openid: 'openid_client_1', name: '咪咪1', species: 'cat', breed: '英短', exclusiveId: 'PID001', createdAt: new Date() },
      { _id: 'pet_2', openid: 'openid_client_1', name: '咪咪2', species: 'cat', breed: '美短', exclusiveId: 'PID002', createdAt: new Date() }
    ],
    platform_configs: [
      {
        _id: 'system_settings',
        key: 'system_settings',
        value: {
          maxPetsPerUser: 2 // Limit configured to 2
        }
      }
    ]
  })

  const clientApi = loadCloudFunction('api', db, 'openid_client_1')

  // 1. User has 2 pets and maxPetsPerUser is 2 -> creation should be blocked
  const resOverLimit = await clientApi.main({
    module: 'pet',
    action: 'createPet',
    data: {
      name: '超额新宠',
      species: 'dog',
      breed: '金毛',
      avatarFileId: 'cloud://test/avatar_dog.jpg'
    }
  })
  assert.equal(resOverLimit.ok, false)
  assert.match(resOverLimit.message, /最多添加 2 只宠物/)

  // 2. Admin increases limit to 5
  const adminApi = loadCloudFunction('api', db, 'openid_admin_1')
  const resSaveSettings = await adminApi.main({
    module: 'admin',
    action: 'saveSystemSettings',
    data: {
      maxPetsPerUser: 5
    }
  })
  assert.equal(resSaveSettings.ok, true)

  // 3. User can now create a pet
  const resCreateOk = await clientApi.main({
    module: 'pet',
    action: 'createPet',
    data: {
      name: '嘻嘻',
      species: 'cat',
      breed: '田园猫',
      avatarFileId: 'cloud://test/avatar.jpg'
    }
  })
  assert.equal(resCreateOk.ok, true)
  assert.equal(resCreateOk.data.name, '嘻嘻')
  const firstCreatedId = resCreateOk.data._id

  // 4. Test idempotency: user rapidly clicks again with the same name & breed
  const resDuplicateClick = await clientApi.main({
    module: 'pet',
    action: 'createPet',
    data: {
      name: '嘻嘻',
      species: 'cat',
      breed: '田园猫',
      avatarFileId: 'cloud://test/avatar.jpg'
    }
  })
  assert.equal(resDuplicateClick.ok, true)
  // Should return the exact same pet record instead of creating a second one
  assert.equal(resDuplicateClick.data._id, firstCreatedId)

  // Total pets in db for openid_client_1 should now be 3 (pet_1, pet_2, and one 嘻嘻)
  const clientPets = db.state.pets.filter(p => p.openid === 'openid_client_1')
  assert.equal(clientPets.length, 3)
})

test('petBeautyCandidate disqualification by exclusiveId and reinstatement', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin_1', openid: 'openid_admin_1', roles: ['admin'], status: 'active' },
      { _id: 'u_client_1', openid: 'openid_client_1', roles: ['client'], status: 'active' }
    ],
    pets: [
      {
        _id: 'pet_real',
        openid: 'openid_client_1',
        name: '真豆豆',
        species: 'dog',
        breed: '柯基',
        exclusiveId: 'P123456',
        avatarFileId: 'cloud://avatar1.jpg',
        beautyScore: 10
      },
      {
        _id: 'pet_ai_fake',
        openid: 'openid_client_1',
        name: '网图猫咪',
        species: 'cat',
        breed: '布偶',
        exclusiveId: 'PFSJP3F',
        avatarFileId: 'cloud://fake_ai.jpg',
        beautyScore: 50
      }
    ],
    platform_configs: []
  })

  const adminApi = loadCloudFunction('api', db, 'openid_admin_1')

  // 1. Disqualify using exclusiveId 'PFSJP3F'
  const resDisqualify = await adminApi.main({
    module: 'petBeauty',
    action: 'disqualifyPetBeautyCandidate',
    data: {
      petId: 'PFSJP3F',
      reason: 'AI生成图/网图'
    }
  })
  assert.equal(resDisqualify.ok, true)
  assert.equal(resDisqualify.data.beautyContestDisqualified, true)
  assert.equal(resDisqualify.data.disqualifiedReason, 'AI生成图/网图')

  // Check in db
  const fakePet = db.state.pets.find(p => p.exclusiveId === 'PFSJP3F')
  assert.equal(fakePet.beautyContestDisqualified, true)

  // 2. List disqualified candidates
  const resList = await adminApi.main({
    module: 'petBeauty',
    action: 'listDisqualifiedPetBeautyCandidates',
    data: {}
  })
  assert.equal(resList.ok, true)
  assert.equal(Array.isArray(resList.data), true)
  assert.equal(resList.data.length, 1)
  assert.equal(resList.data[0].exclusiveId, 'PFSJP3F')

  // 3. Reinstate pet by exclusiveId
  const resReinstate = await adminApi.main({
    module: 'petBeauty',
    action: 'reinstatePetBeautyCandidate',
    data: {
      petId: 'PFSJP3F'
    }
  })
  assert.equal(resReinstate.ok, true)
  assert.equal(resReinstate.data.beautyContestDisqualified, false)
  assert.equal(fakePet.beautyContestDisqualified, false)
})

test('deletePet cleans up pet_beauty_votes and pet_beauty_month_rankings', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client_1', openid: 'openid_client_1', roles: ['client'], status: 'active', phone: '13800000001' }
    ],
    pets: [
      { _id: 'pet_to_delete', openid: 'openid_client_1', name: '将删除宠', species: 'cat', breed: '美短', exclusiveId: 'PDEL001' }
    ],
    pet_beauty_votes: [
      { _id: 'vote_1', petId: 'pet_to_delete', monthKey: '2026-11', openid: 'other' }
    ],
    pet_beauty_month_rankings: [
      { _id: 'rank_1', petId: 'pet_to_delete', monthKey: '2026-10', rank: 5 }
    ],
    orders: []
  })

  const clientApi = loadCloudFunction('api', db, 'openid_client_1')
  const resDel = await clientApi.main({
    module: 'pet',
    action: 'deletePet',
    data: { id: 'pet_to_delete' }
  })
  assert.equal(resDel.ok, true)
  assert.equal(db.state.pets.some(p => p._id === 'pet_to_delete'), false)
  assert.equal(db.state.pet_beauty_votes.some(v => v.petId === 'pet_to_delete'), false)
  assert.equal(db.state.pet_beauty_month_rankings.some(r => r.petId === 'pet_to_delete'), false)
})

test('admin can toggle enableFrontendDisqualify in petBeautyContest config', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active' }
    ],
    platform_configs: []
  })

  const adminApi = loadCloudFunction('api', db, 'openid_admin')
  const clientApi = loadCloudFunction('api', db, 'openid_client')

  // 1. Default is enableFrontendDisqualify: true
  const resDefault = await clientApi.main({
    module: 'petBeauty',
    action: 'getContestConfig',
    data: {}
  })
  assert.equal(resDefault.ok, true)
  assert.equal(resDefault.data.enableFrontendDisqualify, true)

  // 2. Admin switches frontend disqualify toggle off
  const resSaveDisabled = await adminApi.main({
    module: 'admin',
    action: 'saveSystemSettings',
    data: {
      petBeautyContest: {
        enableFrontendDisqualify: false
      }
    }
  })
  assert.equal(resSaveDisabled.ok, true)

  // 3. Client checks contest config and home: enableFrontendDisqualify is false
  const resConfigDisabled = await clientApi.main({
    module: 'petBeauty',
    action: 'getContestConfig',
    data: {}
  })
  assert.equal(resConfigDisabled.ok, true)
  assert.equal(resConfigDisabled.data.enableFrontendDisqualify, false)

  const resHome = await clientApi.main({
    module: 'petBeauty',
    action: 'getActivityHome',
    data: {}
  })
  assert.equal(resHome.ok, true)
  assert.equal(resHome.data.contestConfig.enableFrontendDisqualify, false)

  // 4. Admin switches it back on
  const resSaveEnabled = await adminApi.main({
    module: 'admin',
    action: 'saveSystemSettings',
    data: {
      petBeautyContest: {
        enableFrontendDisqualify: true
      }
    }
  })
  assert.equal(resSaveEnabled.ok, true)

  const resConfigEnabled = await clientApi.main({
    module: 'petBeauty',
    action: 'getContestConfig',
    data: {}
  })
  assert.equal(resConfigEnabled.ok, true)
  assert.equal(resConfigEnabled.data.enableFrontendDisqualify, true)
})
