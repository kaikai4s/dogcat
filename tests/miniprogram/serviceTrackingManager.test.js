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

test('revoking staff permission for the same owner immediately stops location collection', async t => {
  const h = setup(t)
  await h.manager.ensureTracking(h.order, { interactive: true })
  assert.equal(h.callbacks.size, 1)
  h.changeUser({ ...h.app.globalData.user, roles: ['client'] })
  assert.equal(h.callbacks.size, 0)
  assert.equal(h.manager.getSnapshot().orderId, '')
  await h.manager.ensureTracking(h.order, { interactive: true })
  assert.equal(h.callbacks.size, 0)
})

test('server rejection after reassignment or automatic completion stops further collection', async t => {
  const h = setup(t, { cloud: async () => { throw new Error('仅服务中或结束后的补传窗口内可上传轨迹') } })
  await h.manager.ensureTracking(h.order, { interactive: true })
  await tick()
  h.emit()
  await tick()
  assert.equal(h.callbacks.size, 0)
  assert.equal(h.manager.getSnapshot().orderId, '')
  assert.equal(h.queue.getOfflineTaskCount(h.order._id), 0)
  await h.manager.ensureTracking(h.order)
  await h.manager.resumeAfterFinishFailure(h.order)
  assert.equal(h.callbacks.size, 0)
})

test('detail and active-service responses share one session when the server falls back to startedAt', async t => {
  const h = setup(t)
  const legacy = { ...h.order, startedAt: h.order.currentSessionStartedAt }
  delete legacy.currentSessionStartedAt
  await h.manager.ensureTracking(legacy, { interactive: true })
  await h.manager.ensureTracking(h.order)
  assert.equal(h.calls.filter(call => call[0] === 'background').length, 1)
  assert.equal(h.callbacks.size, 1)
})

test('returning from background revalidates revoked permission instead of retaining a green status', async t => {
  const active = { orderId: 'order-1', activeSessionIndex: 1, currentSessionStartedAt: '2026-10-19 10:00:00' }
  const h = setup(t, { active })
  await h.manager.ensureTracking(h.order, { interactive: true })
  await h.manager.onAppHide()
  h.setting['scope.userLocation'] = false
  await h.manager.onAppShow()
  assert.equal(h.manager.getSnapshot().backgroundTracking, false)
  assert.equal(h.manager.getSnapshot().trackingState, 'error')
  assert.equal(h.callbacks.size, 0)
  assert.equal(h.calls.filter(call => call[0] === 'authorize').length, 0)
})

test('a previously confirmed foreground service resumes offline without an authorization prompt', async t => {
  const h = setup(t, { cloud: async (module, action, data) => {
    if (module === 'order') throw new Error('network unavailable')
    return { count: data.points.length }
  } })
  h.setting['scope.userLocationBackground'] = false
  await h.manager.ensureTracking(h.order, { interactive: true })
  await h.manager.onAppHide()
  assert.equal(h.callbacks.size, 0)
  const prompts = h.calls.filter(call => call[0] === 'privacy' || call[0] === 'authorize').length
  await h.manager.onAppShow()
  assert.equal(h.callbacks.size, 1)
  assert.equal(h.manager.getSnapshot().trackingState, 'foreground')
  assert.equal(h.calls.filter(call => call[0] === 'privacy' || call[0] === 'authorize').length, prompts)
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
  // Advance capture time, not wall-clock timers: 44 points accumulate while
  // the first native callback's upload remains unresolved.
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  t.after(() => { Date.now = realNow })
  for (let i = 0; i < 44; i++) {
    now += 5000
    h.emit({ recordedAt: now - 1000, latitude: 31.2301 + i * 0.00001 })
  }
  now += 5000
  global.wx.getLocation = opts => opts.success(h.location({ latitude: 31.23054, recordedAt: now - 1000 }))
  let finished = false
  const finishing = h.manager.prepareFinish('order-1').then(() => { finished = true })
  await tick()
  assert.equal(finished, false)
  gate.resolve({ count: 1 })
  await finishing
  assert.deepEqual(h.calls.filter(call => call[0] === 'track').map(call => call[2].points.length), [1, 20, 20, 5])
  assert.equal(h.manager.getSnapshot().pointCount, 50)
  Date.now = realNow
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

test('native background failure is shown as foreground, not background success', async t => {
  const h = setup(t, { background: args => args.fail({ errMsg: 'startLocationUpdateBackground:fail permission denied' }) })
  await h.manager.ensureTracking(h.order, { interactive: true })
  assert.equal(h.manager.getSnapshot().backgroundTracking, false)
  assert.equal(h.manager.getSnapshot().trackingState, 'foreground')
  assert.match(h.manager.getSnapshot().trackingErrorText, /permission denied/)
})

test('restart waits for an asynchronous native stop to complete', async t => {
  const stops = []
  let delay = true
  const h = setup(t, { stop: args => delay ? stops.push(args) : args.success({}) })
  await h.manager.ensureTracking(h.order)
  const stopped = h.manager.stop({ orderId: 'order-1', reason: 'finished' })
  assert.equal(h.manager.stop({ orderId: 'order-1', reason: 'finished' }), stopped)
  const started = h.manager.ensureTracking({ ...h.order, activeSessionIndex: 2 })
  await tick()
  assert.equal(h.calls.filter(call => call[0] === 'background').length, 1)
  delay = false
  stops[0].success({})
  await Promise.all([stopped, started])
  assert.equal(h.calls.filter(call => call[0] === 'background').length, 2)
  assert.equal(h.callbacks.size, 1)
})

test('manual force preserves warmup and quality checks, returns accepted upload result and requests GCJ02', async t => {
  const h = setup(t)
  await h.manager.ensureTracking(h.order)
  await tick()
  global.wx.getLocation = args => {
    assert.equal(args.type, 'gcj02')
    assert.equal(args.isHighAccuracy, true)
    args.success(h.location({ accuracy: 100, recordedAt: Date.now() - 1000 }))
  }
  assert.equal(await h.manager.captureNow({ force: true }), null)
  assert.equal(h.calls.filter(call => call[0] === 'track').length, 0)
  global.wx.getLocation = args => args.success(h.location({ recordedAt: Date.now() - 1000 }))
  assert.deepEqual(await h.manager.captureNow({ force: true }), { count: 1 })
  assert.equal(h.manager.getSnapshot().pointCount, 5)
})

test('disconnect persists captured owner points and automatic callbacks reuse shared backfill', async t => {
  let online = false
  const h = setup(t, { cloud: (module, action, data) => {
    if (module !== 'track') return Promise.resolve(null)
    return online ? Promise.resolve({ count: data.points.length }) : Promise.reject(new Error('network fail'))
  } })
  await h.manager.ensureTracking(h.order)
  await tick()
  h.emit()
  await tick()
  assert.equal(h.queue.getOfflineTaskCount('order-1'), 1)
  const task = h.queue.getOfflineTasks('order-1')[0]
  assert.equal(task.ownerId, 'owner-a')
  assert.equal(task.payload.point.isBackfilled, true)
  assert.ok(task.payload.point.segmentId)
  online = true
  h.queue.retryOfflineTasks('order-1')
  h.emit({ accuracy: 100 })
  await tick()
  assert.equal(h.queue.getOfflineTaskCount('order-1'), 0)
})

test('relogin can restore server-confirmed same-owner service but old login generation cannot enqueue', async t => {
  const oldUpload = deferred()
  let firstUpload = true
  const h = setup(t, { cloud: (module, action, data) => {
    if (module === 'order') return Promise.resolve({ orderId: 'order-1', activeSessionIndex: 1, currentSessionStartedAt: h.order.currentSessionStartedAt })
    if (firstUpload) { firstUpload = false; return oldUpload.promise }
    return Promise.resolve({ count: data.points.length })
  } })
  await h.manager.ensureTracking(h.order)
  await tick()
  h.emit()
  await tick()
  const user = h.app.globalData.user
  h.changeUser(null)
  h.changeUser(user)
  await h.manager.onAppShow()
  assert.equal(h.manager.getSnapshot().backgroundTracking, true)
  oldUpload.reject(new Error('network fail'))
  await tick()
  assert.equal(h.queue.getOfflineTaskCount(), 0)
})

test('matching completed session stops tracking, but an old completed session cannot stop the next session', async t => {
  const h = setup(t)
  await h.manager.ensureTracking(h.order)
  await h.manager.ensureTracking({ ...h.order, status: 'completed' })
  assert.equal(h.callbacks.size, 0)
  await h.manager.ensureTracking({ ...h.order, activeSessionIndex: 2 })
  await h.manager.ensureTracking({ ...h.order, status: 'completed' })
  assert.equal(h.callbacks.size, 1)
})

test('silent cold-start identity discovery restores only a server-confirmed service', async t => {
  const h = setup(t)
  h.changeUser(null)
  const cloud = require(path.join(root, 'cloud'))
  cloud.getCurrentUser = async () => {
    const user = { _id: 'owner-a', roles: ['staff'] }
    h.changeUser(user)
    return user
  }
  cloud.callFunction = async () => ({ orderId: 'order-1', activeSessionIndex: 1, currentSessionStartedAt: h.order.currentSessionStartedAt })
  await h.manager.onAppShow()
  assert.equal(h.manager.getSnapshot().backgroundTracking, true)
  assert.equal(h.calls.filter(call => call[0] === 'privacy' || call[0] === 'authorize').length, 0)
})

test('silent privacy authorization is checked without opening a prompt', async t => {
  const h = setup(t, { active: { orderId: 'order-1', activeSessionIndex: 1 } })
  global.wx.getPrivacySetting = args => args.success({ needAuthorization: true })
  await h.manager.onAppShow()
  assert.equal(h.manager.getSnapshot().trackingState, 'error')
  assert.equal(h.calls.filter(call => call[0] === 'privacy' || call[0] === 'background').length, 0)
})

test('offline rejected/unknown tasks block, duplicates are removed and unowned tasks remain untouched', async t => {
  const h = setup(t, { cloud: (module, action, data) => Promise.resolve(
    data.points[0].clientPointId === 'duplicate' ? { duplicateCount: 1 } : { rejectedCount: 1 }) })
  h.queue.enqueueOfflineTask('track', { orderId: 'order-1', clientPointId: 'bad', point: { ...h.location(), clientPointId: 'bad' } })
  h.queue.enqueueOfflineTask('track', { orderId: 'order-1', clientPointId: 'duplicate', point: { ...h.location(), clientPointId: 'duplicate' } })
  h.queue.enqueueOfflineTask('unknown', { orderId: 'order-1' })
  const key = 'vip_pet_offline_tasks'
  h.storage.set(key, [...h.storage.get(key), { id: 'legacy', orderId: 'order-1' }])
  const result = await h.sync.flushServiceOfflineTasks('order-1')
  assert.deepEqual(result, { flushed: true, offlineTaskCount: 2, offlineBlockedCount: 2, offlineUnownedCount: 1 })
})

test('manual capture remains available when continuous tracking APIs fail', async t => {
  const h = setup(t, { background: args => args.fail({ errMsg: 'not supported' }) })
  global.wx.startLocationUpdate = args => args.fail({ errMsg: 'not supported' })
  await h.manager.ensureTracking(h.order, { interactive: true })
  assert.equal(h.manager.getSnapshot().trackingState, 'error')
  assert.equal(await h.manager.captureNow({ force: true }), null)
  global.wx.getLocation = args => args.success(h.location({ recordedAt: Date.now() - 1000 }))
  assert.deepEqual(await h.manager.captureNow({ force: true }), { count: 1 })
  assert.equal(h.manager.getSnapshot().pointCount, 5)
})

test('interactive start requests ordinary and background scopes separately', async t => {
  const h = setup(t)
  delete h.setting['scope.userLocation']
  delete h.setting['scope.userLocationBackground']
  await h.manager.ensureTracking(h.order, { interactive: true })
  assert.deepEqual(h.calls.filter(call => call[0] === 'authorize').map(call => call[1]), ['scope.userLocation', 'scope.userLocationBackground'])
  assert.equal(h.manager.getSnapshot().backgroundTracking, true)
})

test('server-confirmed absence of active service stops tracking; reconciliation queries are merged', async t => {
  const gate = deferred()
  const h = setup(t, { cloud: module => module === 'order' ? gate.promise : Promise.resolve({ count: 1 }) })
  await h.manager.ensureTracking(h.order)
  const a = h.manager.reconcileActiveService()
  const b = h.manager.reconcileActiveService()
  assert.equal(a, b)
  await tick()
  assert.equal(h.calls.filter(call => call[0] === 'order').length, 1)
  gate.resolve(null)
  await a
  assert.equal(h.callbacks.size, 0)
  assert.equal(h.manager.getSnapshot().autoTracking, false)
})

test('main-package quality implementation is byte-identical to server rules', () => {
  const fs = require('node:fs')
  assert.equal(fs.readFileSync(path.join(root, 'trackQuality.js'), 'utf8'),
    fs.readFileSync(path.resolve(root, '../../cloudfunctions/api/utils/trackQuality.js'), 'utf8'))
})
