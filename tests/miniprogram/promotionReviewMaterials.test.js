const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { buildPromotionOrder } = require('../../miniprogram/utils/promotionReview')

function material() {
  return {
    order: { _id: 'order 1', orderNo: 'O123', status: 'completed', amount: 80, payAmount: 0, discountAmount: 80, requiredCheckins: ['enter_door', 'leave_door'],
      petSnapshots: [{ name: '豆豆', species: 'dog', healthNotes: '需要喂药', specialNotes: '不能喂鸡肉' }],
      serviceSessions: [{ index: 1, status: 'completed', startedAt: '2026-09-21 22:00', finishedAt: '2026-09-21 22:30' }] },
    checkins: [
      { _id: 'later', eventType: 'leave_door', recordedAt: '2026-09-21 22:30', mediaFileId: 'cloud://original', watermarkedMediaFileId: 'cloud://watermark', remark: '已锁门', latitude: 31.21, longitude: 121.52, coordinateType: 'gcj02', distanceKm: 0, accuracy: 9, locationSource: 'gps', isBackfilled: true },
      { _id: 'first', eventType: 'enter_door', createdAt: '2026-09-21 22:00', mediaFileId: '', latitude: null, longitude: null },
      { _id: 'removed', mediaFileId: 'cloud://deleted', deletedAt: '2026-09-21' }
    ],
    tracks: Array.from({ length: 45 }, (_, i) => ({ _id: `t${i}`, latitude: 31.2, longitude: 121.5, coordinateType: 'gcj02' })),
    review: { rating: 5, tags: ['细心', '准时'], content: '很细心\n下次还预约' }
  }
}

function setup(callFunction = async () => ({ application: { status: 'pending' }, orders: [material()] })) {
  const file = path.resolve(__dirname, '../../miniprogram/pages/admin/staff-promotion/detail/index.js')
  const localRequire = createRequire(file)
  let page
  const previews = [], locations = [], routes = [], errors = []
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Page(p) { page = p },
    require(name) { return name.endsWith('/cloud') ? { callFunction, showError: e => errors.push(e) } : localRequire(name) },
    wx: { previewImage: x => previews.push(x), openLocation: x => locations.push(x), navigateTo: x => routes.push(x), showToast() {}, navigateBack() {} }
  })
  page.setData = patch => {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.')
      let target = page.data
      for (const part of parts.slice(0, -1)) target = target[part]
      target[parts.at(-1)] = value
    }
  }
  return { page, previews, locations, routes, errors }
}
const event = (dataset = {}) => ({ currentTarget: { dataset } })

test('promotion materials preserve original photos, remarks, zero payment and full pet/session details', () => {
  const result = buildPromotionOrder(material(), 0)
  assert.deepEqual(result.checkins.map(c => c._id), ['first', 'later'])
  assert.equal(result.checkinCount, 2)
  assert.equal(result.photoCount, 1)
  assert.equal(result.backfilledCount, 1)
  assert.equal(result.payAmountText, '¥0.00')
  assert.equal(result.checkins[1].photoUrl, 'cloud://watermark')
  assert.equal(result.checkins[1].originalUrl, 'cloud://original')
  assert.equal(result.checkins[1].remarkText, '已锁门')
  assert.equal(result.checkins[1].distanceText, '0 米')
  assert.equal(result.pets[0].specialNotes, '不能喂鸡肉')
  assert.equal(result.sessions[0].actualDurationText, '30 分钟')
  assert.equal(result.reviewTagsText, '细心 · 准时')
  assert.equal(result.review.content, '很细心\n下次还预约')
  assert.ok(result.warnings.some(w => w.includes('入户打卡')))
  assert.equal(result.detailsExpanded, false)
})

test('missing and unknown coordinates never become a map location or a zero distance', () => {
  const result = buildPromotionOrder({ order: {}, checkins: [
    { latitude: null, longitude: '', distanceKm: null },
    { latitude: 31, longitude: 121, coordinateType: 'unknown' },
    { latitude: 0, longitude: 0 }, { latitude: 91, longitude: 121 }
  ] }, 0)
  assert.ok(result.checkins.every(c => !c.canOpenLocation))
  assert.equal(result.checkins[0].distanceText, '未记录')
  assert.equal(result.checkins[0].hasLocation, false)
  assert.equal(result.checkins[1].hasLocation, true)
  assert.equal(result.checkins[2].hasLocation, false)
  assert.equal(result.checkins[3].hasLocation, false)
  assert.equal(buildPromotionOrder({ order: { _id: 'missing' }, unavailable: true }, 0).warnings.length, 1)
})

test('page loads materials and previews the tapped photo or original with the order gallery', async () => {
  const { page, previews, locations } = setup()
  await page.load()
  assert.equal(page.data.totalPhotos, 1)
  assert.equal(page.data.totalCheckins, 2)
  assert.equal(page.data.application.statusText, '转正审核中')
  page.previewPhoto(event({ index: 0, checkin: 1 }))
  page.previewPhoto(event({ index: 0, checkin: 1, original: true }))
  assert.equal(previews[0].current, 'cloud://watermark')
  assert.deepEqual(previews[1].urls, ['cloud://original'])
  page.photoError(event({ index: 0, checkin: 1 }))
  assert.equal(page.data.orders[0].checkins[1].photoFailed, true)
  page.retryPhoto(event({ index: 0, checkin: 1 }))
  assert.equal(page.data.orders[0].checkins[1].photoFailed, false)
  page.openLocation(event({ index: 0, checkin: 0 }))
  page.openLocation(event({ index: 0, checkin: 1 }))
  assert.equal(locations.length, 1)
  assert.equal(locations[0].latitude, 31.21)
})

test('inline order details work without order-management permission; authorized navigation encodes the ID', async () => {
  const { page, routes } = setup()
  await page.load()
  page.toggleDetails(event({ index: 0 }))
  assert.equal(page.data.orders[0].detailsExpanded, true)
  page.openOrder(event({ index: 0 }))
  assert.equal(routes.length, 0)
  page.data.adminAccess = { permissions: ['admin.getOrderDetail'] }
  page.openOrder(event({ index: 0 }))
  assert.equal(routes[0].url, '/pages/admin/orders/detail/index?id=order%201')
})

test('all track records remain reachable and order expansion does not lose loaded materials', async () => {
  const { page } = setup()
  await page.load()
  assert.equal(page.data.orders[0].trackPreview.length, 20)
  page.moreTracks(event({ index: 0 }))
  page.moreTracks(event({ index: 0 }))
  assert.equal(page.data.orders[0].trackPreview.length, 45)
  page.toggleTracks(event({ index: 0 }))
  assert.equal(page.data.orders[0].tracksExpanded, true)
  page.toggleAllOrders()
  assert.equal(page.data.orders[0].expanded, false)
  page.toggleOrder(event({ index: 0 }))
  assert.equal(page.data.orders[0].expanded, true)
  assert.equal(page.data.orders[0].trackPreview.length, 45)
})

test('failed requests expose retry and a successful retry restores material content', async () => {
  let fail = true
  const { page, errors } = setup(async () => {
    if (fail) throw new Error('网络错误')
    return { application: { status: 'pending' }, orders: [material()] }
  })
  await page.load()
  assert.equal(page.data.loadError, true)
  assert.equal(page.data.loading, false)
  assert.equal(errors.length, 1)
  fail = false
  await page.load()
  assert.equal(page.data.loadError, false)
  assert.equal(page.data.orders.length, 1)
})

test('audit confirmation prevents duplicate submissions while preserving failed input', async () => {
  let reject, count = 0
  const { page } = setup(() => { count++; return new Promise((resolve, no) => { reject = no }) })
  page.data.application = { status: 'pending' }
  page.openAuditModal(event({ status: 'rejected' }))
  page.data.remark = '需要补充材料'
  const pending = page.audit()
  page.audit()
  page.closeAuditModal()
  assert.equal(count, 1)
  assert.equal(page.data.showAuditModal, true)
  reject(new Error('网络错误'))
  await pending
  assert.equal(page.data.submitting, false)
  assert.equal(page.data.remark, '需要补充材料')
})
