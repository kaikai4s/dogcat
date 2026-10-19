const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '../../miniprogram/utils')
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function setup(t, options = {}) {
  const files = ['serviceTrackingManager', 'serviceOfflineSync', 'offlineQueue', 'cloud']
  const saved = new Map(files.map(file => [file, require.cache[require.resolve(path.join(root, file))]]))
  files.forEach(file => delete require.cache[require.resolve(path.join(root, file))])
  const app = { globalData: { user: { _id: 'owner-a', openid: 'openid-a', roles: ['staff'], activeRole: 'staff' } } }
  const storage = new Map(), callbacks = new Set(), calls = []
  const setting = { 'scope.userLocation': true, 'scope.userLocationBackground': true }
  let identityListener
  const priorWx = global.wx, priorApp = global.getApp
  const location = (extra = {}) => ({ latitude: 31.23, longitude: 121.47, accuracy: 8, recordedAt: Date.now() - 4000, ...extra })
  global.getApp = () => app
  global.wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
    getSetting: args => args.success({ authSetting: setting }),
    authorize: args => { calls.push(['authorize', args.scope]); setting[args.scope] = true; args.success({}) },
    startLocationUpdateBackground: args => { calls.push(['background', args]); options.background ? options.background(args) : args.success({}) },
    startLocationUpdate: args => { calls.push(['foreground']); args.success({}) },
    stopLocationUpdate: args => { calls.push(['stop']); options.stop ? options.stop(args) : args.success({}) },
    onLocationChange: fn => callbacks.add(fn), offLocationChange: fn => callbacks.delete(fn),
    getLocation: args => { calls.push(['getLocation', args]); options.location ? options.location(args) : args.success(location()) }
  }
  const cloud = {
    getCachedUser: () => app.globalData.user,
    getCurrentUser: async () => app.globalData.user,
    subscribeIdentityChange: fn => { identityListener = fn },
    requirePrivacyAuthorize: async () => { calls.push(['privacy']); if (options.privacy) await options.privacy() },
    callFunction: (module, action, data) => {
      calls.push([module, action, data])
      if (options.cloud) return options.cloud(module, action, data)
      return Promise.resolve(module === 'track' ? { count: data.points.length } : module === 'order' ? options.active || null : {})
    }
  }
  const cloudPath = require.resolve(path.join(root, 'cloud'))
  require.cache[cloudPath] = { id: cloudPath, filename: cloudPath, loaded: true, exports: cloud }
  const manager = require(path.join(root, 'serviceTrackingManager'))
  const queue = require(path.join(root, 'offlineQueue'))
  const sync = require(path.join(root, 'serviceOfflineSync'))
  const order = { _id: 'order-1', status: 'in_service', activeSessionIndex: 1, currentSessionStartedAt: '2026-10-19 10:00:00', trackCount: 4 }
  t.after(async () => {
    await manager.stop()
    global.wx = priorWx
    global.getApp = priorApp
    files.forEach(file => {
      const filename = require.resolve(path.join(root, file))
      delete require.cache[filename]
      if (saved.get(file)) require.cache[filename] = saved.get(file)
    })
  })
  return { manager, queue, sync, app, storage, callbacks, calls, setting, order, location,
    emit: extra => callbacks.forEach(fn => fn(location({ recordedAt: Date.now() - 1000, ...extra }))),
    changeUser: user => { app.globalData.user = user; identityListener(user) } }
}

test('singleton subscriptions detach without stopping cross-page background uploads; startup is idempotent', async t => {
  const h = setup(t)
  assert.equal(require(path.join(root, 'serviceTrackingManager')), h.manager)
  let updates = 0
  const unsubscribe = h.manager.subscribe(() => updates++)
  assert.equal(updates, 1)
  const first = h.manager.ensureTracking(h.order, { interactive: true })
  await Promise.all([first, h.manager.ensureTracking(h.order, { interactive: true })])
  await tick()
  assert.equal(h.calls.filter(call => call[0] === 'background').length, 1)
  assert.equal(h.callbacks.size, 1)
  unsubscribe()
  const before = updates
  await h.manager.onAppHide()
  h.emit()
  await tick()
  assert.equal(updates, before)
  assert.equal(h.manager.getSnapshot().pointCount, 5)
  assert.equal(h.calls.filter(call => call[0] === 'track').length, 1)
  assert.equal(h.calls.find(call => call[0] === 'track')[2].points[0].coordinateType, 'gcj02')
  assert.equal(h.manager.getSnapshot().backgroundTracking, true)
})

test('denied background scope falls back; settings retry only reports background after native success', async t => {
  const h = setup(t)
  h.setting['scope.userLocationBackground'] = false
  await h.manager.ensureTracking(h.order, { interactive: true })
  assert.equal(h.manager.getSnapshot().trackingState, 'foreground')
  assert.match(h.manager.getSnapshot().trackingErrorText, /后台定位授权/)
  assert.equal(h.calls.filter(call => call[0] === 'background').length, 0)
  h.setting['scope.userLocationBackground'] = true
  await h.manager.retryBackgroundTracking()
  assert.equal(h.manager.getSnapshot().backgroundTracking, true)
  assert.equal(h.callbacks.size, 1)
})

test('ordinary scope refusal never starts native tracking; interactive retry after settings succeeds', async t => {
  const h = setup(t)
  h.setting['scope.userLocation'] = false
  await h.manager.ensureTracking(h.order, { interactive: true })
  assert.equal(h.manager.getSnapshot().trackingState, 'error')
  assert.equal(h.calls.filter(call => call[0] === 'background' || call[0] === 'foreground').length, 0)
  h.setting['scope.userLocation'] = true
  await h.manager.retryBackgroundTracking()
  assert.equal(h.manager.getSnapshot().backgroundTracking, true)
})

test('automatic restore never prompts; foreground mode pauses only on App hide and restores on server confirmation', async t => {
  const active = { orderId: 'order-1', activeSessionIndex: 1, currentSessionStartedAt: '2026-10-19 10:00:00' }
  const h = setup(t, { active })
  h.setting['scope.userLocationBackground'] = false
  await h.manager.onAppShow()
  assert.equal(h.manager.getSnapshot().trackingState, 'foreground')
  assert.equal(h.calls.filter(call => call[0] === 'privacy' || call[0] === 'authorize').length, 0)
  await h.manager.onAppHide()
  assert.equal(h.callbacks.size, 0)
  assert.equal(h.manager.getSnapshot().trackingState, 'paused')
  await h.manager.onAppShow()
  assert.equal(h.callbacks.size, 1)
  assert.equal(h.manager.getSnapshot().trackingState, 'foreground')
})

test('unknown scopes during silent restore do not trigger authorization or native startup', async t => {
  const h = setup(t, { active: { orderId: 'order-1', activeSessionIndex: 1 } })
  delete h.setting['scope.userLocation']
  delete h.setting['scope.userLocationBackground']
  await h.manager.onAppShow()
  assert.equal(h.manager.getSnapshot().autoTracking, false)
  assert.equal(h.calls.filter(call => ['privacy', 'authorize', 'background', 'foreground'].includes(call[0])).length, 0)
})

test('stop during delayed native start releases it before starting a different session', async t => {
  const starts = []
  const h = setup(t, { background: args => starts.push(args) })
  const first = h.manager.ensureTracking(h.order, { interactive: true })
  await tick()
  const stopping = h.manager.stop({ orderId: 'order-1', reason: 'finished' })
  const second = h.manager.ensureTracking({ ...h.order, activeSessionIndex: 2, currentSessionStartedAt: '2026-10-20 10:00:00' })
  assert.equal(starts.length, 1)
  starts[0].success({})
  await tick()
  assert.equal(starts.length, 2)
  assert.equal(h.manager.getSnapshot().backgroundTracking, false)
  starts[1].success({})
  await Promise.all([first, stopping, second])
  assert.equal(h.callbacks.size, 1)
  assert.equal(h.manager.getSnapshot().backgroundTracking, true)
})

test('stop during privacy request cannot start native updates later', async t => {
  const gate = deferred()
  const h = setup(t, { privacy: () => gate.promise })
  const starting = h.manager.ensureTracking(h.order, { interactive: true })
  await tick()
  const stopping = h.manager.stop({ orderId: h.order._id })
  gate.resolve()
  await Promise.all([starting, stopping])
  assert.equal(h.callbacks.size, 0)
  assert.equal(h.calls.filter(call => call[0] === 'background').length, 0)
})

test('account switch synchronously invalidates callbacks and does not enqueue old upload into new owner', async t => {
  const upload = deferred()
  const h = setup(t, { cloud: module => module === 'track' ? upload.promise : Promise.resolve(null) })
  await h.manager.ensureTracking(h.order)
  await tick()
  h.emit()
  await tick()
  h.changeUser({ _id: 'owner-b', roles: ['staff'] })
  assert.equal(h.callbacks.size, 0)
  assert.equal(h.manager.getSnapshot().orderId, '')
  upload.reject(new Error('network fail'))
  await tick()
  assert.equal(h.queue.getOfflineTaskCount(), 0)
  assert.deepEqual(h.storage.get('vip_pet_offline_tasks') || [], [])
})

test('same owner switching UI role does not stop; mismatched order stop does not affect active order', async t => {
  const h = setup(t)
  await h.manager.ensureTracking(h.order)
  h.changeUser({ ...h.app.globalData.user, activeRole: 'client' })
  await h.manager.stop({ orderId: 'different-order' })
  assert.equal(h.manager.getSnapshot().backgroundTracking, true)
  assert.equal(h.callbacks.size, 1)
})

test('finish captures a final point, freezes, drains all batches and prevents stale restart; failure resumes and next session can start', async t => {
  let uploadIndex = 0
  const gate = deferred()
  const h = setup(t, { cloud: (module, action, data) => {
    if (module !== 'track') return Promise.resolve(null)
    uploadIndex++
    return uploadIndex === 1 ? gate.promise : Promise.resolve({ count: data.points.length })
  } })
  await h.manager.ensureTracking(h.order)
  await tick()
  h.emit()
  await tick()
  // More than a batch arriving while the first request is in flight.
  for (let i = 0; i < 24; i++) {
    h.emit({ recordedAt: Date.now() - 900 + i * 10, latitude: 31.2301 + i * 0.00001 })
    // force bypasses throttle, but never bypasses warmup or quality checks.
    const args = { force: true }
    global.wx.getLocation = opts => opts.success(h.location({ recordedAt: Date.now() - 500 + i * 10 }))
    h.manager.captureNow(args).catch(() => null)
    await tick()
  }
  let finished = false
  const finishing = h.manager.prepareFinish('order-1').then(() => { finished = true })
  await tick()
  assert.equal(finished, false)
  gate.resolve({ count: 1 })
  await finishing
  assert.equal(h.manager.getSnapshot().trackingState, 'finishing')
  assert.equal(h.callbacks.size, 0)
  await h.manager.ensureTracking(h.order, { interactive: true })
  assert.equal(h.callbacks.size, 0)
  await h.manager.resumeAfterFinishFailure(h.order)
  assert.equal(h.callbacks.size, 1)
  await h.manager.prepareFinish('order-1')
  await h.manager.stop({ orderId: 'order-1', reason: 'finished' })
  await h.manager.ensureTracking(h.order)
  assert.equal(h.callbacks.size, 0)
  await h.manager.ensureTracking({ ...h.order, activeSessionIndex: 2, currentSessionStartedAt: '2026-10-20 10:00:00' })
  assert.equal(h.callbacks.size, 1)
})

test('quality warmup, stale and jump rejection remain active even for forced capture', async t => {
  const h = setup(t)
  await h.manager.ensureTracking(h.order)
  await tick()
  h.emit({ accuracy: 100 })
  h.emit({ latitude: 40, longitude: 116, recordedAt: Date.now() - 1000 })
  h.emit({ recordedAt: Date.now() - 20000 })
  await tick()
  assert.equal(h.calls.filter(call => call[0] === 'track').length, 0)
  // Re-establish the two-fix warmup after the implausible candidate.
  h.emit({ recordedAt: Date.now() - 800 })
  h.emit({ recordedAt: Date.now() - 500 })
  await tick()
  assert.equal(h.calls.filter(call => call[0] === 'track').length, 1)
})

test('late active-service response cannot restart a stopped service; network error does not stop tracking', async t => {
  const active = deferred()
  const h = setup(t, { cloud: (module, action, data) => module === 'order' ? active.promise : Promise.resolve({ count: data.points.length }) })
  await h.manager.ensureTracking(h.order)
  const restore = h.manager.reconcileActiveService()
  await tick()
  await h.manager.stop({ orderId: 'order-1', reason: 'finished' })
  active.resolve({ orderId: 'order-1', activeSessionIndex: 1, currentSessionStartedAt: h.order.currentSessionStartedAt })
  await restore
  assert.equal(h.callbacks.size, 0)
  await h.manager.ensureTracking({ ...h.order, activeSessionIndex: 2 })
  const original = h.calls.filter(call => call[0] === 'stop').length
  // A separate failure is not interpreted as a null active service.
  const cloud = require(path.join(root, 'cloud'))
  cloud.callFunction = () => Promise.reject(new Error('network timeout'))
  await h.manager.reconcileActiveService()
  assert.equal(h.manager.getSnapshot().backgroundTracking, true)
  assert.equal(h.calls.filter(call => call[0] === 'stop').length, original)
})

test('shared offline flush serially drains track, checkin and key return under one lock', async t => {
  const gate = deferred()
  let trackCalls = 0
  const h = setup(t, { cloud: module => {
    if (module === 'track') { trackCalls++; return gate.promise }
    return Promise.resolve({})
  } })
  h.queue.enqueueOfflineTask('track', { orderId: 'order-1', point: h.location() })
  h.queue.enqueueOfflineTask('checkin', { orderId: 'order-1', eventType: 'arrival' })
  h.queue.enqueueOfflineTask('key_return', { orderId: 'order-1', imageFileIds: ['cloud://image'] })
  const first = h.sync.flushServiceOfflineTasks('order-1')
  const second = h.sync.flushServiceOfflineTasks('order-1')
  await tick()
  assert.equal(trackCalls, 1)
  gate.resolve({ count: 1 })
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(a, { flushed: true, offlineTaskCount: 0, offlineBlockedCount: 0, offlineUnownedCount: 0 })
  assert.deepEqual(a, b)
  assert.equal(h.calls.filter(call => call[0] === 'checkin').length, 1)
  assert.equal(h.calls.filter(call => call[0] === 'homeSecurity').length, 1)
})

test('offline flush retains owner checks after each await and never drains another account', async t => {
  const gate = deferred()
  const h = setup(t, { cloud: () => gate.promise })
  h.queue.enqueueOfflineTask('track', { orderId: 'order-1', point: h.location() })
  h.queue.enqueueOfflineTask('checkin', { orderId: 'order-1' })
  const flushing = h.sync.flushServiceOfflineTasks('order-1')
  await tick()
  h.changeUser({ _id: 'owner-b', roles: ['staff'] })
  gate.resolve({ count: 1 })
  assert.equal((await flushing).flushed, false)
  assert.equal(h.calls.filter(call => call[0] === 'checkin').length, 0)
  assert.equal(h.storage.get('vip_pet_offline_tasks').length, 2)
})

test('main-package quality implementation is byte-identical to server rules', () => {
  const fs = require('node:fs')
  assert.equal(fs.readFileSync(path.join(root, 'trackQuality.js'), 'utf8'),
    fs.readFileSync(path.resolve(root, '../../cloudfunctions/api/utils/trackQuality.js'), 'utf8'))
})
