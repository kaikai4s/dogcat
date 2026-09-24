const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const optimistic = require('./optimisticTransactions')
const createContext = require('../../cloudfunctions/api/services/context')

function setupDeductionDb(extra = {}) {
  return createCollectionStore({
    users: [
      {
        _id: 'u_admin',
        openid: 'openid_admin',
        nickname: '超级管理员',
        roles: ['admin'],
        status: 'active'
      },
      {
        _id: 'u_client_test',
        openid: 'openid_client_test',
        nickname: '测试客户',
        roles: ['client'],
        status: 'active',
        points: 50,
        totalPoints: 200,
        memberLevel: 'lvl_gold',
        memberLevelName: '黄金会员'
      }
    ],
    member_levels: [
      { _id: 'lvl_normal', name: '普通会员', minPoints: 0, pointMultiplier: 1 },
      { _id: 'lvl_gold', name: '黄金会员', minPoints: 100, pointMultiplier: 2 }
    ],
    point_logs: [],
    admin_operation_logs: [],
    platform_configs: [],
    ...extra
  })
}

test('points deduction: 管理员正常扣减积分（余额充足）时流水与余额严格一致', async () => {
  const db = setupDeductionDb()
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  const res = await adminFn.main({
    module: 'admin',
    action: 'grantPoints',
    data: {
      openid: 'openid_client_test',
      delta: -20,
      reason: '核减错误积分'
    }
  })

  assert.equal(res.ok, true, '余额充足时扣减积分应成功')
  assert.equal(res.data.delta, -20)

  // 验证用户余额
  const user = db.state.users.find((u) => u.openid === 'openid_client_test')
  assert.equal(user.points, 30, '用户可用积分应扣减为 30')
  assert.equal(user.totalPoints, 200, '用户历史累计积分在扣减时不应倒扣')

  // 验证流水记录严格匹配
  assert.equal(db.state.point_logs.length, 1, '应有且仅有 1 条积分流水')
  const log = db.state.point_logs[0]
  assert.equal(log.delta, -20)
  assert.equal(log.balance, 30)
  assert.equal(log.reason, '核减错误积分')

  // 验证管理员操作审计日志
  assert.equal(db.state.admin_operation_logs.length, 1)
})

test('points deduction: 管理员扣减积分超出余额时被强校验拦截并报错，杜绝脱节', async () => {
  const db = setupDeductionDb({
    users: [
      {
        _id: 'u_admin',
        openid: 'openid_admin',
        nickname: '超级管理员',
        roles: ['admin'],
        status: 'active'
      },
      {
        _id: 'u_client_test',
        openid: 'openid_client_test',
        nickname: '测试客户',
        roles: ['client'],
        status: 'active',
        points: 10,
        totalPoints: 10
      }
    ]
  })
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  const res = await adminFn.main({
    module: 'admin',
    action: 'grantPoints',
    data: {
      openid: 'openid_client_test',
      delta: -100,
      reason: '透支扣分尝试'
    }
  })

  assert.equal(res.ok, false, '余额不足时必须拦截')
  assert.match(res.message, /用户当前可用积分不足（当前剩余 10 分），无法扣除 100 积分/)

  // 验证用户余额绝不发生变化
  const user = db.state.users.find((u) => u.openid === 'openid_client_test')
  assert.equal(user.points, 10, '用户积分必须保持原值 10')

  // 验证不产生任何流水或审计日志
  assert.equal(db.state.point_logs.length, 0, '不应生成任何流水记录')
  assert.equal(db.state.admin_operation_logs.length, 0, '不应生成操作审计日志')
})

test('points deduction: 扣减积分刚好至 0 分的边界场景能够正常处理', async () => {
  const db = setupDeductionDb({
    users: [
      {
        _id: 'u_admin',
        openid: 'openid_admin',
        roles: ['admin'],
        status: 'active'
      },
      {
        _id: 'u_client_test',
        openid: 'openid_client_test',
        roles: ['client'],
        status: 'active',
        points: 25,
        totalPoints: 25
      }
    ]
  })
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  const res = await adminFn.main({
    module: 'admin',
    action: 'grantPoints',
    data: {
      openid: 'openid_client_test',
      delta: -25,
      reason: '全部扣除'
    }
  })

  assert.equal(res.ok, true)
  const user = db.state.users.find((u) => u.openid === 'openid_client_test')
  assert.equal(user.points, 0)
  assert.equal(db.state.point_logs[0].delta, -25)
  assert.equal(db.state.point_logs[0].balance, 0)
})

test('points deduction: 目标用户不存在时友好提示', async () => {
  const db = setupDeductionDb()
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  const res = await adminFn.main({
    module: 'admin',
    action: 'grantPoints',
    data: {
      openid: 'openid_not_exist',
      delta: -10,
      reason: '测试'
    }
  })

  assert.equal(res.ok, false)
  assert.match(res.message, /目标用户不存在/)
})

test('points deduction concurrency: 底层 addPoints 事务防并发超扣透支', async () => {
  const db = setupDeductionDb({
    users: [
      {
        _id: 'u_client_test',
        openid: 'openid_client_test',
        roles: ['client'],
        status: 'active',
        points: 30,
        totalPoints: 30
      }
    ]
  })
  optimistic(db)

  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database() { return db },
    getWXContext() { return { OPENID: 'openid_admin' } }
  }
  const context = createContext({ cloud, db })

  // 初始积分为 30，并发发起两笔扣减 20 积分的请求（总需 40 积分）
  const results = await Promise.allSettled([
    context.addPoints('openid_client_test', 'u_client_test', -20, 'admin_grant', 'admin_1', '扣除20'),
    context.addPoints('openid_client_test', 'u_client_test', -20, 'admin_grant', 'admin_2', '扣除20')
  ])

  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')

  assert.equal(fulfilled.length, 1, '严格只允许成功 1 笔扣减')
  assert.equal(rejected.length, 1, '竞争失败超扣请求必须被拒绝')
  assert.match(rejected[0].reason.message, /用户当前可用积分不足/)

  const user = db.state.users.find((u) => u.openid === 'openid_client_test')
  assert.equal(user.points, 10, '最终可用积分严格为 30 - 20 = 10，绝不能为负或脱节为 0')

  assert.equal(db.state.point_logs.length, 1, '流水记录严格为 1 条')
  assert.equal(db.state.point_logs[0].delta, -20)
  assert.equal(db.state.point_logs[0].balance, 10)
})
