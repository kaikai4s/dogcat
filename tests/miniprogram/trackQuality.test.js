const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

test('track quality helpers stay inside their consuming subpackages and match the server rules', () => {
  const root = path.resolve(__dirname, '../../miniprogram')
  assert.equal(fs.existsSync(path.join(root, 'utils/trackQuality.js')), false)
  const server = fs.readFileSync(path.resolve(__dirname, '../../cloudfunctions/api/utils/trackQuality.js'), 'utf8').replace(/\r\n/g, '\n')
  for (const subpackage of ['pages/staff', 'pages/client/orders', 'pages/admin']) {
    const source = fs.readFileSync(path.join(root, subpackage, 'utils/trackQuality.js'), 'utf8').replace(/\r\n/g, '\n')
    assert.equal(source, server, `${subpackage} must use the same track quality rules`)
  }
})

function loadPage(relativePath, overrides = {}, exported = '') {
  let page
  let requestSeq = 0
  const requests = []
  const { __wx = {}, ...dependencyOverrides } = overrides
  const wx = {
    showToast() {},
    showModal() {},
    startLocationUpdate(options) { requests.push(options); options.success() },
    stopLocationUpdate(options = {}) { if (options.complete) options.complete() },
    stopLocationUpdateBackground(options = {}) { if (options.complete) options.complete() },
    onLocationChange() {},
    offLocationChange() {},
    getLocation(options) { requests.push(options); options.success({ latitude: 31.2, longitude: 121.5, accuracy: 10 }) },
    ...__wx
  }
  const deps = {
    navMethods: () => ({}), requirePrivacyAuthorize: () => Promise.resolve(),
    createClientRequestId: () => `point-id-${++requestSeq}`, callFunction: () => Promise.resolve({ count: 1 }),
    formatDateTime: () => '2026-09-24 10:00', parseBeijingDate: require('../../miniprogram/utils/format').parseBeijingDate,
    getOfflineTaskCount: () => 0, showError() {}, ...dependencyOverrides
  }
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../miniprogram', relativePath), 'utf8') + exported, {
    Page(config) { page = config }, module, wx,
    require(name) { return /\/(trackQuality|sessionChat)$/.test(name) ? require(path.resolve(__dirname, '../../miniprogram', path.dirname(relativePath), name)) : deps },
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function prepareTrackingPage(overrides = {}) {
  const result = loadPage('pages/staff/orders/service/index.js', overrides)
  result.page.setData({ id: 'order', order: { status: 'in_service' } })
  result.page.uploadAutoTrackPoint = () => Promise.resolve()
  return result.page
}

test('first location grant completes before the background native stream starts', async (t) => {
  let authorization
  const calls = []
  const page = prepareTrackingPage({ __wx: {
    getSetting(options) { calls.push('settings'); options.success({ authSetting: {} }) },
    authorize(options) { calls.push(options.scope); authorization = options },
    startLocationUpdateBackground(options) { calls.push('background'); options.success() }
  } })
  t.after(() => page.stopAutoTracking())
  const starting = page.startAutoTracking()
  await settle()
  assert.deepEqual(calls, ['settings', 'scope.userLocation'])
  assert.equal(page.data.trackingState, 'starting')
  authorization.success()
  await starting
  assert.deepEqual(calls, ['settings', 'scope.userLocation', 'background'])
  assert.equal(page.data.trackingState, 'background')
})

test('denied phone permission exposes settings and a settings retry opens background tracking', async (t) => {
  let allowed = false
  let nativeCalls = 0
  const page = prepareTrackingPage({ __wx: {
    getSetting(options) { options.success({ authSetting: { 'scope.userLocation': allowed } }) },
    authorize() { assert.fail('A previously denied permission must be changed in settings') },
    startLocationUpdateBackground(options) { nativeCalls++; options.success() }
  } })
  t.after(() => page.stopAutoTracking())
  await page.startAutoTracking()
  assert.equal(nativeCalls, 0)
  assert.equal(page.data.trackingState, 'error')
  assert.match(page.data.trackingErrorText, /手机端定位授权/)
  assert.match(page.data.trackingErrorText, /定位授权设置/)
  allowed = true
  await page.onTrackingSettingsOpened({ detail: { errMsg: 'openSetting:ok' } })
  assert.equal(nativeCalls, 1)
  assert.equal(page.data.trackingState, 'background')
})

test('failed authorization keeps the native error and device diagnostics without starting a stream', async () => {
  const page = prepareTrackingPage({ __wx: {
    getSetting(options) { options.success({ authSetting: {} }) },
    authorize(options) { options.fail({ errMsg: 'authorize:fail auth deny' }) },
    getSystemSetting() { return { locationEnabled: false } },
    getAppAuthorizeSetting() { return { locationAuthorized: 'denied' } },
    getDeviceInfo() { return { platform: 'devtools' } },
    startLocationUpdateBackground() { assert.fail('Unauthorized stream') },
    startLocationUpdate() { assert.fail('Unauthorized fallback') }
  } })
  await page.startAutoTracking()
  assert.equal(page.data.trackingState, 'error')
  assert.match(page.data.trackingErrorText, /authorize:fail auth deny/)
  assert.match(page.data.trackingErrorText, /系统定位服务已关闭/)
  assert.match(page.data.trackingErrorText, /微信未获系统定位权限/)
  assert.match(page.data.trackingErrorText, /真机验证/)
  assert.match(page.data.trackingErrorText, /平台接口审批不等于手机授权/)
  await page.stopAutoTracking()
})

test('stopping while authorization is pending never opens a native stream', async () => {
  let authorization
  const page = prepareTrackingPage({ __wx: {
    getSetting(options) { options.success({ authSetting: {} }) },
    authorize(options) { authorization = options },
    startLocationUpdateBackground() { assert.fail('Stopped stream') },
    startLocationUpdate() { assert.fail('Stopped fallback') }
  } })
  const starting = page.startAutoTracking()
  await settle()
  const stopping = page.stopAutoTracking()
  authorization.success()
  await Promise.all([starting, stopping])
  assert.equal(page.data.trackingState, 'idle')
  assert.equal(page.trackingStarted, false)
})

test('background tracking is only shown after the native API succeeds and survives onHide', async (t) => {
  let backgroundRequest
  const page = prepareTrackingPage({
    __wx: {
      startLocationUpdateBackground(options) { backgroundRequest = options }
    }
  })

  page.startAutoTracking()
  t.after(() => page.stopAutoTracking())
  await settle()
  assert.equal(page.data.trackingState, 'starting')
  assert.equal(page.data.backgroundTracking, false)
  assert.ok(backgroundRequest)

  backgroundRequest.success()
  await settle()
  assert.equal(page.data.trackingState, 'background')
  assert.equal(page.data.backgroundTracking, true)
  page.onHide()
  assert.equal(page.trackingStarted, true)
})

test('stopping during a pending native start waits for the late callback and closes that session', async () => {
  let backgroundRequest
  let stopCount = 0
  const page = prepareTrackingPage({
    __wx: {
      startLocationUpdateBackground(options) { backgroundRequest = options },
      stopLocationUpdate(options) { stopCount += 1; options.complete() },
      stopLocationUpdateBackground(options) { stopCount += 1; options.complete() }
    }
  })

  const starting = page.startAutoTracking()
  await settle()
  const stopping = page.stopAutoTracking()
  assert.equal(page.data.trackingState, 'idle')
  assert.equal(stopCount, 0)
  backgroundRequest.success()
  await Promise.all([starting, stopping])
  assert.equal(stopCount, 2)
  assert.equal(page.trackingStarted, false)
})

test('background failure keeps its errMsg visible when foreground tracking is used', async (t) => {
  const page = prepareTrackingPage({
    __wx: {
      startLocationUpdateBackground(options) { options.fail({ errMsg: 'startLocationUpdateBackground:fail auth deny' }) },
      startLocationUpdate(options) { options.success() }
    }
  })

  page.startAutoTracking()
  t.after(() => page.stopAutoTracking())
  await settle()
  assert.equal(page.data.trackingState, 'foreground')
  assert.equal(page.data.backgroundTracking, false)
  assert.match(page.data.trackingErrorText, /auth deny/)
  assert.match(page.data.trackingWarningText, /请勿离开服务页面/)
  page.onHide()
  assert.equal(page.trackingStarted, false)
})

test('retry waits for native stop callbacks before opening a new background session', async (t) => {
  let backgroundCalls = 0
  let retryBackgroundRequest
  const stopRequests = []
  const page = prepareTrackingPage({
    __wx: {
      startLocationUpdateBackground(options) {
        backgroundCalls += 1
        if (backgroundCalls === 1) options.fail({ errMsg: 'background denied' })
        else retryBackgroundRequest = options
      },
      startLocationUpdate(options) { options.success() },
      stopLocationUpdate(options) { stopRequests.push(options) },
      stopLocationUpdateBackground(options) { stopRequests.push(options) }
    }
  })

  page.startAutoTracking()
  t.after(async () => {
    const stopping = page.stopAutoTracking()
    await settle()
    stopRequests.splice(0).forEach((request) => request.complete())
    await stopping
  })
  await settle()
  assert.equal(page.data.trackingState, 'foreground')

  const retry = page.retryBackgroundTracking()
  assert.equal(backgroundCalls, 1)
  await settle()
  assert.equal(stopRequests.length, 2)
  stopRequests.splice(0).forEach((request) => request.complete())
  await settle()
  assert.equal(backgroundCalls, 2)
  retryBackgroundRequest.success()
  await retry
  assert.equal(page.data.trackingState, 'background')
})

test('background and foreground failures expose the real errors and release tracking state', async () => {
  const errors = []
  const page = prepareTrackingPage({
    showError(error) { errors.push(error) },
    __wx: {
      startLocationUpdateBackground(options) { options.fail({ errMsg: 'background denied' }) },
      startLocationUpdate(options) { options.fail({ errMsg: 'foreground denied' }) }
    }
  })

  page.startAutoTracking()
  await settle()
  assert.equal(page.data.trackingState, 'error')
  assert.equal(page.trackingStarted, false)
  assert.match(page.data.trackingErrorText, /background denied/)
  assert.match(page.data.trackingErrorText, /foreground denied/)
  assert.equal(errors.length, 1)
  await page.stopAutoTracking()
  assert.equal(page.data.trackingState, 'idle')
  assert.equal(page.data.trackingErrorText, '')
  assert.equal(page.data.trackingWarningText, '')
})

test('location callbacks queue while an upload is in flight so no precise point is dropped', async () => {
  const calls = []
  let releaseFirst
  const firstUpload = new Promise((resolve) => { releaseFirst = resolve })
  const { page } = loadPage('pages/staff/orders/service/index.js', {
    callFunction: (_module, _action, payload) => {
      calls.push(payload.points[0])
      return calls.length === 1 ? firstUpload : Promise.resolve({ count: 1 })
    }
  })
  page.setData({ id: 'order', order: { status: 'in_service' }, pointCount: 0, backgroundTracking: true })
  page.trackSegmentId = 'segment'
  const now = Date.now()
  await page.recordTrackPoint({ latitude: 31.2, longitude: 121.5, accuracy: 5, recordedAt: now })
  const second = page.recordTrackPoint({ latitude: 31.20005, longitude: 121.5, accuracy: 5, recordedAt: now + 3000 })
  // The real callback is several seconds apart; advance the local sampling
  // clock to model that interval while the first network request is pending.
  page.lastTrackUploadedAt = Date.now() - 3000
  const third = page.recordTrackPoint({ latitude: 31.2001, longitude: 121.5, accuracy: 5, recordedAt: now + 6000 })
  assert.equal(calls.length, 1)
  assert.equal(page.trackUploadQueue.length, 1)
  releaseFirst({ count: 1 })
  await Promise.all([second, third])
  assert.equal(calls.length, 2)
  assert.equal(calls[1].latitude, 31.2001)
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
