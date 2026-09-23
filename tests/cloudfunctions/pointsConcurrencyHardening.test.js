const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const optimistic = require('./optimisticTransactions')
const createContext = require('../../cloudfunctions/api/services/context')

function setupPointsTest(extra = {}) {
  const db = createCollectionStore({
    users: [
      {
        _id: 'u_client_1',
        openid: 'openid_client_1',
        nickname: '测试用户',
        roles: ['client'],
        status: 'active',
        points: 50,
        totalPoints: 50,
        memberLevel: 'lvl_normal',
        memberLevelName: '普通会员'
      }
    ],
    member_levels: [
      { _id: 'lvl_normal', name: '普通会员', minPoints: 0, pointMultiplier: 1, badgeTag: 'V1' },
      { _id: 'lvl_gold', name: '黄金会员', minPoints: 100, pointMultiplier: 2, badgeTag: 'V2' }
    ],
    point_logs: [],
    platform_configs: [],
    ...extra
  })
  return db
}

function initContext(db, openid = 'openid_client_1') {
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database() { return db },
    getWXContext() { return { OPENID: openid } }
  }
  return createContext({ cloud, db })
}

test('points concurrency: concurrent different reward grants accumulate correctly without lost updates', async () => {
  const db = setupPointsTest()
  optimistic(db)
  const context = initContext(db)

  // 模拟两个不同的奖励同时发放：奖励 A 加 10 积分，奖励 B 加 20 积分
  const [resA, resB] = await Promise.all([
    context.addPoints(
      'openid_client_1',
      'u_client_1',
      10,
      'order_complete',
      'order_1001',
      '完成订单1001',
      { idempotencyKey: 'order_1001' }
    ),
    context.addPoints(
      'openid_client_1',
      'u_client_1',
      20,
      'order_complete',
      'order_1002',
      '完成订单1002',
      { idempotencyKey: 'order_1002' }
    )
  ])

  // 初始为 50，应准确累加 10 + 20 = 30，最终积分必须为 80
  const user = db.state.users.find(u => u.openid === 'openid_client_1')
  assert.equal(user.points, 50 + 10 + 20, 'User points must be 80 without lost updates')
  assert.equal(user.totalPoints, 50 + 10 + 20, 'User totalPoints must be 80 without lost updates')

  // 流水必须严格记录两条
  assert.equal(db.state.point_logs.length, 2, 'Two distinct point logs must be written')

  // 验证两条流水的变动值和最终余额一致性
  const logA = db.state.point_logs.find(l => l.idempotencyKey === 'order_1001')
  const logB = db.state.point_logs.find(l => l.idempotencyKey === 'order_1002')
  assert.ok(logA && logB, 'Both point logs must exist')
  assert.equal(logA.delta, 10)
  assert.equal(logB.delta, 20)

  // 余额顺序：一个是 60 或 70，最终一个是 80
  const balances = [logA.balance, logB.balance].sort((a, b) => a - b)
  assert.equal(balances[0], balances[0] === 60 ? 60 : 70)
  assert.equal(balances[1], 80)
})

test('points concurrency: concurrent identical reward grants with same business key only award once', async () => {
  const db = setupPointsTest()
  optimistic(db)
  const context = initContext(db)

  // 模拟并发调用同一业务来源的奖励发放（例如网络重试或双击）：加 15 积分
  const [res1, res2] = await Promise.all([
    context.addPoints(
      'openid_client_1',
      'u_client_1',
      15,
      'order_review',
      'order_review_2001',
      '评价订单奖励',
      { idempotencyKey: 'order_review_2001' }
    ),
    context.addPoints(
      'openid_client_1',
      'u_client_1',
      15,
      'order_review',
      'order_review_2001',
      '评价订单奖励',
      { idempotencyKey: 'order_review_2001' }
    )
  ])

  // 仅发放一次，积分从 50 变为 65
  const user = db.state.users.find(u => u.openid === 'openid_client_1')
  assert.equal(user.points, 50 + 15, 'Points must only increase once')
  assert.equal(user.totalPoints, 50 + 15)

  // 流水严格只有 1 条
  assert.equal(db.state.point_logs.length, 1, 'Only 1 point log should be created')
  assert.equal(db.state.point_logs[0].delta, 15)

  // 其中必有一个返回 duplicate: true 或与首次发放结果一致
  const hasDuplicate = res1.duplicate === true || res2.duplicate === true
  assert.ok(hasDuplicate, 'One of the concurrent requests should be detected as duplicate')
})

test('points atomicity: points upgrade member level in the same transaction with consistent logs', async () => {
  const db = setupPointsTest({
    users: [
      {
        _id: 'u_client_1',
        openid: 'openid_client_1',
        points: 90,
        totalPoints: 90,
        memberLevel: 'lvl_normal',
        memberLevelName: '普通会员'
      }
    ]
  })
  optimistic(db)
  const context = initContext(db)

  // 达到 100 积分阈值升级为黄金会员：加 20 积分（90 + 20 = 110）
  const res = await context.addPoints(
    'openid_client_1',
    'u_client_1',
    20,
    'order_complete',
    'order_upgrade_1',
    '升级订单',
    { idempotencyKey: 'order_upgrade_1' }
  )

  const user = db.state.users.find(u => u.openid === 'openid_client_1')
  assert.equal(user.points, 110)
  assert.equal(user.totalPoints, 110)
  assert.equal(user.memberLevel, 'lvl_gold', 'Member level should be upgraded to gold')
  assert.equal(user.memberLevelName, '黄金会员', 'Member level name should be updated')

  // 紧接着下一次发奖（applyMultiplier: true），应享受黄金会员 2 倍积分倍率
  const res2 = await context.addPoints(
    'openid_client_1',
    'u_client_1',
    10,
    'order_complete',
    'order_upgrade_2',
    '黄金会员专享翻倍',
    { applyMultiplier: true, baseDelta: 10, idempotencyKey: 'order_upgrade_2' }
  )

  assert.equal(res2.multiplier, 2, 'Gold member multiplier should be 2')
  assert.equal(res2.delta, 20, '10 base points with multiplier 2 should award 20 points')
  assert.equal(user.points, 110 + 20, 'Final points should be 130')
  assert.equal(db.state.point_logs.length, 2)
  assert.equal(db.state.point_logs[1].balance, 130)
})
