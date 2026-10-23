const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
function setup() {
  const db = createCollectionStore({
    users: [{ _id: 'a', openid: 'admin', roles: ['admin'], status: 'active' }, { _id: 'u', openid: 'user', roles: ['client'], status: 'active' }],
    platform_configs: [{ _id: 'settings', key: 'system_settings', value: { petBeautyContest: { enabled: false, firstPrizeAmount: 888 } } }],
    pets: [{ _id: 'pet', openid: 'user', name: '可乐', exclusiveId: 'P11111', beautyPhotos: [{ id: 'photo', fileId: 'cloud://photo' }], createdAt: '2026-10-01' }],
    pet_beauty_votes: [{ _id: 'v', petId: 'pet', monthKey: '2026-10' }]
  })
  const api = loadCloudFunction('api', db, 'admin')
  return { db, call: (action, data = {}) => api.main({ module: 'petBeauty', action, data: { monthKey: '2026-10', ...data } }) }
}
test('closed contest keeps ranking and monthly titles but zeroes public and settled prize amounts', async () => {
  const { db, call } = setup()
  const home = await call('getActivityHome')
  assert.equal(home.ok, true, home.message)
  assert.equal(home.data.contestConfig.enabled, false)
  assert.equal(home.data.contestConfig.firstPrizeAmount, 0)
  assert.equal(home.data.ranking.length, 1)
  assert.equal((await call('getContestConfig')).data.rewardAmount, 0)
  assert.equal((await call('listRanking')).data.list[0].prizeAmount, 0)
  const result = await call('settleMonthlyRanking')
  assert.equal(result.ok, true, result.message)
  assert.equal(result.data.firstPrizeAmount, 0)
  assert.equal(db.state.pet_beauty_month_rankings[0].prizeAmount, 0)
  assert.ok(db.state.pets[0].beautyTitle.title)
  assert.equal(db.state.pets[0].beautyTitle.rank, 1)
  assert.equal((await call('listMyBeautyTitles', { petId: 'pet' })).ok, false) // owner-only title selection remains protected
  assert.equal((db.state.user_asset_earnings || []).length, 0)
})
test('closed settlement cannot be turned into cash by reopening or passing a forged payout amount', async () => {
  const { db, call } = setup()
  await call('settleMonthlyRanking')
  const closed = await call('grantPetBeautyChampionPrize', { amount: 888 })
  assert.equal(closed.ok, false)
  assert.match(closed.message, /不发放现金奖金/)
  db.state.platform_configs[0].value.petBeautyContest.enabled = true
  const repaired = await call('settleMonthlyRanking', { force: true })
  assert.equal(repaired.ok, true, repaired.message)
  assert.equal(repaired.data.firstPrizeAmount, 0)
  const reopened = await call('grantPetBeautyChampionPrize', { amount: 999 })
  assert.equal(reopened.ok, false)
  assert.match(reopened.message, /未设置现金奖金/)
  assert.equal((db.state.user_asset_earnings || []).length, 0)
})
