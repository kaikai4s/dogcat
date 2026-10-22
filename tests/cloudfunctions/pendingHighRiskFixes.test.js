const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createInitData = require('../../cloudfunctions/api/handlers/initData')
const createPetBeauty = require('../../cloudfunctions/api/services/petBeauty')
const createContext = require('../../cloudfunctions/api/services/context')
const time = require('../../cloudfunctions/api/utils/time')

test('initial administrator claims serialize and remain locked after account deactivation', async (context) => {
  const previousSecret = process.env.INIT_ADMIN_SECRET
  const previousPhones = process.env.INIT_ADMIN_PHONES
  process.env.INIT_ADMIN_SECRET = 'claim-secret'
  process.env.INIT_ADMIN_PHONES = '13900000001,13900000002'
  context.after(() => {
    if (previousSecret === undefined) delete process.env.INIT_ADMIN_SECRET
    else process.env.INIT_ADMIN_SECRET = previousSecret
    if (previousPhones === undefined) delete process.env.INIT_ADMIN_PHONES
    else process.env.INIT_ADMIN_PHONES = previousPhones
  })
  const db = createCollectionStore({ users: [
    { _id: 'first', openid: 'first', phone: '13900000001', roles: ['client'], status: 'active' },
    { _id: 'second', openid: 'second', phone: '13900000002', roles: ['client'], status: 'active' }
  ] })
  const handler = createInitData({ db, safeText: value => String(value || ''), now: time.now,
    getUser: async openid => structuredClone(db.state.users.find(user => user.openid === openid)) })
  const results = await Promise.allSettled(['first', 'second'].map(openid => handler(openid, 'claimInitialAdmin', { secret: 'claim-secret' })))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.match(results.find(result => result.status === 'rejected').reason.message, /初始管理员已存在/)
  const administrator = db.state.users.find(user => user.roles.includes('admin'))
  assert.equal(db.state.admin_access_config[0].claimedBy, administrator.openid)
  administrator.status = 'disabled'
  const other = db.state.users.find(user => !user.roles.includes('admin'))
  await assert.rejects(handler(other.openid, 'claimInitialAdmin', { secret: 'claim-secret' }), /初始管理员已存在/)
})

test('monthly vote counting includes votes after the former 5000 record boundary', async () => {
  const db = createCollectionStore({ pet_beauty_votes: Array.from({ length: 5101 }, (_, index) => ({
    _id: `vote_${String(index).padStart(5, '0')}`, petId: index < 5000 ? 'first' : 'second', monthKey: '2026-08'
  })) })
  const service = createPetBeauty(createContext({ db, cloud: {} }))
  const counts = await service.countPetBeautyVotes('2026-08', true)
  assert.equal(counts.first, 5000)
  assert.equal(counts.second, 101)
})

function prizeFixture() {
  const db = createCollectionStore({
    users: [{ _id: 'admin', openid: 'admin', roles: ['admin'], status: 'active' }],
    pets: [{ _id: 'winner', openid: 'client', name: 'winner' }],
    pet_beauty_month_rankings: [{ _id: 'rank', monthKey: '2026-08', rank: 1, petId: 'winner', prizeAmount: 500 }]
  })
  const api = loadCloudFunction('api', db, 'admin')
  return { db, grant: () => api.main({ module: 'petBeauty', action: 'grantPetBeautyChampionPrize', data: { monthKey: '2026-08' } }) }
}

test('concurrent champion prize grants credit the wallet only once', async () => {
  const { db, grant } = prizeFixture()
  const results = await Promise.all([grant(), grant()])
  assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results))
  assert.equal(db.state.user_asset_earnings.length, 1)
  assert.equal(db.state.user_asset_earnings[0].amount, 500)
  assert.equal(db.state.pet_beauty_month_rankings[0].prizeGranted, true)
})

test('champion prize rank update failure rolls back wallet credit and permits a retry', async () => {
  const { db, grant } = prizeFixture()
  const transaction = db.runTransaction
  db.runTransaction = callback => transaction(tx => callback({ collection(name) {
    const collection = tx.collection(name)
    if (name === 'pet_beauty_month_rankings') {
      const doc = collection.doc
      collection.doc = id => ({ ...doc(id), update: async () => { throw new Error('rank update unavailable') } })
    }
    return collection
  } }))
  const failed = await grant()
  assert.equal(failed.ok, false)
  assert.match(failed.message, /rank update unavailable/)
  assert.equal((db.state.user_asset_earnings || []).length, 0)
  assert.equal(db.state.pet_beauty_month_rankings[0].prizeGranted, undefined)
  db.runTransaction = transaction
  const retried = await grant()
  assert.equal(retried.ok, true, retried.message)
  assert.equal(db.state.user_asset_earnings.length, 1)
})
