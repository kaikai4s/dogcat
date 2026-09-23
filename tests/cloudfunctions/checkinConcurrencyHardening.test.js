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
