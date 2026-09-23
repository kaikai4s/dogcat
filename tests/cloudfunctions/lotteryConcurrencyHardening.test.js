const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const optimistic = require('./optimisticTransactions')
const { toCstParts, now } = require('../../cloudfunctions/api/utils/time')

function setupLotteryTest(extra = {}) {
  const db = createCollectionStore({
    users: [
      { _id: 'u_user_a', openid: 'openid_a', nickname: '用户A', roles: ['client'], status: 'active', points: 0, totalPoints: 0 },
      { _id: 'u_user_b', openid: 'openid_b', nickname: '用户B', roles: ['client'], status: 'active', points: 0, totalPoints: 0 }
    ],
    member_levels: [
      { _id: 'lvl_1', name: '大众会员', minPoints: 0, pointMultiplier: 1 }
    ],
    coupon_templates: [
      {
        _id: 'tmpl_test_50',
        name: '立减50元券',
        discountAmount: 50,
        minOrderAmount: 100,
        validType: 'relative_days',
        validDays: 7,
        usageScope: 'all',
        enabled: true,
        issuedCount: 0
      }
    ],
    pet_titles: [
      {
        _id: 'title_lucky',
        name: '锦鲤本鲤',
        icon: '🐟',
        duplicatePoints: 10,
        enabled: true
      }
    ],
    lottery_activities: [
      {
        _id: 'act_concurrency',
        name: '并发抽奖活动测试',
        enabled: true,
        prizes: [
          {
            id: 'prize_coupon_1',
            type: 'coupon',
            name: '立减50元券',
            templateId: 'tmpl_test_50',
            probability: 50,
            stockLeft: 10
          },
          {
            id: 'prize_points_1',
            type: 'points',
            name: '66 积分',
            points: 66,
            probability: 50,
            stockLeft: 10
          }
        ]
      }
    ],
    lottery_records: [],
    user_coupons: [],
    point_logs: [],
    reward_mails: [],
    ...extra
  })
  return db
}

test('lottery: generates deterministic unique recordId using activity + openid + CST dateKey', async () => {
  const db = setupLotteryTest()
  const clientFn = loadCloudFunction('api', db, 'openid_a')

  const res = await clientFn.main({ module: 'lottery', action: 'draw' })
  assert.equal(res.ok, true)

  const { dateKey } = toCstParts(now())
  const expectedRecordId = `lottery_act_concurrency_openid_a_${dateKey}`

  const record = db.state.lottery_records.find(r => r._id === expectedRecordId)
  assert.ok(record, 'Record must exist with deterministic ID format')
  assert.equal(record.status, 'completed')
  assert.equal(record.activityId, 'act_concurrency')
  assert.equal(record.openid, 'openid_a')
  assert.equal(record.dateKey, dateKey)

  // 再次调用被拦截
  const secondDraw = await clientFn.main({ module: 'lottery', action: 'draw' })
  assert.equal(secondDraw.ok, false)
  assert.ok(secondDraw.message.includes('今天已参与过本次抽奖'))
})

test('lottery: concurrent draws by the same user only succeed once without duplicate awards or over-decrementing stock', async () => {
  const db = setupLotteryTest()
  const retries = optimistic(db)

  const initialStock = db.state.lottery_activities[0].prizes.reduce((sum, p) => sum + p.stockLeft, 0)

  // 同一用户并发发起 4 个抽奖请求
  const fnA = loadCloudFunction('api', db, 'openid_a')
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, () => fnA.main({ module: 'lottery', action: 'draw' }))
  )

  const successes = results.filter(r => r.status === 'fulfilled' && r.value.ok === true)
  const rejected = results.filter(r => r.status === 'fulfilled' && r.value.ok === false)

  assert.equal(successes.length, 1, 'Only exactly 1 concurrent draw request must succeed')
  assert.equal(rejected.length, 3, 'Remaining 3 requests must be rejected')
  for (const rej of rejected) {
    assert.ok(rej.value.message.includes('今天已参与过本次抽奖'))
  }

  // 记录数必须严格等于 1
  assert.equal(db.state.lottery_records.length, 1)

  // 总库存只扣减了 1
  const afterStock = db.state.lottery_activities[0].prizes.reduce((sum, p) => sum + p.stockLeft, 0)
  assert.equal(afterStock, initialStock - 1, 'Stock must only decrement by 1 across concurrent requests')

  // 发放的奖励（优惠券或积分流水）总数必须严格为 1
  const totalRewards = db.state.user_coupons.length + db.state.point_logs.length
  assert.equal(totalRewards, 1, 'Must only award reward once')
  assert.ok(retries() >= 0)
})

test('lottery: concurrent draws on last remaining prize unit will not oversell', async () => {
  const db = setupLotteryTest({
    lottery_activities: [
      {
        _id: 'act_single_stock',
        name: '仅剩1件绝版奖品',
        enabled: true,
        prizes: [
          {
            id: 'prize_limited_only',
            type: 'points',
            name: '绝版积分大礼',
            points: 100,
            probability: 100,
            stockLeft: 1 // 仅剩 1 件
          }
        ]
      }
    ]
  })
  optimistic(db)

  const fnA = loadCloudFunction('api', db, 'openid_a')
  const fnB = loadCloudFunction('api', db, 'openid_b')

  // 用户 A 和 用户 B 几乎同时发起抽奖
  const [resA, resB] = await Promise.all([
    fnA.main({ module: 'lottery', action: 'draw' }),
    fnB.main({ module: 'lottery', action: 'draw' })
  ])

  const successCount = [resA, resB].filter(r => r.ok === true).length
  const failCount = [resA, resB].filter(r => r.ok === false && r.message.includes('奖品已被领完')).length

  assert.equal(successCount, 1, 'Only 1 user can win the single remaining unit')
  assert.equal(failCount, 1, 'The other user must fail due to stock depletion')

  // 确认库存减至 0，绝不为负数
  const finalStock = db.state.lottery_activities[0].prizes[0].stockLeft
  assert.equal(finalStock, 0, 'Final stock must be exactly 0, never negative')

  // 确认积分流水只写入 1 次
  assert.equal(db.state.point_logs.length, 1)
})

test('lottery: reward issuance uses idempotencyKey and recovers pending reservation without duplicate grants', async () => {
  const { dateKey } = toCstParts(now())
  const recordId = `lottery_act_concurrency_openid_a_${dateKey}`

  // 模拟事务已经占位成功，但尚未履约完成（status 为 pending）
  const db = setupLotteryTest({
    lottery_activities: [
      {
        _id: 'act_concurrency',
        name: '并发抽奖活动测试',
        enabled: true,
        prizes: [
          {
            id: 'prize_coupon_1',
            type: 'coupon',
            name: '立减50元券',
            templateId: 'tmpl_test_50',
            probability: 100,
            stockLeft: 9
          }
        ]
      }
    ],
    lottery_records: [
      {
        _id: recordId,
        userId: 'u_user_a',
        openid: 'openid_a',
        activityId: 'act_concurrency',
        dateKey,
        status: 'pending',
        prizeType: 'coupon',
        prizeTemplateId: 'tmpl_test_50',
        prizeName: '立减50元券',
        prizeText: '',
        points: 0,
        couponId: '',
        titleId: '',
        rewardMailId: '',
        prizeSnapshot: {
          id: 'prize_coupon_1',
          type: 'coupon',
          name: '立减50元券',
          templateId: 'tmpl_test_50',
          stockLeft: 9
        },
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ]
  })

  const fnA = loadCloudFunction('api', db, 'openid_a')

  // 再次调用 draw，应幂等恢复未完成的履约发券，而不是重复扣减库存或新建 record
  const res1 = await fnA.main({ module: 'lottery', action: 'draw' })
  assert.equal(res1.ok, true)
  assert.equal(res1.data.prizeType, 'coupon')
  assert.ok(res1.data.couponId)

  // 验证发放了优惠券，且含有幂等标识
  assert.equal(db.state.user_coupons.length, 1)
  const coupon = db.state.user_coupons[0]
  assert.equal(coupon.lotteryRecordId, recordId)
  assert.equal(coupon.idempotencyKey, recordId)
  assert.equal(coupon.sourceType, 'lottery')
  assert.equal(db.state.coupon_templates[0].issuedCount, 1)

  // 状态已更新为 completed
  const recAfter = db.state.lottery_records.find(r => r._id === recordId)
  assert.equal(recAfter.status, 'completed')
  assert.equal(recAfter.couponId, coupon._id)

  // 库存没有被再次多扣
  assert.equal(db.state.lottery_activities[0].prizes[0].stockLeft, 9)

  // 重复调用将正常返回“今天已参与过本次抽奖”
  const res2 = await fnA.main({ module: 'lottery', action: 'draw' })
  assert.equal(res2.ok, false)
  assert.ok(res2.message.includes('今天已参与过本次抽奖'))
})

test('lottery: pet_title prize and fallback compensation both carry idempotency identifiers', async () => {
  const db = setupLotteryTest({
    lottery_activities: [
      {
        _id: 'act_title_test',
        name: '头衔抽奖活动',
        enabled: true,
        prizes: [
          {
            id: 'prize_title_1',
            type: 'pet_title',
            name: '宠物头衔：锦鲤本鲤',
            titleId: 'title_lucky',
            probability: 100,
            stockLeft: 5
          }
        ]
      }
    ]
  })

  const fnA = loadCloudFunction('api', db, 'openid_a')
  const res = await fnA.main({ module: 'lottery', action: 'draw' })
  assert.equal(res.ok, true)
  assert.equal(res.data.prizeType, 'pet_title')
  assert.ok(res.data.rewardMailId)

  // 检查奖励邮件是否携带 lotteryRecordId 与 idempotencyKey
  const { dateKey } = toCstParts(now())
  const recordId = `lottery_act_title_test_openid_a_${dateKey}`
  const mail = db.state.reward_mails[0]
  assert.ok(mail)
  assert.equal(mail.lotteryRecordId, recordId)
  assert.equal(mail.idempotencyKey, recordId)
  assert.equal(mail.sourceType, 'lottery')
})
