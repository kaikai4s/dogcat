const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const optimistic = require('./optimisticTransactions')

function setupNewbieCouponDb(extra = {}) {
  const db = createCollectionStore({
    users: [
      {
        _id: 'u_newbie_1',
        openid: 'openid_newbie_1',
        nickname: '新人用户1',
        roles: ['client'],
        status: 'active',
        phone: '13800000001',
        points: 0,
        totalPoints: 0
      },
      {
        _id: 'u_newbie_2',
        openid: 'openid_newbie_2',
        nickname: '新人用户2',
        roles: ['client'],
        status: 'active',
        phone: '13800000002',
        points: 0,
        totalPoints: 0
      }
    ],
    coupon_templates: [
      {
        _id: 'tmpl_newbie_20',
        name: '新人专享20元券',
        type: 'fixed',
        usageScope: 'all',
        discountAmount: 20,
        minOrderAmount: 50,
        applicableServiceTypes: [],
        enabled: true,
        newbieOnly: true,
        perUserLimit: 1,
        totalIssueLimit: 100,
        issuedCount: 0
      },
      {
        _id: 'tmpl_newbie_limited',
        name: '新人限量抢券',
        type: 'fixed',
        usageScope: 'all',
        discountAmount: 30,
        minOrderAmount: 80,
        applicableServiceTypes: [],
        enabled: true,
        newbieOnly: true,
        perUserLimit: 1,
        totalIssueLimit: 1,
        issuedCount: 0
      }
    ],
    user_coupons: [],
    orders: [],
    mall_orders: [],
    order_timeline: [],
    ...extra
  })
  return db
}

test('newbie coupon concurrency: concurrent claims by same user issue only 1 coupon with idempotent return', async () => {
  const db = setupNewbieCouponDb()
  optimistic(db)

  const fn = loadCloudFunction('api', db, 'openid_newbie_1')

  // 模拟同一个用户通过脚本或双击快速并发调用 5 次 claimNewbieCoupon
  const promises = Array.from({ length: 5 }, () =>
    fn.main({
      module: 'coupon',
      action: 'claimNewbieCoupon',
      data: { templateId: 'tmpl_newbie_20' }
    })
  )

  const results = await Promise.all(promises)

  // 所有并发调用均成功响应，且返回的券 ID 与模板一致
  for (const res of results) {
    assert.equal(res.ok, true, 'Each concurrent claim must succeed')
    assert.equal(res.data.templateId, 'tmpl_newbie_20')
    assert.equal(res.data.status, 'available')
  }

  const firstCouponId = results[0].data._id
  for (const res of results) {
    assert.equal(res.data._id, firstCouponId, 'All concurrent responses must return the same coupon _id')
  }

  // 验证数据库中该用户的该券记录严格只有 1 条
  const userCoupons = db.state.user_coupons.filter(
    (c) => c.openid === 'openid_newbie_1' && c.templateId === 'tmpl_newbie_20'
  )
  assert.equal(userCoupons.length, 1, 'Exactly one coupon record must be written to user_coupons')

  const coupon = userCoupons[0]
  assert.equal(coupon.idempotencyKey, 'newbie_openid_newbie_1_tmpl_newbie_20')
  assert.equal(coupon.sourceType, 'newbie_claim')
  assert.equal(coupon.sourceId, 'tmpl_newbie_20')
  assert.equal(coupon.status, 'available')

  // 验证模板已发放计数器严格只增加了 1
  const template = db.state.coupon_templates.find((t) => t._id === 'tmpl_newbie_20')
  assert.equal(template.issuedCount, 1, 'Coupon template issuedCount must strictly increment by 1')
})

test('newbie coupon concurrency: concurrent claims by different users for limited stock do not exceed totalIssueLimit', async () => {
  const db = setupNewbieCouponDb()
  optimistic(db)

  const fn1 = loadCloudFunction('api', db, 'openid_newbie_1')
  const fn2 = loadCloudFunction('api', db, 'openid_newbie_2')

  // 两个不同用户并发争抢总限额仅为 1 张的新人券
  const [res1, res2] = await Promise.all([
    fn1.main({
      module: 'coupon',
      action: 'claimNewbieCoupon',
      data: { templateId: 'tmpl_newbie_limited' }
    }),
    fn2.main({
      module: 'coupon',
      action: 'claimNewbieCoupon',
      data: { templateId: 'tmpl_newbie_limited' }
    })
  ])

  const successCount = (res1.ok ? 1 : 0) + (res2.ok ? 1 : 0)
  const failCount = (!res1.ok ? 1 : 0) + (!res2.ok ? 1 : 0)

  assert.equal(successCount, 1, 'Exactly one claim should succeed when totalIssueLimit is 1')
  assert.equal(failCount, 1, 'Competing claim must be rejected when totalIssueLimit is exhausted')

  const failedResult = !res1.ok ? res1 : res2
  assert.match(failedResult.message, /优惠券已达到发放上限/, 'Failure reason must state total issue limit reached')

  // 验证数据库中优惠券总数严格为 1
  const issuedCoupons = db.state.user_coupons.filter((c) => c.templateId === 'tmpl_newbie_limited')
  assert.equal(issuedCoupons.length, 1, 'Total coupons issued must be exactly 1')

  // 验证模板 issuedCount 严格为 1
  const template = db.state.coupon_templates.find((t) => t._id === 'tmpl_newbie_limited')
  assert.equal(template.issuedCount, 1, 'Template issuedCount must not exceed totalIssueLimit')
})

test('newbie coupon: sequential duplicate claim returns existing coupon idempotently without creating duplicate records', async () => {
  const db = setupNewbieCouponDb()

  const fn = loadCloudFunction('api', db, 'openid_newbie_1')

  const firstRes = await fn.main({
    module: 'coupon',
    action: 'claimNewbieCoupon',
    data: { templateId: 'tmpl_newbie_20' }
  })
  assert.equal(firstRes.ok, true)

  const secondRes = await fn.main({
    module: 'coupon',
    action: 'claimNewbieCoupon',
    data: { templateId: 'tmpl_newbie_20' }
  })
  assert.equal(secondRes.ok, true)
  assert.equal(secondRes.data._id, firstRes.data._id)

  const userCoupons = db.state.user_coupons.filter(
    (c) => c.openid === 'openid_newbie_1' && c.templateId === 'tmpl_newbie_20'
  )
  assert.equal(userCoupons.length, 1, 'Must not duplicate coupon on subsequent claim')

  const template = db.state.coupon_templates.find((t) => t._id === 'tmpl_newbie_20')
  assert.equal(template.issuedCount, 1, 'issuedCount must remain 1')
})

test('newbie coupon: validations for invalid, disabled, or non-newbie templates', async () => {
  const db = setupNewbieCouponDb({
    coupon_templates: [
      { _id: 'tmpl_disabled', name: '停用券', enabled: false, newbieOnly: true },
      { _id: 'tmpl_regular', name: '普通非新人券', enabled: true, newbieOnly: false }
    ]
  })

  const fn = loadCloudFunction('api', db, 'openid_newbie_1')

  // 未传 templateId
  const emptyRes = await fn.main({ module: 'coupon', action: 'claimNewbieCoupon', data: {} })
  assert.equal(emptyRes.ok, false)
  assert.match(emptyRes.message, /请选择新人优惠券/)

  // 模板不存在
  const notFoundRes = await fn.main({ module: 'coupon', action: 'claimNewbieCoupon', data: { templateId: 'non_existent' } })
  assert.equal(notFoundRes.ok, false)
  assert.match(notFoundRes.message, /新人优惠券不可领取/)

  // 模板已禁用
  const disabledRes = await fn.main({ module: 'coupon', action: 'claimNewbieCoupon', data: { templateId: 'tmpl_disabled' } })
  assert.equal(disabledRes.ok, false)
  assert.match(disabledRes.message, /新人优惠券不可领取/)

  // 非新人券
  const regularRes = await fn.main({ module: 'coupon', action: 'claimNewbieCoupon', data: { templateId: 'tmpl_regular' } })
  assert.equal(regularRes.ok, false)
  assert.match(regularRes.message, /新人优惠券不可领取/)
})
