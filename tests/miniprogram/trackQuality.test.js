const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const quality = require('../../miniprogram/utils/trackQuality')

function loadPage(relativePath, overrides = {}, exported = '') {
  let page
  const requests = []
  const wx = {
    showToast() {},
    startLocationUpdate(options) { requests.push(options); options.success() },
    getLocation(options) { requests.push(options); options.success({ latitude: 31.2, longitude: 121.5, accuracy: 10 }) }
  }
  const deps = {
    navMethods: () => ({}), requirePrivacyAuthorize: () => Promise.resolve(),
    createClientRequestId: () => 'point-id', callFunction: () => Promise.resolve({ count: 1 }),
    formatDateTime: () => '2026-09-24 10:00', toBeijingDate: (value) => new Date(value),
    getOfflineTaskCount: () => 0, showError() {}, ...overrides
  }
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../miniprogram', relativePath), 'utf8') + exported, {
    Page(config) { page = config }, module, wx,
    require(name) { return name.endsWith('/trackQuality') ? quality : deps },
    setInterval, clearInterval, setTimeout, clearTimeout
  })
  page.setData = (updates) => Object.assign(page.data, updates)
  return { page, requests, exported: module.exports }
}
const sample = (offset = 0, extra = {}) => ({ latitude: 31.2, longitude: 121.5, accuracy: 10, recordedAt: Date.now() + offset, ...extra })

test('manual record cannot bypass precision checks, and startup requires two stable samples', () => {
  const { page } = loadPage('pages/staff/orders/service/index.js')
  assert.equal(page.shouldUploadTrackPoint(sample(0, { accuracy: 200 }), true), false)
  assert.equal(page.shouldUploadTrackPoint(sample(0, { accuracy: 0 }), true), false)
  assert.equal(page.shouldUploadTrackPoint(sample(-30000), true), false)
  assert.equal(page.shouldUploadTrackPoint(sample(-1000), true), false)
  assert.equal(page.shouldUploadTrackPoint(sample(), true), true)
  page.lastTrackPoint = sample(-1000)
  assert.equal(page.shouldUploadTrackPoint(sample(0, { latitude: 40 }), true), false)
})

test('foreground stream and one-shot sampling both use GCJ-02 and request precise fixes', async () => {
  const { page, requests } = loadPage('pages/staff/orders/service/index.js')
  await page.startLocationUpdate()
  await page.getRealtimeLocation()
  assert.equal(requests[0].type, 'gcj02')
  assert.equal(requests[1].type, 'gcj02')
  assert.equal(requests[1].isHighAccuracy, true)
})

test('map excludes checkins from distance, rejects drift and splits background gaps', () => {
  const { exported } = loadPage('pages/client/orders/tracking/index.js', {}, '\nmodule.exports = { buildMapData }')
  const t = Date.now() - 600000
  const tracks = [
    sample(0, { recordedAt: t }),
    sample(0, { recordedAt: t + 10000, latitude: 31.2001 }),
    sample(0, { recordedAt: t + 15000, latitude: 40 }),
    sample(0, { recordedAt: t + 300000, latitude: 31.3 }),
    sample(0, { recordedAt: t + 310000, latitude: 31.3001 })
  ]
  const checkin = sample(0, { recordedAt: t + 5000, latitude: 41, isBackfilled: true, eventTypeText: '补录照片' })
  const result = exported.buildMapData(tracks, [checkin])
  assert.equal(result.validTrackCount, 4)
  assert.equal(result.polyline.length, 2)
  assert.equal(result.trackSummary.distanceText, '22m')
  assert.equal(result.includePoints.some((p) => p.latitude >= 40), false)
  assert.equal(result.markers.some((p) => p.title.includes('补传')), true)
})
