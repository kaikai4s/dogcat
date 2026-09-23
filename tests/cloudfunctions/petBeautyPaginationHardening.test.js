const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createPetBeautyService = require('../../cloudfunctions/api/services/petBeauty')
const createContext = require('../../cloudfunctions/api/services/context')
const timeUtils = require('../../cloudfunctions/api/utils/time')

// 模拟真实微信云数据库单次 .get() 最多返回 100 条数据的硬限制
function cappedStore(initial) {
  const db = createCollectionStore(initial)
  const collection = db.collection
  db.collection = (name) => {
    const query = collection(name)
    const get = query.get.bind(query)
    query.get = async () => ({ data: (await get()).data.slice(0, 100) })
    return query
  }
  return db
}

test('countPetBeautyVotes accurately counts more than 100 votes without silent truncation', async () => {
  const monthKey = '2026-09'
  // 构造 150 笔有效投票：pet_target 获得 115 票，pet_other 获得 35 票
  const votes = [
    ...Array.from({ length: 115 }, (_, i) => ({
      _id: `v_target_${String(i + 1).padStart(4, '0')}`,
      monthKey,
      petId: 'pet_target',
      createdAt: '2026-09-15T12:00:00+08:00'
    })),
    ...Array.from({ length: 35 }, (_, i) => ({
      _id: `v_other_${String(i + 1).padStart(4, '0')}`,
      monthKey,
      petId: 'pet_other',
      createdAt: '2026-09-15T13:00:00+08:00'
    }))
  ]

  const db = cappedStore({
    pet_beauty_votes: votes
  })

  const context = createContext({ db, cloud: {}, ...timeUtils })
  const service = createPetBeautyService(context)

  // 执行票数统计
  const voteMap = await service.countPetBeautyVotes(monthKey)

  // 验证：即使云数据库单次 .get() 最多返回 100 条，也能完整统计到 115 票和 35 票，绝不被截断在 100 票
  assert.equal(voteMap.pet_target, 115, 'pet_target must accurately receive all 115 votes')
  assert.equal(voteMap.pet_other, 35, 'pet_other must accurately receive all 35 votes')
})

test('getPublicPetsWithVotes retrieves candidate pets beyond 100 items under capped queries', async () => {
  const monthKey = '2026-09'
  // 构造 125 只宠物，其中包含 110 只带美照参赛宠物，前 100 只以外的宠物也有美照和投票
  const totalPets = 125
  const pets = Array.from({ length: totalPets }, (_, i) => ({
    _id: `pet_${String(i + 1).padStart(4, '0')}`,
    openid: `owner_${i + 1}`,
    name: `宠物_${i + 1}`,
    species: i % 2 === 0 ? 'dog' : 'cat',
    beautyPhotos: i < 110 ? [`cloud://photo_${i + 1}.jpg`] : [], // 前 110 只参赛
    createdAt: new Date(1700000000000 + i * 1000).toISOString()
  }))

  // 给第 105 号宠物（位于前 100 之外）投 50 票，使其进入榜首
  const votes = Array.from({ length: 50 }, (_, i) => ({
    _id: `v_late_${String(i + 1).padStart(4, '0')}`,
    monthKey,
    petId: 'pet_0105',
    createdAt: '2026-09-15T10:00:00+08:00'
  }))

  const db = cappedStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active' }],
    pets,
    pet_beauty_votes: votes,
    pet_beauty_month_locks: []
  })

  const fn = loadCloudFunction('api', db, 'openid_client')

  // 调用 listRanking 查看榜单
  const res = await fn.main({
    module: 'petBeauty',
    action: 'listRanking',
    data: { monthKey, page: 1, pageSize: 20 }
  })

  assert.equal(res.ok, true)
  assert.equal(res.data.total, 110, 'Total candidate pets must be 110 (beyond 100 limit)')
  // 第 105 号宠物排在第 1 名
  assert.equal(res.data.list[0].petId, 'pet_0105')
  assert.equal(res.data.list[0].voteCount, 50)
  assert.equal(res.data.list[0].rank, 1)

  // 调用 getActivityHome 首页聚合展示
  const homeRes = await fn.main({
    module: 'petBeauty',
    action: 'getActivityHome',
    data: { monthKey }
  })

  assert.equal(homeRes.ok, true)
  assert.equal(homeRes.data.candidates.length, 12)
  assert.equal(homeRes.data.ranking.length, 10)
  assert.equal(homeRes.data.ranking[0].petId, 'pet_0105')
})
