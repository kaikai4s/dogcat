const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('petBeauty performance: createPet and updatePet maintain hasBeautyPhotos and beautyPhotoCount flags', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'client_owner', roles: ['client'], status: 'active' }
    ],
    pets: []
  })

  const clientFn = loadCloudFunction('api', db, 'client_owner')

  // 1. 创建宠物时自动打标 hasBeautyPhotos 与 beautyPhotoCount
  const createRes = await clientFn.main({
    module: 'pet',
    action: 'createPet',
    data: {
      name: '乐乐',
      species: 'dog',
      avatarFileId: 'cloud://avatar1.jpg',
      beautyPhotos: [
        { fileId: 'cloud://avatar1.jpg' }
      ]
    }
  })
  assert.equal(createRes.ok, true)
  const petId = createRes.data._id
  const savedPet = db.state.pets.find((p) => p._id === petId)
  assert.equal(savedPet.hasBeautyPhotos, true)
  assert.equal(savedPet.beautyPhotoCount, 1)

  // 2. 更新宠物（增加美照）时更新打标字段
  const updateRes = await clientFn.main({
    module: 'pet',
    action: 'updatePet',
    data: {
      id: petId,
      name: '乐乐改名',
      avatarFileId: 'cloud://avatar1.jpg',
      beautyPhotos: [
        { fileId: 'cloud://avatar1.jpg' },
        { fileId: 'cloud://photo2.jpg' }
      ]
    }
  })
  assert.equal(updateRes.ok, true)
  const updatedPet = db.state.pets.find((p) => p._id === petId)
  assert.equal(updatedPet.hasBeautyPhotos, true)
  assert.equal(updatedPet.beautyPhotoCount, 2)
})

test('petBeauty performance: readBeautyCandidatePets queries via hasBeautyPhotos: true and gracefully fallbacks for legacy data', async () => {
  // 构造场景：系统中有大量未打标的历史宠物以及新入驻打标宠物
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'client_1', roles: ['client'], status: 'active' }
    ],
    pets: [
      // 存量老宠物（未打标 hasBeautyPhotos，但有美照）
      { _id: 'legacy_with_photo_1', openid: 'client_legacy', name: '老宠1', beautyPhotos: [{ fileId: 'cloud://leg1.jpg' }] },
      { _id: 'legacy_with_photo_2', openid: 'client_legacy', name: '老宠2', beautyPhotos: [{ fileId: 'cloud://leg2.jpg' }] },
      // 无美照宠物
      { _id: 'legacy_no_photo', openid: 'client_legacy', name: '普通宠', beautyPhotos: [] }
    ],
    pet_beauty_votes: [],
    pet_beauty_month_locks: []
  })

  const clientFn = loadCloudFunction('api', db, 'client_1')

  // 1. 当数据库中全是存量数据（无 hasBeautyPhotos: true）时，降级扫描能够拉取到 2 只老宠
  const resLegacy = await clientFn.main({
    module: 'petBeauty',
    action: 'listCandidates',
    data: { page: 1, pageSize: 10 }
  })
  assert.equal(resLegacy.ok, true)
  assert.equal(resLegacy.data.total, 2)
  assert.deepEqual(resLegacy.data.list.map((p) => p.petId).sort(), ['legacy_with_photo_1', 'legacy_with_photo_2'])

  // 2. 模拟新宠物打标 hasBeautyPhotos: true
  db.state.pets.push({
    _id: 'new_indexed_pet',
    openid: 'client_new',
    name: '新星宠',
    hasBeautyPhotos: true,
    beautyPhotoCount: 1,
    beautyPhotos: [{ fileId: 'cloud://new1.jpg' }]
  })

  // 此时索引查询直接命中 hasBeautyPhotos: true
  const resIndexed = await clientFn.main({
    module: 'petBeauty',
    action: 'listCandidates',
    data: { page: 1, pageSize: 10 }
  })
  assert.equal(resIndexed.ok, true)
  assert.equal(resIndexed.data.list.some((p) => p.petId === 'new_indexed_pet'), true)
})

test('petBeauty performance: syncBeautyPhotoFlags backfills legacy pets and rejects non-admin', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'admin_openid', roles: ['admin'], status: 'active' },
      { _id: 'u_client', openid: 'client_openid', roles: ['client'], status: 'active' }
    ],
    pets: [
      { _id: 'p_legacy_1', openid: 'client_openid', name: '旧宠1', beautyPhotos: [{ fileId: 'cloud://p1.jpg' }] },
      { _id: 'p_legacy_2', openid: 'client_openid', name: '旧宠2', beautyPhotos: [] }
    ]
  })

  const clientFn = loadCloudFunction('api', db, 'client_openid')
  const adminFn = loadCloudFunction('api', db, 'admin_openid')

  // 1. 非管理员调用被强拦截
  const forbiddenRes = await clientFn.main({
    module: 'petBeauty',
    action: 'syncBeautyPhotoFlags',
    data: {}
  })
  assert.equal(forbiddenRes.ok, false)
  assert.match(forbiddenRes.message, /无权操作|权限不足|仅管理员/)

  // 2. 管理员执行批量打标
  const syncRes = await adminFn.main({
    module: 'petBeauty',
    action: 'syncBeautyPhotoFlags',
    data: {}
  })
  assert.equal(syncRes.ok, true)
  assert.equal(syncRes.data.updatedCount, 2)

  const pet1 = db.state.pets.find((p) => p._id === 'p_legacy_1')
  assert.equal(pet1.hasBeautyPhotos, true)
  assert.equal(pet1.beautyPhotoCount, 1)

  const pet2 = db.state.pets.find((p) => p._id === 'p_legacy_2')
  assert.equal(pet2.hasBeautyPhotos, false)
  assert.equal(pet2.beautyPhotoCount, 0)
})

test('petBeauty performance: settleMonthlyRanking efficiently targets voted pets', async () => {
  const monthKey = '2026-09'
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'admin_openid', roles: ['admin'], status: 'active' }
    ],
    pets: [
      { _id: 'p_voted', openid: 'owner_1', name: '票王宠', hasBeautyPhotos: true, beautyPhotos: [{ fileId: 'cloud://p1.jpg' }] },
      { _id: 'p_unvoted', openid: 'owner_2', name: '无票宠', hasBeautyPhotos: true, beautyPhotos: [{ fileId: 'cloud://p2.jpg' }] }
    ],
    pet_beauty_votes: [
      { _id: 'v_1', monthKey, petId: 'p_voted', createdAt: '2026-09-10T10:00:00+08:00' },
      { _id: 'v_2', monthKey, petId: 'p_voted', createdAt: '2026-09-11T10:00:00+08:00' }
    ],
    pet_beauty_month_locks: [],
    pet_beauty_month_rankings: []
  })

  const adminFn = loadCloudFunction('api', db, 'admin_openid')

  const res = await adminFn.main({
    module: 'petBeauty',
    action: 'settleMonthlyRanking',
    data: { monthKey, force: true }
  })

  assert.equal(res.ok, true)
  assert.equal(res.data.topCount, 1)

  const rankDoc = db.state.pet_beauty_month_rankings[0]
  assert.ok(rankDoc)
  assert.equal(rankDoc.petId, 'p_voted')
  assert.equal(rankDoc.rank, 1)
  assert.equal(rankDoc.voteCount, 2)
})
