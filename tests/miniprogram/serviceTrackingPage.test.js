const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const order = { _id: 'order', status: 'in_service', activeSessionIndex: 2, currentSessionStartedAt: '2026-10-19 10:00:00' }
function setup(t, options = {}) {
  let page, listener
  const calls = [], modals = [], errors = [], timers = new Set()
  let snapshot = { orderId: 'order', trackingState: 'background', pointCount: 3 }
  const manager = {
    subscribe(fn) { calls.push(['subscribe']); listener = fn; fn(snapshot); return () => calls.push(['unsubscribe']) },
    getSnapshot: () => snapshot,
    ensureTracking(value, settings) { calls.push(['ensure', value, settings]); return Promise.resolve(snapshot) },
    stop(value) { calls.push(['stop', value]); return Promise.resolve({}) },
    retryBackgroundTracking() { calls.push(['retry']); return Promise.resolve(snapshot) },
    captureNow(value) { calls.push(['capture', value]); return options.capture ? options.capture() : Promise.resolve({ count: 1 }) },
    prepareFinish(id) { calls.push(['prepare', id]); return options.prepare ? options.prepare() : Promise.resolve() },
    resumeAfterFinishFailure(value) { calls.push(['resume', value]); return Promise.resolve(snapshot) }
  }
  const cloud = {
    async callFunction(module, action, data) {
      calls.push([action, data])
      if (options.cloud) return options.cloud(action, data)
      if (action === 'getOrderDetail') return { ...order }
      if (action === 'listOrderCheckins') return []
      if (action === 'checkStartServiceReadiness') return { canStart: true }
      if (action === 'startService') return { id: 'order', status: 'in_service', activeSessionIndex: 2, currentSessionStartedAt: order.currentSessionStartedAt }
      if (action === 'finishService') return { status: 'day_completed' }
      return {}
    },
    requirePrivacyAuthorize: async () => {}, requestSubscribeTemplates: async () => {}, loadSystemSettings: async () => {},
    showLoading() {}, hideLoading() {}, showError: error => errors.push(error)
  }
  const wx = {
    showToast() {}, showModal: value => modals.push(value),
    openSetting(value) { calls.push(['settings']); value.success({ errMsg: 'openSetting:ok' }) },
    getLocation(value) { options.locationFail ? value.fail(new Error('denied')) : value.success({ latitude: 31.2, longitude: 121.5 }) }
  }
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/staff/orders/service/index.js'), 'utf8'), {
    Page: definition => { page = definition }, wx,
    getApp: () => ({ globalData: { user: {} } }),
    setInterval(fn, delay) { const timer = setInterval(fn, delay); timers.add(timer); return timer }, clearInterval,
    setTimeout, clearTimeout,
    require(name) {
      if (name.endsWith('/serviceTrackingManager')) return manager
      if (name.endsWith('/serviceOfflineSync')) return { flushServiceOfflineTasks: async id => {
        calls.push(['flush', id])
        return options.flush ? options.flush() : { flushed: false, offlineTaskCount: 0, offlineBlockedCount: 0, offlineUnownedCount: 0 }
      } }
      if (name.endsWith('/cloud')) return cloud
      if (name.endsWith('/offlineQueue')) return { createClientRequestId: () => 'request', getOfflineTaskCount: () => 0, retryOfflineTasks: id => calls.push(['retryOffline', id]) }
      if (name.endsWith('/sessionChat')) return { sessionChatMethods: () => ({ stopSessionChatRefresh() {} }) }
      if (name.endsWith('/nav')) return { navMethods: () => ({}), createPageNav: () => ({}) }
      if (name.endsWith('/theme')) return { applyTheme: () => ({ value: 'day' }), getThemeState: () => ({}) }
      if (name.endsWith('/format')) return require('../../miniprogram/utils/format')
      return {}
    }
  })
  page.setData = value => { assert.notEqual(page._unloaded, true, 'unloaded page must not update UI'); Object.assign(page.data, value) }
  page.data.id = 'order'
  page.data.order = { ...order, serviceStarted: true }
  t.after(() => timers.forEach(clearInterval))
  return { page, manager, calls, modals, errors, emit(value) { snapshot = value; listener(value) } }
}

test('onLoad subscribes only to this order; hide/unload never stop the global session', async t => {
  const h = setup(t)
  h.page.onLoad({ id: 'order' })
  await tick()
  h.emit({ orderId: 'other', pointCount: 99 })
  assert.notEqual(h.page.data.pointCount, 99)
  h.emit({ orderId: 'order', pointCount: 8, trackingState: 'foreground' })
  assert.equal(h.page.data.pointCount, 8)
  h.page.onHide()
  h.page.onUnload()
  h.emit({ orderId: 'order', pointCount: 100 })
  assert.equal(h.page.data.pointCount, 8)
  assert.equal(h.calls.filter(c => c[0] === 'unsubscribe').length, 1)
  assert.equal(h.calls.filter(c => c[0] === 'stop').length, 0)
})

test('a stopped global session clears the page background badge without erasing evidence counts', async t => {
  const h = setup(t)
  h.page.onLoad({ id: 'order' })
  await tick()
  h.emit({ orderId: 'order', trackingState: 'background', autoTracking: true, backgroundTracking: true, pointCount: 8 })
  h.emit({ orderId: '', trackingState: 'idle', autoTracking: false, backgroundTracking: false, pointCount: 0 })
  assert.equal(h.page.data.backgroundTracking, false)
  assert.equal(h.page.data.autoTracking, false)
  assert.equal(h.page.data.trackingState, 'error')
  assert.equal(h.page.data.pointCount, 8)
})

test('interactive wrapper and automatic order refresh pass distinct manager options', async t => {
  const h = setup(t)
  await h.page.startAutoTracking()
  await h.page.loadOrder()
  const ensures = h.calls.filter(c => c[0] === 'ensure')
  assert.equal(ensures.length, 2)
  assert.equal(ensures[0][1]._id, 'order')
  assert.equal(ensures[0][2].interactive, true)
  assert.equal(ensures[1][2].interactive, false)
  assert.equal(h.modals.length, 0)
})

test('reading an inactive order never stops another global service', async t => {
  const h = setup(t, { cloud: async action => action === 'getOrderDetail' ? { _id: 'order', status: 'completed' } : [] })
  h.manager.getSnapshot = () => ({ orderId: 'other' })
  await h.page.loadOrder()
  assert.equal(h.calls.some(c => c[0] === 'stop'), false)
  assert.equal(h.calls.some(c => c[0] === 'ensure'), false)
})

test('server-confirmed inactive state is synchronized silently for the same global order', async t => {
  const h = setup(t, { cloud: async action => action === 'getOrderDetail' ? { ...order, status: 'completed' } : [] })
  await h.page.loadOrder()
  const synced = h.calls.find(c => c[0] === 'ensure')
  assert.equal(synced[1].status, 'completed')
  assert.equal(synced[1].currentSessionStartedAt, order.currentSessionStartedAt)
  assert.equal(synced[2].interactive, false)
  assert.equal(h.calls.some(c => c[0] === 'stop'), false)
})

for (const unload of [false, true]) {
  test(`late load response is ignored after ${unload ? 'unload' : 'a newer order request'}`, async t => {
    const old = deferred()
    let reads = 0
    const h = setup(t, { cloud: action => action === 'getOrderDetail' ? (++reads === 1 ? old.promise : Promise.resolve({ _id: 'order', status: 'completed' })) : Promise.resolve([]) })
    const loading = h.page.loadOrder()
    if (unload) h.page.onUnload()
    else await h.page.loadOrder()
    old.resolve(order)
    await loading
    assert.equal(h.calls.some(c => c[0] === 'ensure' && c[1].status === 'in_service'), false)
    if (!unload) assert.equal(h.page.data.order.status, 'completed')
  })
}

test('finish freezes before API, invalidates old reads, stops with completed and updates UI without refresh', async t => {
  const freeze = deferred(), old = deferred()
  let reads = 0
  const h = setup(t, { prepare: () => freeze.promise, cloud: async action => {
    if (action === 'getOrderDetail') { if (++reads === 1) return old.promise; throw new Error('refresh offline') }
    if (action === 'finishService') return { status: 'day_completed' }
    return []
  } })
  const loading = h.page.loadOrder()
  const finishing = h.page._doFinish()
  assert.equal(h.calls.some(c => c[0] === 'finishService'), false)
  old.resolve(order)
  await loading
  assert.equal(h.calls.some(c => c[0] === 'ensure'), false)
  freeze.resolve()
  await finishing
  await tick()
  assert.equal(h.page.data.order.status, 'day_completed')
  assert.equal(h.page.data.order.serviceStarted, false)
  assert.equal(h.calls.find(c => c[0] === 'stop')[1].reason, 'completed')
  assert.equal(h.calls.some(c => c[0] === 'resume'), false)
})

test('failed finish resumes the exact confirmed session without interactive authorization', async t => {
  const h = setup(t, { cloud: async action => { if (action === 'finishService') throw new Error('network'); return [] } })
  await h.page._doFinish()
  const resumed = h.calls.find(c => c[0] === 'resume')[1]
  assert.equal(resumed.currentSessionStartedAt, order.currentSessionStartedAt)
  assert.equal(resumed.activeSessionIndex, 2)
  assert.equal(h.calls.some(c => c[0] === 'stop'), false)
  assert.equal(h.errors.length, 1)
})

for (const repeated of [false, true]) {
  test(`start immediately uses ${repeated ? 'getActiveService for an idempotent response' : 'server-confirmed session'} even if detail fails`, async t => {
    const h = setup(t, { cloud: async action => {
      if (action === 'checkStartServiceReadiness') return { canStart: true }
      if (action === 'startService') return repeated ? { id: 'order', status: 'in_service' } : { id: 'order', ...order }
      if (action === 'getActiveService') return { orderId: 'order', activeSessionIndex: 2, currentSessionStartedAt: order.currentSessionStartedAt }
      if (action === 'getOrderDetail') throw new Error('offline')
      return []
    } })
    h.page.data.order = { status: 'assigned', canStartService: true }
    h.page.start()
    await tick()
    const ensured = h.calls.find(c => c[0] === 'ensure')
    assert.ok(ensured)
    assert.equal(ensured[1].currentSessionStartedAt, order.currentSessionStartedAt)
    assert.equal(ensured[1].activeSessionIndex, 2)
    assert.equal(ensured[2].interactive, true)
    assert.equal(h.page.data.order.serviceStarted, true)
    assert.equal(h.calls.some(c => c[0] === 'getActiveService'), repeated)
  })
}

test('missing session read failure provides guidance and never fabricates a session', async t => {
  const h = setup(t, { cloud: async action => {
    if (action === 'checkStartServiceReadiness') return { canStart: true }
    if (action === 'startService') return { id: 'order', status: 'in_service' }
    throw new Error('network')
  } })
  h.page.data.order = { status: 'assigned', canStartService: true }
  h.page.start()
  await tick()
  assert.equal(h.calls.some(c => c[0] === 'ensure'), false)
  assert.match(h.page.data.trackingErrorText, /场次.*读取失败/)
  assert.equal(h.modals[0].confirmText, '去设置')
})

test('manual capture rejection is handled and silent capture stays silent', async t => {
  const h = setup(t, { capture: () => Promise.reject(new Error('denied')) })
  await h.page.uploadPoint()
  await h.page.uploadPoint({ silent: true })
  assert.equal(h.errors.length, 1)
  assert.equal(h.calls.find(c => c[0] === 'capture')[1].force, true)
})

test('pending notice waits for visible page and settings return invokes manager retry', async t => {
  const h = setup(t)
  h.page._pendingTrackingNotice = true
  h.page._pageHidden = true
  h.page.applyTrackingSnapshot({ orderId: 'order', trackingState: 'foreground' })
  assert.equal(h.modals.length, 0)
  h.page._pageHidden = false
  h.page.showPendingTrackingNotice()
  assert.match(h.modals[0].content, /小程序内切换页面/)
  assert.equal(h.modals[0].confirmText, '去设置')
  h.modals[0].success({ confirm: true })
  await tick()
  assert.ok(h.calls.some(c => c[0] === 'retry'))
  const template = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/staff/orders/service/index.wxml'), 'utf8')
  assert.match(template, /open-type="openSetting" bindopensetting="onTrackingSettingsOpened"/)
})

test('start location failure links settings and explains system and WeChat permissions', async t => {
  const h = setup(t, { locationFail: true })
  h.page.data.order = { canStartService: true }
  h.page.start()
  await tick()
  assert.match(h.modals[0].content, /系统设置.*微信/)
  assert.equal(h.modals[0].confirmText, '去设置')
  h.modals[0].success({ confirm: true })
  assert.ok(h.calls.some(c => c[0] === 'settings'))
})

test('offline flush displays shared result and only successful flush reloads once', async t => {
  let attempts = 0
  const h = setup(t, { flush: async () => ({ flushed: ++attempts === 1, offlineTaskCount: 4, offlineBlockedCount: 2, offlineUnownedCount: 1 }) })
  await h.page.flushOfflineTasks()
  await tick()
  assert.equal(h.calls.filter(c => c[0] === 'getOrderDetail').length, 1)
  assert.equal(attempts, 2)
  assert.equal(h.page.data.offlineTaskCount, 4)
  assert.equal(h.page.data.offlineBlockedCount, 2)
  assert.equal(h.page.data.offlineUnownedCount, 1)
  h.page.retryOfflineUploads()
  h.modals.at(-1).success({ confirm: true })
  await tick()
  assert.ok(h.calls.some(c => c[0] === 'retryOffline'))
  assert.equal(h.calls.filter(c => c[0] === 'getOrderDetail').length, 1)
})

test('reading another in-service order cannot replace the global session or capture into it', async t => {
  const h = setup(t)
  h.manager.getSnapshot = () => ({ orderId: 'other', trackingState: 'background' })
  await h.page.loadOrder()
  await h.page.uploadPoint()
  assert.equal(h.calls.some(c => ['ensure', 'stop', 'capture'].includes(c[0])), false)
  assert.equal(h.errors.length, 1)
})

test('start response after unload still hands confirmed session to the manager silently', async t => {
  const response = deferred()
  const h = setup(t, { cloud: async action => {
    if (action === 'checkStartServiceReadiness') return { canStart: true }
    if (action === 'startService') return response.promise
    return []
  } })
  h.page.data.order = { status: 'assigned', canStartService: true }
  h.page.start()
  await tick()
  h.page.onUnload()
  response.resolve({ id: 'order', ...order })
  await tick()
  const ensured = h.calls.find(c => c[0] === 'ensure')
  assert.equal(ensured[1].currentSessionStartedAt, order.currentSessionStartedAt)
  assert.equal(ensured[2].interactive, false)
  assert.equal(h.modals.length, 0)
  assert.equal(h.calls.some(c => c[0] === 'getOrderDetail'), false)
})

test('finish in flight survives unload without updating its page', async t => {
  const response = deferred()
  const h = setup(t, { cloud: action => action === 'finishService' ? response.promise : Promise.resolve([]) })
  const finishing = h.page._doFinish()
  await tick()
  h.page.onUnload()
  response.resolve({ status: 'completed' })
  await finishing
  assert.equal(h.calls.find(c => c[0] === 'stop')[1].reason, 'completed')
  assert.equal(h.calls.some(c => c[0] === 'getOrderDetail'), false)
})

test('pending notices offer no settings prompt for successful background tracking', t => {
  const h = setup(t)
  h.page._pendingTrackingNotice = true
  h.page.applyTrackingSnapshot({ orderId: 'order', trackingState: 'background' })
  assert.match(h.modals[0].content, /切换小程序页面、返回微信/)
  assert.equal(h.modals[0].confirmText, '知道了')
  h.modals[0].success({ confirm: true })
  assert.equal(h.calls.some(c => c[0] === 'settings'), false)
})

test('offline flush completion after unload never updates or reloads the page', async t => {
  const response = deferred()
  const h = setup(t, { flush: () => response.promise })
  const flushing = h.page.flushOfflineTasks()
  h.page.onUnload()
  response.resolve({ flushed: true, offlineTaskCount: 0, offlineBlockedCount: 0, offlineUnownedCount: 0 })
  await flushing
  assert.equal(h.calls.some(c => c[0] === 'getOrderDetail'), false)
})

test('reassignment uses order-scoped business stop reason', t => {
  const h = setup(t)
  h.page.handleOrderReassigned('改派')
  const stopped = h.calls.find(c => c[0] === 'stop')[1]
  assert.equal(stopped.orderId, 'order')
  assert.equal(stopped.reason, 'reassigned')
})
