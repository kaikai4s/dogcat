const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

function database() {
  const rows = Array.from({ length: 125 }, (_, i) => ({
    _id: `record_${String(i).padStart(4, '0')}`, orderId: 'order1',
    createdAt: '2026-09-21T12:00:00.000Z', recordedAt: 1790000000000 + i * 1000,
    mediaFileId: `cloud://photo${i}`, remark: `现场说明${i}`, latitude: 31.2, longitude: 121.5
  }))
  return createCollectionStore({
    users: [{ _id: 'admin', openid: 'admin', roles: ['admin'], status: 'active' }, { _id: 'client', openid: 'client', roles: ['client'], status: 'active' }],
    staff_profiles: [{ _id: 'staff1', realName: '测试宠托师', staffLevel: 'intern', openid: 'staff1' }],
    staff_promotion_applications: [{ _id: 'app1', staffProfileId: 'staff1', status: 'pending', orderIds: ['order1', 'missing'] }],
    orders: [{ _id: 'order1', status: 'completed', serviceSummary: '上门喂养', payAmount: 80 }],
    checkin_logs: [...rows, { _id: 'deleted', orderId: 'order1', deletedAt: '2026-09-22', mediaFileId: 'cloud://deleted' }, { _id: 'foreign', orderId: 'other', mediaFileId: 'cloud://private' }],
    track_logs: rows.map(({ mediaFileId, remark, ...row }) => row),
    service_reviews: [{ _id: 'review1', orderId: 'order1', rating: 5, content: '细心负责', tags: ['准时'] }]
  })
}

test('promotion detail reads evidence beyond the database page limit, scopes orders and preserves missing-order warnings', async () => {
  const fn = loadCloudFunction('api', database(), 'admin')
  const res = await fn.main({ module: 'admin', action: 'getPromotionApplicationDetail', data: { applicationId: 'app1' } })
  assert.equal(res.ok, true, res.message)
  assert.equal(res.data.orders.length, 2)
  const report = res.data.orders[0]
  assert.equal(report.checkins.length, 125)
  assert.equal(report.tracks.length, 125)
  assert.equal(report.checkins[124].mediaFileId, 'cloud://photo124')
  assert.equal(report.checkins[124].remark, '现场说明124')
  assert.ok(report.checkins.every(c => c.orderId === 'order1' && !c.deletedAt))
  assert.equal(report.review.content, '细心负责')
  assert.equal(report.order.serviceSummary, '上门喂养')
  assert.equal(res.data.orders[1].unavailable, true)
  assert.equal(res.data.orders[1].order._id, 'missing')
})

test('promotion materials remain inaccessible to a non-admin', async () => {
  const fn = loadCloudFunction('api', database(), 'client')
  const res = await fn.main({ module: 'admin', action: 'getPromotionApplicationDetail', data: { applicationId: 'app1' } })
  assert.equal(res.ok, false)
  assert.equal(res.data, undefined)
})
