const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const optimistic = require('./optimisticTransactions')

test('concurrent createReview calls only permit one successful review without duplicating data or points', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', nickname: '豆豆家长', points: 0, totalPoints: 0 }],
    orders: [{ _id: 'order1', clientOpenid: 'openid_client', staffProfileId: 'sp1', staffUserId: 'staff', staffOpenid: 'openid_staff', status: 'completed' }],
    staff_profiles: [{ _id: 'sp1', openid: 'openid_staff', auditStatus: 'approved', ratingAverage: 0, reviewCount: 0 }],
    service_reviews: [],
    order_timeline: [],
    point_logs: [],
    member_levels: []
  })
  optimistic(db)
  const fn = loadCloudFunction('api', db, 'openid_client')

  // 模拟并发发起 5 个评价请求
  const results = await Promise.all([
    fn.main({ module: 'order', action: 'createReview', data: { orderId: 'order1', rating: 5, tags: ['服务细心'], content: '评价1' } }),
    fn.main({ module: 'order', action: 'createReview', data: { orderId: 'order1', rating: 4, tags: ['准时到达'], content: '评价2' } }),
    fn.main({ module: 'order', action: 'createReview', data: { orderId: 'order1', rating: 5, tags: ['态度好'], content: '评价3' } }),
    fn.main({ module: 'order', action: 'createReview', data: { orderId: 'order1', rating: 3, tags: ['一般'], content: '评价4' } }),
    fn.main({ module: 'order', action: 'createReview', data: { orderId: 'order1', rating: 5, tags: ['很好'], content: '评价5' } })
  ])

  // 1. 验证有且仅有 1 个请求成功
  const successList = results.filter(r => r.ok === true)
  const failedList = results.filter(r => r.ok === false)
  assert.equal(successList.length, 1)
  assert.equal(failedList.length, 4)
  for (const failed of failedList) {
    assert.equal(failed.message, '该订单已评价')
  }

  // 2. 验证 service_reviews 集合中有且仅有 1 条记录，且主键为确定性 ID
  assert.equal(db.state.service_reviews.length, 1)
  assert.equal(db.state.service_reviews[0]._id, 'review_order1')
  assert.equal(db.state.service_reviews[0].orderId, 'order1')

  // 3. 验证 orders 表中 reviewedAt 被更新
  assert.ok(db.state.orders[0].reviewedAt)

  // 4. 验证宠托师评分统计仅计算了一次
  const profile = db.state.staff_profiles.find((item) => item._id === 'sp1')
  assert.equal(profile.reviewCount, 1)
  assert.equal(profile.ratingAverage, successList[0].data.rating)

  // 5. 验证积分只增加了一次（+10分），没有被并发刷取
  const clientUser = db.state.users.find((item) => item._id === 'client')
  assert.equal(clientUser.points, 10)
  assert.equal(db.state.point_logs.filter(l => l.sourceType === 'order_review').length, 1)
})
