const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const optimistic = require('./optimisticTransactions')
const { toCstParts, now } = require('../../cloudfunctions/api/utils/time')

function setupCheckinTest(extra = {}) {
  const todayInfo = toCstParts(now())
  const db = createCollectionStore({
    users: [
      { _id: 'u_client_1', openid: 'openid_client_1', nickname: '客户小王', roles: ['client'], status: 'active', points: 10, totalPoints: 10, retroCardCount: 1 }
    ],
    member_levels: [
      { _id: 'lvl_1', name: '大众会员', minPoints: 0, pointMultiplier: 1 }
    ],
    checkin_month_configs: [
      {
        _id: 'cfg_curr',
        monthKey: todayInfo.monthKey,
        days: [
          { day: todayInfo.dayNumber, rewardType: 'points', points: 15, title: '每日积分奖励' }
        ],
        status: 'active'
      }
    ],
    coupon_templates: [
      {
        _id: 'tmpl_checkin_coupon',
        name: '签到专属立减券',
        discountAmount: 10,
        minOrderAmount: 30,
        validType: 'relative_days',
        validDays: 14,
        enabled: true,
        issuedCount: 0
      }
    ],
    user_checkins: [],
    user_coupons: [],
    point_logs: [],
    retro_card_logs: [],
    ...extra
  })
  return db
}

test('checkin concurrency: calling auth.dailyCheckin and checkin.checkinToday concurrently only awards reward once', async () => {
  const db = setupCheckinTest()
  optimistic(db)

  const fn = loadCloudFunction('api', db, 'openid_client_1')

  // 同时从 auth.dailyCheckin 和 checkin.checkinToday 两个入口并发调用
  const [resAuth, resCheckin] = await Promise.allSettled([
    fn.main({ module: 'auth', action: 'dailyCheckin', data: {} }),
    fn.main({ module: 'checkin', action: 'checkinToday', data: {} })
  ])

  // 两个并发请求中，积分只应当发放一次（+15分）
  const user = db.state.users.find(u => u.openid === 'openid_client_1')
  assert.equal(user.points, 10 + 15, 'Points must only increase once (+15)')
  assert.equal(user.totalPoints, 10 + 15)

  // point_logs 流水只能有 1 条
  assert.equal(db.state.point_logs.length, 1, 'Only 1 point log should be recorded')

  // user_checkins 只有 1 条记录，且 _id 格式为 checkin_${openid}_${dateKey}
  assert.equal(db.state.user_checkins.length, 1, 'Only 1 checkin record must be created')
  const { dateKey } = toCstParts(now())
  const expectedCheckinId = `checkin_openid_client_1_${dateKey}`
  assert.equal(db.state.user_checkins[0]._id, expectedCheckinId)
  assert.equal(db.state.user_checkins[0].status, 'completed')

  // 其中必有一个入口正常履约，另一个入口安全返回已签到或报错已签到
  const authOk = resAuth.status === 'fulfilled' && resAuth.value.ok === true
  const checkinOk = resCheckin.status === 'fulfilled' && resCheckin.value.ok === true

  if (authOk && checkinOk) {
    // 若 checkinToday 先完成，auth.dailyCheckin 识别已签到并安全返回 checkedIn: true
    assert.equal(resAuth.value.data.checkedIn, true)
    assert.equal(resCheckin.value.data.pointsDelta, 15)
  } else if (authOk) {
    // 若 auth.dailyCheckin 先完成，checkin.checkinToday 拦截提示今天已签到
    assert.equal(resAuth.value.data.checkedIn, false)
    assert.equal(resCheckin.value.ok, false)
    assert.ok(resCheckin.value.message.includes('今天已签到'))
  }
})

test('checkin concurrency: concurrent checkinToday requests only succeed once and prevent duplicate points', async () => {
  const db = setupCheckinTest()
  optimistic(db)

  const fn = loadCloudFunction('api', db, 'openid_client_1')

  // 3 个 checkinToday 并发
  const results = await Promise.allSettled(
    Array.from({ length: 3 }, () => fn.main({ module: 'checkin', action: 'checkinToday', data: {} }))
  )

  const fulfilled = results.map(r => r.value)
  const successList = fulfilled.filter(r => r.ok === true)
  const failList = fulfilled.filter(r => r.ok === false)

  assert.equal(successList.length, 1, 'Exactly one checkinToday must succeed')
  assert.equal(failList.length, 2, 'Other checkinToday calls must fail')
  for (const f of failList) {
    assert.ok(f.message.includes('今天已签到'))
  }

  assert.equal(db.state.user_checkins.length, 1)
  assert.equal(db.state.point_logs.length, 1)
  assert.equal(db.state.users[0].points, 25)
})

test('checkin concurrency: concurrent auth.dailyCheckin requests only award points once', async () => {
  const db = setupCheckinTest()
  optimistic(db)

  const fn = loadCloudFunction('api', db, 'openid_client_1')

  // 3 个 dailyCheckin 并发
  const results = await Promise.all(
    Array.from({ length: 3 }, () => fn.main({ module: 'auth', action: 'dailyCheckin', data: {} }))
  )

  // 必须全部返回 ok: true（微信登录自动静默签到不向客户端抛错）
  assert.ok(results.every(r => r.ok === true))

  // 但其中只有 1 个返回 checkedIn: false（本次发放），另外 2 个返回 checkedIn: true（已签到）
  const firstClaims = results.filter(r => r.data.checkedIn === false)
  const alreadyChecked = results.filter(r => r.data.checkedIn === true)

  assert.equal(firstClaims.length, 1, 'Only 1 request marks checkedIn: false (rewarded)')
  assert.equal(alreadyChecked.length, 2, 'Other requests mark checkedIn: true')

  // 积分流水严格为 1
  assert.equal(db.state.point_logs.length, 1)
  assert.equal(db.state.user_checkins.length, 1)
  assert.equal(db.state.users[0].points, 25)
})

test('checkin: coupon reward issuance carries idempotencyKey and does not duplicate coupons', async () => {
  const todayInfo = toCstParts(now())
  const db = setupCheckinTest({
    checkin_month_configs: [
      {
        _id: 'cfg_curr',
        monthKey: todayInfo.monthKey,
        days: [
          { day: todayInfo.dayNumber, rewardType: 'coupon', couponTemplateId: 'tmpl_checkin_coupon', title: '优惠券大奖' }
        ],
        status: 'active'
      }
    ]
  })

  const fn = loadCloudFunction('api', db, 'openid_client_1')

  // 执行签到
  const res = await fn.main({ module: 'checkin', action: 'checkinToday', data: {} })
  assert.equal(res.ok, true)
  assert.ok(res.data.couponId)

  // 验证优惠券发放与幂等标识
  assert.equal(db.state.user_coupons.length, 1)
  const coupon = db.state.user_coupons[0]
  const expectedCheckinId = `checkin_openid_client_1_${todayInfo.dateKey}`
  assert.equal(coupon.idempotencyKey, expectedCheckinId)
  assert.equal(coupon.sourceType, 'checkin')
  assert.equal(coupon.sourceId, todayInfo.dateKey)
  assert.equal(db.state.coupon_templates[0].issuedCount, 1)

  // 再次调用被拦截，不会重复发券
  const repeat = await fn.main({ module: 'checkin', action: 'checkinToday', data: {} })
  assert.equal(repeat.ok, false)
  assert.ok(repeat.message.includes('今天已签到'))
  assert.equal(db.state.user_coupons.length, 1)
  assert.equal(db.state.coupon_templates[0].issuedCount, 1)
})

test('retroCheckin concurrency: concurrent retro checkins for the same day do not delete each other placeholder', async () => {
  const todayInfo = toCstParts(now())
  const retroDay = Math.max(1, todayInfo.dayNumber - 1)
  const db = setupCheckinTest({
    checkin_month_configs: [
      {
        _id: 'cfg_curr',
        monthKey: todayInfo.monthKey,
        days: [
          { day: todayInfo.dayNumber, rewardType: 'points', points: 15, title: '每日积分奖励' },
          { day: retroDay, rewardType: 'points', points: 20, title: '补签积分奖励' }
        ],
        status: 'active'
      }
    ]
  })
  optimistic(db)

  const fn = loadCloudFunction('api', db, 'openid_client_1')

  // 2 个相同日期的并发补签请求
  const [res1, res2] = await Promise.allSettled([
    fn.main({ module: 'checkin', action: 'retroCheckin', data: { monthKey: todayInfo.monthKey, day: retroDay } }),
    fn.main({ module: 'checkin', action: 'retroCheckin', data: { monthKey: todayInfo.monthKey, day: retroDay } })
  ])

  const results = [res1.value, res2.value]
  const successList = results.filter(r => r.ok === true)
  const failList = results.filter(r => r.ok === false)

  assert.equal(successList.length, 1, 'Exactly one retroCheckin must succeed')
  assert.equal(failList.length, 1, 'The other retroCheckin must fail safely')
  assert.ok(
    failList[0].message.includes('补签处理中') || failList[0].message.includes('已签到'),
    `Failure message should indicate processing or already checked in, got: ${failList[0].message}`
  )

  // 补签卡只扣除 1 张（初始 1 张，剩下 0 张）
  const user = db.state.users.find(u => u.openid === 'openid_client_1')
  assert.equal(user.retroCardCount, 0, 'Retro card count should decrease by 1')

  // 积分增加 20（初始 10，现在 30）
  assert.equal(user.points, 10 + 20, 'Points should only increase once (+20)')

  // 补签记录必须存在且状态为 completed，绝未被并发失败的请求误删
  const expectedCheckinId = `checkin_openid_client_1_${todayInfo.monthKey}-${String(retroDay).padStart(2, '0')}`
  const checkinDoc = db.state.user_checkins.find(c => c._id === expectedCheckinId)
  assert.ok(checkinDoc, 'Checkin document must exist and not be removed by concurrent request')
  assert.equal(checkinDoc.status, 'completed')
  assert.equal(checkinDoc.pointsDelta, 20)
  assert.ok(checkinDoc.attemptToken, 'Checkin record should contain attemptToken')
})

test('retroCheckin rollback: failures prior to reward claim rollback cards and safely clean up own placeholder', async () => {
  const todayInfo = toCstParts(now())
  const retroDay = Math.max(1, todayInfo.dayNumber - 1)
  // 配置一个无效的优惠券模板 ID，使 claimCheckinReward 抛出错误
  const db = setupCheckinTest({
    checkin_month_configs: [
      {
        _id: 'cfg_curr',
        monthKey: todayInfo.monthKey,
        days: [
          { day: retroDay, rewardType: 'coupon', couponTemplateId: 'non_existent_template', title: '无效券补签' }
        ],
        status: 'active'
      }
    ]
  })

  const fn = loadCloudFunction('api', db, 'openid_client_1')

  const res = await fn.main({
    module: 'checkin',
    action: 'retroCheckin',
    data: { monthKey: todayInfo.monthKey, day: retroDay }
  })

  assert.equal(res.ok, false)

  // 补签卡回滚：原先扣除后又退还，卡数量仍为 1
  const user = db.state.users.find(u => u.openid === 'openid_client_1')
  assert.equal(user.retroCardCount, 1, 'Retro card must be rolled back on failure')

  // 补签记录占位由于未发奖且属于自己的占位，安全清除以允许后续重试
  const expectedCheckinId = `checkin_openid_client_1_${todayInfo.monthKey}-${String(retroDay).padStart(2, '0')}`
  const checkinDoc = db.state.user_checkins.find(c => c._id === expectedCheckinId)
  assert.equal(checkinDoc, undefined, 'Placeholder should be cleaned up on early failure')
})

test('retroCheckin recovery: transient update failure after reward claim recovers completed state instead of deleting placeholder', async () => {
  const todayInfo = toCstParts(now())
  const retroDay = Math.max(1, todayInfo.dayNumber - 1)
  const db = setupCheckinTest({
    checkin_month_configs: [
      {
        _id: 'cfg_curr',
        monthKey: todayInfo.monthKey,
        days: [
          { day: retroDay, rewardType: 'points', points: 25, title: '恢复测试奖励' }
        ],
        status: 'active'
      }
    ]
  })

  const expectedCheckinId = `checkin_openid_client_1_${todayInfo.monthKey}-${String(retroDay).padStart(2, '0')}`

  // 模拟第一次 update 抛出瞬时异常（例如网络丢包），第二次（重试恢复）成功
  let updateAttempts = 0
  const originalDoc = db.collection('user_checkins').doc
  db.collection('user_checkins').doc = function (id) {
    const handle = originalDoc.call(this, id)
    const originalUpdate = handle.update
    handle.update = async function (params) {
      if (id === expectedCheckinId) {
        updateAttempts++
        if (updateAttempts === 1) {
          throw new Error('Simulated transient DB update network timeout')
        }
      }
      return originalUpdate.call(this, params)
    }
    return handle
  }

  const fn = loadCloudFunction('api', db, 'openid_client_1')

  const res = await fn.main({
    module: 'checkin',
    action: 'retroCheckin',
    data: { monthKey: todayInfo.monthKey, day: retroDay }
  })

  // 异常被捕获且触发 recovery 重试更新成功，返回正常结果
  assert.equal(res.ok, true)
  assert.equal(res.data.pointsDelta, 25)

  // 占位记录状态为 completed，且绝未被删除
  const checkinDoc = db.state.user_checkins.find(c => c._id === expectedCheckinId)
  assert.ok(checkinDoc, 'Checkin doc must exist')
  assert.equal(checkinDoc.status, 'completed')

  // 用户积分正常发放
  const user = db.state.users.find(u => u.openid === 'openid_client_1')
  assert.equal(user.points, 10 + 25)
  assert.equal(user.retroCardCount, 0)
})

