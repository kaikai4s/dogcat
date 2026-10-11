const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const flush = () => new Promise(resolve => setImmediate(resolve))

function setup(file, result = { requested: false, reason: 'request_failed' }) {
  const events = [], requests = [], modals = []
  let page, resolveConsent
  const cloud = {
    requestSubscribeTemplates(keys, scene) {
      events.push('consent'); requests.push({ keys: [...keys], scene })
      return new Promise(resolve => { resolveConsent = () => resolve(result) })
    },
    callFunction(module, action) {
      events.push(action)
      if (action === 'checkAcceptOrderRisk') return Promise.resolve({ requiresConfirmation: true })
      if (action === 'createOrder') return Promise.resolve({ _id: 'order' })
      if (action === 'createPayment') return Promise.resolve({ paid: true })
      if (action === 'checkStartServiceReadiness') return Promise.resolve({ issues: [] })
      return Promise.resolve({})
    },
    loadSystemSettings: async () => { events.push('settings'); return {} },
    showLoading() {}, hideLoading() {}, showError: error => { throw error }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages', file, 'index.js'), 'utf8'), {
    Page(config) { page = config }, console,
    wx: { showToast() {}, getLocation(options) { events.push('location'); if (options && options.fail) options.fail(new Error('mock location failure')) },
      showModal(options) { modals.push(options); if (options.success) options.success({ confirm: false }) },
      redirectTo(options) { events.push('redirect'); if (options.success) options.success() } },
    require(name) {
      if (name.endsWith('/cloud')) return cloud
      if (name.endsWith('/nav')) return { navMethods: () => ({}) }
      if (name.endsWith('/sessionChat')) return { sessionChatMethods: () => ({}) }
      if (name.endsWith('/offlineQueue')) return { createClientRequestId: () => 'req' }
      return {}
    }
  })
  page.setData = function (value, callback) { Object.assign(this.data, value); if (callback) callback() }
  page.data.id = 'order'
  page.load = () => {}
  return { page, events, requests, modals, finish: () => resolveConsent() }
}

for (const file of ['staff/home', 'staff/orders/detail']) {
  test(file + ' requests consent within the original tap before risk checks or geolocation', async () => {
    const { page, events, requests, finish } = setup(file)
    if (file === 'staff/home') page.prepareAcceptOrder('order')
    else page.accept()
    assert.deepEqual(events, ['consent'])
    assert.deepEqual(requests[0].keys, ['staffDirectOrder', 'upcomingServiceReminder', 'serviceProgress'])
    if (file === 'staff/home') page.prepareAcceptOrder('order')
    else page.accept()
    assert.equal(requests.length, 1)
    finish()
    await flush()
    assert.deepEqual(events, ['consent', 'checkAcceptOrderRisk'])
    assert.ok(page.data.acceptRisk)
  })
}

test('start service asks for progress/finish consent before location callback; rejection permits readiness checks', async () => {
  const { page, requests, events, finish } = setup('staff/orders/service')
  page.data.order = { canStartService: true }
  page.start()
  assert.deepEqual(events, ['consent'])
  assert.deepEqual(requests[0].keys, ['serviceProgress', 'serviceFinish'])
  finish()
  await flush()
  assert.deepEqual(events, ['consent', 'location'])
})

test('mall checkout asks for refund consent before creating the order and still pays after refusal', async () => {
  const { page, events, requests, finish } = setup('client/mall/checkout')
  page.data.items = [{ productId: 'item' }]
  page.data.address = { contactName: 'client' }
  page.submit()
  assert.deepEqual(events, ['consent'])
  assert.deepEqual(requests[0].keys, ['refundResult'])
  finish()
  await flush()
  assert.deepEqual(events, ['consent', 'createOrder', 'createPayment', 'redirect'])
})

test('resuming mall payment offers refund consent before creating payment', async () => {
  const { page, events, finish } = setup('client/mall/orders/detail')
  page.pay()
  assert.deepEqual(events, ['consent'])
  finish()
  await flush()
  assert.deepEqual(events, ['consent', 'createPayment'])
  assert.equal(page.data.paying, false)
})

test('service payment covers finish, remote unlock and refund without blocking when subscriptions are unavailable', async () => {
  const { page, events, requests, modals, finish } = setup('client/orders/detail')
  page.pay()
  assert.deepEqual(events, ['consent'])
  assert.deepEqual(requests[0].keys, ['serviceFinish', 'remoteUnlock', 'refundResult'])
  finish()
  await flush()
  assert.ok(events.includes('createPayment'))
  assert.equal(modals.length, 0)
  assert.equal(page.data.paying, false)
})

test('remote unlock refusal is identified by ID mapping and has only one optional follow-up', async () => {
  const { page, finish, events, modals } = setup('client/orders/detail', { requested: true,
    templateKeys: ['serviceFinish', 'remoteUnlock', 'refundResult'], templateIds: ['shared', 'refund'],
    templateIdByKey: { serviceFinish: 'shared', remoteUnlock: 'shared', refundResult: 'refund' },
    results: { shared: 'reject', refund: 'accept' } })
  page.pay()
  finish()
  await flush()
  assert.equal(modals.length, 1)
  assert.equal(modals[0].title, '远程开门提醒未开启')
  assert.ok(events.includes('createPayment'))
})

test('staff requesting remote unlock does not ask for customer authorization on the staff phone', async () => {
  const { page, requests, events } = setup('staff/orders/service')
  page.data.order = { serviceStarted: true }
  page.requestRemoteUnlock()
  await flush()
  assert.equal(requests.length, 0)
  assert.deepEqual(events, ['requestRemoteUnlock'])
})
