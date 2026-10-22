const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const optimistic = require('./optimisticTransactions')
const createContext = require('../../cloudfunctions/api/services/context')
const createRewardMail = require('../../cloudfunctions/api/handlers/rewardMail')

function fixture(reward, extra = {}) {
  const db = createCollectionStore({
    users: [{ _id: 'client', openid: 'client', status: 'active', roles: ['client'], points: 0, totalPoints: 0, retroCardCount: 0 }],
    reward_mails: [{ _id: 'mail', openid: 'client', title: '奖励', claimedAt: null, reward }],
    coupon_templates: [{ _id: 'coupon', enabled: true, perUserLimit: 1, totalIssueLimit: 1, issuedCount: 0 }],
    pet_titles: [{ _id: 'title', name: '宠物之星', enabled: true, duplicatePoints: 20 }],
    ...extra
  })
  const context = createContext({ db, cloud: {} })
  return { db, context, claim: () => createRewardMail(context)('client', 'claimReward', { id: 'mail' }) }
}

const rewards = [
  { type: 'points', points: 10 },
  { type: 'coupon', couponTemplateId: 'coupon' },
  { type: 'retro_card', count: 2 },
  { type: 'pet_title', titleId: 'title' }
]

for (const reward of rewards) {
  test(`${reward.type} mail reward rolls back when claim finalization fails and retries exactly once`, async () => {
    const { db, claim } = fixture(reward)
    const transaction = db.runTransaction
    db.runTransaction = callback => transaction(tx => callback({ collection(name) {
      const collection = tx.collection(name)
      if (name !== 'reward_mails') return collection
      return { ...collection, doc(id) {
        const document = collection.doc(id)
        return { ...document, update: async () => { throw new Error('claim finalization unavailable') } }
      } }
    } }))
    await assert.rejects(claim(), /claim finalization unavailable/)
    assert.equal(db.state.reward_mails[0].claimedAt, null)
    assert.equal(db.state.users[0].points, 0)
    assert.equal(db.state.users[0].retroCardCount, 0)
    assert.equal(db.state.coupon_templates[0].issuedCount, 0)
    for (const collection of ['point_logs', 'user_coupons', 'retro_card_logs', 'user_pet_titles', 'pet_title_grants']) {
      assert.equal((db.state[collection] || []).length, 0)
    }
    db.runTransaction = transaction
    const result = await claim()
    assert.ok(result.claimedAt)
    assert.deepEqual(await claim(), result)
    if (reward.type === 'points') assert.equal(db.state.users[0].points, 10)
    if (reward.type === 'coupon') {
      assert.equal(db.state.user_coupons.length, 1)
      assert.equal(db.state.coupon_templates[0].issuedCount, 1)
    }
    if (reward.type === 'retro_card') assert.equal(db.state.users[0].retroCardCount, 2)
    if (reward.type === 'pet_title') {
      assert.equal(db.state.user_pet_titles.length, 1)
      assert.equal(db.state.pet_title_grants.length, 1)
    }
  })

  test(`${reward.type} mail reward concurrent claims settle once`, async () => {
    const { db, claim } = fixture(reward)
    optimistic(db)
    const results = await Promise.all([claim(), claim()])
    assert.deepEqual(results[0], results[1])
    if (reward.type === 'points') {
      assert.equal(db.state.users[0].points, 10)
      assert.equal(db.state.point_logs.length, 1)
    }
    if (reward.type === 'coupon') {
      assert.equal(db.state.user_coupons.length, 1)
      assert.equal(db.state.coupon_templates[0].issuedCount, 1)
    }
    if (reward.type === 'retro_card') {
      assert.equal(db.state.users[0].retroCardCount, 2)
      assert.equal(db.state.retro_card_logs.length, 1)
    }
    if (reward.type === 'pet_title') {
      assert.equal(db.state.user_pet_titles.length, 1)
      assert.equal(db.state.pet_title_grants.length, 1)
    }
  })
}

test('duplicate title compensation rolls back with its mail claim', async () => {
  const { db, context, claim } = fixture({ type: 'pet_title', titleId: 'title' }, {
    user_pet_titles: [{ _id: 'legacy_title', openid: 'client', titleId: 'title' }]
  })
  context.formatRewardMail = () => { throw new Error('formatting unavailable') }
  await assert.rejects(claim(), /formatting unavailable/)
  assert.equal(db.state.users[0].points, 0)
  assert.equal((db.state.point_logs || []).length, 0)
  assert.equal((db.state.pet_title_grants || []).length, 0)
  assert.equal(db.state.reward_mails[0].claimedAt, null)
  context.formatRewardMail = mail => mail
  const result = await claim()
  assert.equal(result.rewardClaimResult.pointsDelta, 20)
  assert.equal(db.state.users[0].points, 20)
  assert.equal(db.state.user_pet_titles.length, 1)
})

test('coupon idempotency keys cannot issue a reward from another template', async () => {
  const { db, context } = fixture(rewards[1], {
    user_coupons: [{ _id: 'legacy', openid: 'client', templateId: 'other', idempotencyKey: 'same_key' }]
  })
  await assert.rejects(context.issueCouponToTargetUser(db.state.coupon_templates[0], db.state.users[0], {
    idempotencyKey: 'same_key'
  }), /幂等标识冲突/)
  assert.equal(db.state.user_coupons.length, 1)
  assert.equal(db.state.coupon_templates[0].issuedCount, 0)
})

test('coupon per-user limits count active coupons beyond the first hundred void records', async () => {
  const { db, context } = fixture(rewards[1], {
    user_coupons: Array.from({ length: 101 }, (_, index) => ({
      _id: `coupon_${String(index).padStart(3, '0')}`, openid: 'client', templateId: 'coupon',
      status: index < 100 ? 'void' : 'used'
    }))
  })
  await assert.rejects(context.issueCouponToTargetUser(db.state.coupon_templates[0], db.state.users[0]), /领取上限/)
  assert.equal(db.state.user_coupons.length, 101)
  assert.equal(db.state.coupon_templates[0].issuedCount, 0)
})

test('coupon issuance reads the current template rather than a stale caller snapshot', async () => {
  const { db, context } = fixture(rewards[1])
  const staleTemplate = { ...db.state.coupon_templates[0], discountAmount: 5, validDays: 3 }
  Object.assign(db.state.coupon_templates[0], { discountAmount: 20, validDays: 7 })
  const result = await context.issueCouponToTargetUser(staleTemplate, db.state.users[0])
  assert.equal(result.templateSnapshot.discountAmount, 20)
  assert.equal(result.validTo.getTime() - result.validFrom.getTime(), 7 * 86400000)
})

test('AI model quotas persist across function instances and require an active user', async () => {
  const { db } = fixture(rewards[0])
  const first = loadCloudFunction('api', db, 'client')
  for (let index = 0; index < 10; index++) {
    const result = await first.main({ module: 'ai', action: 'generatePetVoice', data: { pet: { name: '豆豆' } } })
    assert.equal(result.ok, true, result.message)
  }
  const second = loadCloudFunction('api', db, 'client')
  const limited = await second.main({ module: 'ai', action: 'generatePetVoice', data: {} })
  assert.equal(limited.ok, false)
  assert.match(limited.message, /过于频繁/)
  db.state.users[0].status = 'disabled'
  const blocked = await second.main({ module: 'ai', action: 'generatePetVoice', data: {} })
  assert.equal(blocked.ok, false)
  assert.match(blocked.message, /请先登录/)
})

test('rate-limit storage read failures fail closed instead of resetting the quota', async () => {
  const { db, context } = fixture(rewards[0])
  db.runTransaction = callback => callback({ collection() { return { doc() { return {
    get: async () => { throw new Error('rate limit storage unavailable') },
    set: async () => assert.fail('must not reset the quota after a read failure')
  } } } } })
  await assert.rejects(context.checkRateLimit('client', 'ai.model'), /rate limit storage unavailable/)
})
