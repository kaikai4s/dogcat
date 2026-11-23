const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

function createTestContext(db = createCollectionStore(), openid = 'openid_test') {
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database() { return db },
    getWXContext() { return { OPENID: openid } }
  }
  const createContext = require('../../cloudfunctions/api/services/context')
  return createContext({ cloud, db })
}

test('membership: normalizeMemberBadgeStyle preserves custom styles and defaults undefined to gold', () => {
  const context = createTestContext()
  assert.equal(context.normalizeMemberBadgeStyle(undefined), 'gold')
  assert.equal(context.normalizeMemberBadgeStyle(null), 'gold')
  assert.equal(context.normalizeMemberBadgeStyle('silver'), 'silver')
  assert.equal(context.normalizeMemberBadgeStyle('purple'), 'purple')
  assert.equal(context.normalizeMemberBadgeStyle('rainbow'), 'rainbow')
  assert.equal(context.normalizeMemberBadgeStyle('unknown_bad_style'), 'gold')
})

test('points: idempotencyKey allows multiple point rewards with same sourceType and sourceId (e.g. multi-day lottery)', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'user_a', points: 10, totalPoints: 10, status: 'active' }],
    point_logs: []
  })
  const context = createTestContext(db, 'user_a')

  // 第一次抽奖获得 5 积分
  const res1 = await context.addPoints(
    'user_a',
    'u1',
    5,
    'lottery',
    'act_lottery_1',
    '抽奖中奖',
    { idempotencyKey: 'lottery_act_lottery_1_user_a_2026-11-23' }
  )
  assert.equal(Boolean(res1.duplicate), false)
  assert.equal(res1.balance, 15)

  // 同一天同一幂等键重试，应返回 duplicate: true
  const resRetry = await context.addPoints(
    'user_a',
    'u1',
    5,
    'lottery',
    'act_lottery_1',
    '抽奖中奖',
    { idempotencyKey: 'lottery_act_lottery_1_user_a_2026-11-23' }
  )
  assert.equal(resRetry.duplicate, true)

  // 次日相同活动抽奖（不同幂等键），应成功入账而不被 sourceType+sourceId 误拦截
  const resNextDay = await context.addPoints(
    'user_a',
    'u1',
    5,
    'lottery',
    'act_lottery_1',
    '次日抽奖中奖',
    { idempotencyKey: 'lottery_act_lottery_1_user_a_2026-11-24' }
  )
  assert.equal(Boolean(resNextDay.duplicate), false)
  assert.equal(resNextDay.balance, 20)
})

test('retroCards: idempotencyKey protects rollback from being blocked by same-day legacy logs', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'user_b', retroCardCount: 1, status: 'active' }],
    retro_card_logs: []
  })
  const context = createTestContext(db, 'user_b')

  const res1 = await context.grantRetroCards(
    'user_b',
    'u1',
    1,
    'rollback',
    'order_1',
    '签到异常退回',
    { idempotencyKey: 'retro_rollback:2026-11-23:token_1' }
  )
  assert.equal(Boolean(res1.duplicate), false)
  assert.equal(res1.balance, 2)

  // 相同 idempotencyKey 返回重复
  const resDuplicate = await context.grantRetroCards(
    'user_b',
    'u1',
    1,
    'rollback',
    'order_1',
    '签到异常退回重试',
    { idempotencyKey: 'retro_rollback:2026-11-23:token_1' }
  )
  assert.equal(resDuplicate.duplicate, true)

  // 第二次异常退回（不同 attemptToken）能正常执行
  const res2 = await context.grantRetroCards(
    'user_b',
    'u1',
    1,
    'rollback',
    'order_1',
    '签到第二次异常退回',
    { idempotencyKey: 'retro_rollback:2026-11-23:token_2' }
  )
  assert.equal(Boolean(res2.duplicate), false)
  assert.equal(res2.balance, 3)
})

test('homeSecurity: multi-day order preserves common door lock password across intermediate sessions', async () => {
  const db = createCollectionStore({
    orders: [
      {
        _id: 'ord_multiday_1',
        isMultiDay: true,
        serviceDaysCount: 3,
        serviceSchedule: [
          { date: '2026-12-01', completed: true },
          { date: '2026-12-02', completed: false },
          { date: '2026-12-03', completed: false }
        ],
        hasDoorLockCode: true
      }
    ],
    order_home_security: [
      {
        _id: 'sec_1',
        orderId: 'ord_multiday_1',
        doorLockCode: '123456',
        passwordType: 'common',
        isDestroyed: false,
        isFullyDestroyed: false
      }
    ]
  })
  const context = createTestContext(db, 'staff_1')

  const res = await context.destroyOrderHomeSecuritySecrets('ord_multiday_1', { actor: 'staff_1', sessionIndex: 1 })

  assert.equal(res.destroyed, undefined)
  assert.equal(res.isFullyDestroyed, false)

  const updatedSec = (await db.collection('order_home_security').doc('sec_1').get()).data
  assert.equal(updatedSec.isFullyDestroyed, false)
  // 通用密码未被销毁
  assert.equal(updatedSec.doorLockCode, '123456')
})

test('serviceCatalog: normalizeServicePrice guards against NaN in pricing fields', () => {
  const context = createTestContext()
  const item = context.normalizeServicePrice({
    key: 'custom_service_key',
    name: '特殊定制服务',
    price: NaN,
    internPrice: 'invalid_price',
    extraPetFee: undefined,
    internExtraPetFee: null
  })

  assert.equal(item.price, 0)
  assert.equal(item.internPrice, 0)
  assert.equal(item.extraPetFee, 0)
  assert.equal(item.internExtraPetFee, 0)
})

test('questionnaires: detail populates couponSnapshot for reward display', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u_client', openid: 'client_openid', roles: ['client'], status: 'active' }],
    questionnaires: [
      {
        _id: 'q_1',
        title: '服务体验调研',
        status: 'published',
        targetRoles: ['client'],
        rewardConfig: {
          enabled: true,
          points: 50,
          couponTemplateId: 'tmpl_walk_20'
        },
        questions: []
      }
    ],
    coupon_templates: [
      {
        _id: 'tmpl_walk_20',
        name: '遛狗20元立减券',
        discountAmount: 20
      }
    ],
    questionnaire_responses: []
  })
  const fn = loadCloudFunction('api', db, 'client_openid')
  const detailRes = await fn.main({
    module: 'questionnaire',
    action: 'detail',
    data: { id: 'q_1' }
  })

  assert.equal(detailRes.ok, true)
  assert.equal(detailRes.data.title, '服务体验调研')
  assert.equal(detailRes.data.rewardConfig.points, 50)
  assert.equal(detailRes.data.rewardConfig.couponSnapshot.name, '遛狗20元立减券')
  assert.equal(detailRes.data.rewardConfig.couponSnapshot.discountAmount, 20)
})
