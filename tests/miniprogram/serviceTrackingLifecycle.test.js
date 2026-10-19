const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function read(relative) {
  return fs.readFileSync(path.join(__dirname, '../../miniprogram', relative), 'utf8')
}

test('App forwards show/hide to service tracking without tying it to a page', () => {
  let app
  const calls = []
  const tracking = { onAppShow: () => calls.push('show'), onAppHide: () => calls.push('hide') }
  vm.runInNewContext(read('app.js'), {
    App: options => { app = options },
    require(name) {
      if (name.endsWith('/serviceTrackingManager')) return tracking
      if (name.endsWith('/adminAccess')) return { installAdminPageGuard() {} }
      return {}
    }
  })
  app.onShow()
  app.onHide()
  app.onShow()
  assert.deepEqual(calls, ['show', 'hide', 'show'])
})

test('active service banner shares tracking state and detaches only its subscription', async () => {
  let component, listener, unsubscribeCount = 0, reconcileCount = 0
  let pages = [{ route: 'pages/staff/home/index', options: {} }]
  let snapshot = { orderId: 'order-1', backgroundTracking: true, trackingState: 'background' }
  const tracking = {
    getSnapshot: () => snapshot,
    subscribe(fn) { listener = fn; fn(snapshot); return () => { unsubscribeCount++ } },
    async reconcileActiveService() { reconcileCount++ }
  }
  vm.runInNewContext(read('components/staff-active-service-banner/index.js'), {
    Component: options => { component = options },
    getCurrentPages: () => pages,
    require: () => tracking
  })
  const instance = { data: { ...component.data }, ...component.methods,
    setData(updates) { Object.assign(this.data, updates) } }
  component.lifetimes.attached.call(instance)
  assert.equal(instance.data.visible, true)
  assert.match(instance.data.trackingDescription, /后台定位已开启/)
  snapshot = { ...snapshot, backgroundTracking: false, trackingState: 'foreground' }
  listener(snapshot)
  assert.match(instance.data.trackingDescription, /未开启/)
  pages = [{ route: 'pages/staff/orders/service/index', options: { id: 'order-1' } }]
  await component.pageLifetimes.show.call(instance)
  assert.equal(instance.data.visible, false)
  assert.equal(reconcileCount, 2)
  component.lifetimes.detached.call(instance)
  assert.equal(unsubscribeCount, 1)
  listener({ orderId: 'order-2' })
  assert.equal(instance.data.activeService.orderId, 'order-1')
})

test('main package declares continuous background location APIs and location mode', () => {
  const config = JSON.parse(read('app.json'))
  assert.ok(config.requiredBackgroundModes.includes('location'))
  for (const api of ['getLocation', 'onLocationChange', 'startLocationUpdate', 'startLocationUpdateBackground']) {
    assert.ok(config.requiredPrivateInfos.includes(api), api)
  }
  assert.ok(config.permission['scope.userLocation'].desc)
})
