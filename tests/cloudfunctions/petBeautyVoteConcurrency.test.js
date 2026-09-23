const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('petBeauty vote successfully casts vote with deterministic id vote_{openid}_{dateKey}', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_voter', roles: ['client'], status: 'active' }],
    pets: [
      {
        _id: 'pet_1',
        openid: 'openid_owner',
        name: '旺财',
        beautyPhotos: ['cloud://photo_1.jpg']
      }
    ],
    pet_beauty_votes: [],
    pet_beauty_month_locks: []
  })

  const fn = loadCloudFunction('api', db, 'openid_voter')

  const res = await fn.main({
    module: 'petBeauty',
    action: 'vote',
    data: { petId: 'pet_1' }
  })

  assert.equal(res.ok, true)
  assert.equal(res.data.hasVotedToday, true)
  assert.equal(res.data.petId, 'pet_1')
  assert.equal(res.data.voteCount, 1)

  // 验证写入的文档主键是确定性 ID
  const votes = db.state.pet_beauty_votes
  assert.equal(votes.length, 1)
  assert.equal(votes[0].openid, 'openid_voter')
  assert.equal(votes[0].petId, 'pet_1')
  assert.match(votes[0]._id, /^vote_openid_voter_\d{4}-\d{2}-\d{2}$/)
})

test('petBeauty vote rejects sequential duplicate votes on the same day', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_voter', roles: ['client'], status: 'active' }],
    pets: [
      {
        _id: 'pet_1',
        openid: 'openid_owner',
        name: '旺财',
        beautyPhotos: ['cloud://photo_1.jpg']
      }
    ],
    pet_beauty_votes: [],
    pet_beauty_month_locks: []
  })

  const fn = loadCloudFunction('api', db, 'openid_voter')

  // 第一次投票成功
  const firstRes = await fn.main({
    module: 'petBeauty',
    action: 'vote',
    data: { petId: 'pet_1' }
  })
  assert.equal(firstRes.ok, true)

  // 第二次投票被拦截
  const secondRes = await fn.main({
    module: 'petBeauty',
    action: 'vote',
    data: { petId: 'pet_1' }
  })
  assert.equal(secondRes.ok, false)
  assert.match(secondRes.message, /今天已经投过票了/)
})

test('petBeauty vote blocks concurrent duplicate votes through deterministic primary key', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_concurrent_voter', roles: ['client'], status: 'active' }],
    pets: [
      {
        _id: 'pet_concur',
        openid: 'openid_owner',
        name: '可乐',
        beautyPhotos: ['cloud://photo_c.jpg']
      }
    ],
    pet_beauty_votes: [],
    pet_beauty_month_locks: []
  })

  const fn = loadCloudFunction('api', db, 'openid_concurrent_voter')

  // 并发发起 10 个投票请求
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      fn.main({
        module: 'petBeauty',
        action: 'vote',
        data: { petId: 'pet_concur' }
      })
    )
  )

  const successCount = results.filter((r) => r.ok === true).length
  const failedCount = results.filter((r) => r.ok === false).length

  // 严格断言：只能有 1 个请求成功，其余 9 个全部失败
  assert.equal(successCount, 1, 'Only exactly 1 concurrent vote can succeed')
  assert.equal(failedCount, 9, 'All other 9 concurrent votes must be rejected')

  // 失败的错误信息必须全部提示“今天已经投过票了”
  results
    .filter((r) => r.ok === false)
    .forEach((r) => {
      assert.match(r.message, /今天已经投过票了/)
    })

  // 数据库中最终只有 1 票
  assert.equal(db.state.pet_beauty_votes.length, 1)
})

test('petBeauty vote validates pet existence and beauty photo prerequisite', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_voter', roles: ['client'], status: 'active' }],
    pets: [
      {
        _id: 'pet_no_photo',
        openid: 'openid_owner',
        name: '小黑',
        beautyPhotos: [] // 无美照
      }
    ],
    pet_beauty_votes: [],
    pet_beauty_month_locks: []
  })

  const fn = loadCloudFunction('api', db, 'openid_voter')

  // 1. 无美照不可投票
  const noPhotoRes = await fn.main({
    module: 'petBeauty',
    action: 'vote',
    data: { petId: 'pet_no_photo' }
  })
  assert.equal(noPhotoRes.ok, false)
  assert.match(noPhotoRes.message, /该宠物还没有美照/)

  // 2. 不存在的宠物
  const notFoundRes = await fn.main({
    module: 'petBeauty',
    action: 'vote',
    data: { petId: 'pet_non_existent' }
  })
  assert.equal(notFoundRes.ok, false)
  assert.match(notFoundRes.message, /宠物不存在/)
})
