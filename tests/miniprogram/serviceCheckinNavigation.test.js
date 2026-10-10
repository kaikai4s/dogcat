const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function loadServicePage({ status = 'on_the_way', preflight = () => Promise.resolve(), navigate } = {}) {
  let page
  const calls = [], navigations = [], errors = [], toasts = []
  const dependencies = {
    sessionChatMethods: () => ({}), navMethods: () => ({}),
    callFunction(module, action, data) {
      calls.push({ module, action, data })
      return preflight()
    },
    showError: (error) => errors.push(error)
  }
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/staff/orders/service/index.js'), 'utf8'), {
    Page(config) { page = config },
    require: () => dependencies,
    wx: {
      navigateTo(options) {
        navigations.push(options)
        if (navigate) navigate(options)
        else if (options.success) options.success()
      },
      showToast: (options) => toasts.push(options)
    },
    setTimeout, clearTimeout, setInterval, clearInterval
  })
  page.setData = (updates) => Object.assign(page.data, updates)
  page.setData({ id: 'order-123', order: { status, serviceStarted: status === 'in_service' } })
  page.stopSessionChatRefresh = () => {}
  return { page, calls, navigations, errors, toasts }
}

const tap = (type = 'sanitization') => ({ currentTarget: { dataset: { type } } })

test('pre-service sanitization opens for every eligible order status, including on_the_way', async () => {
  for (const status of ['on_the_way', 'assigned', 'day_completed']) {
    const { page, calls, navigations, errors } = loadServicePage({ status })
    await page.checkin(tap())
    assert.equal(calls.length, 1, `${status} must check the service time`)
    assert.equal(calls[0].action, 'checkServiceTimeReadyForCheckin')
    assert.equal(calls[0].data.id, 'order-123')
    assert.equal(navigations.length, 1, `${status} must open the camera page`)
    assert.equal(navigations[0].url, '/pages/staff/checkin/camera/index?id=order-123&eventType=sanitization')
    assert.equal(errors.length, 0)
    assert.equal(page.data.openingCheckinType, '')
  }
})

test('repeated taps cannot start overlapping checks or camera page transitions', async () => {
  const ready = deferred()
  const { page, calls, navigations } = loadServicePage({ preflight: () => ready.promise, navigate: () => {} })
  const first = page.checkin(tap())
  page.checkin(tap())
  assert.equal(calls.length, 1)
  assert.equal(page.data.openingCheckinType, 'sanitization')
  ready.resolve()
  await new Promise(setImmediate)
  page.checkin(tap())
  assert.equal(navigations.length, 1)
  assert.equal(calls.length, 1)
  navigations[0].success()
  await first
  assert.equal(page.data.openingCheckinType, '')
})

test('time restriction is shown without opening the camera, and the user can retry', async () => {
  const error = new Error('服务时间未到，可申请提前开始')
  let blocked = true
  const { page, navigations, errors } = loadServicePage({ preflight: () => blocked ? Promise.reject(error) : Promise.resolve() })
  await page.checkin(tap())
  assert.equal(errors[0], error)
  assert.equal(navigations.length, 0)
  assert.equal(page.data.openingCheckinType, '')
  blocked = false
  await page.checkin(tap())
  assert.equal(navigations.length, 1)
})

test('camera page navigation failure is reported and releases the button', async () => {
  const error = { errMsg: 'navigateTo:fail route failed' }
  const { page, errors } = loadServicePage({ navigate: (options) => options.fail(error) })
  await page.checkin(tap())
  assert.equal(errors[0], error)
  assert.equal(page.data.openingCheckinType, '')
})

test('leaving the service page cancels navigation after a delayed time check', async () => {
  for (const lifecycle of ['onHide', 'onUnload']) {
    const ready = deferred()
    const { page, navigations } = loadServicePage({ preflight: () => ready.promise })
    const pending = page.checkin(tap())
    page[lifecycle]()
    ready.resolve()
    await pending
    assert.equal(navigations.length, 0, lifecycle)
  }
})

test('obsolete check completion cannot release a newer request after returning to the page', async () => {
  const firstCheck = deferred(), secondCheck = deferred()
  let count = 0
  const { page, navigations } = loadServicePage({ preflight: () => (++count === 1 ? firstCheck.promise : secondCheck.promise) })
  const first = page.checkin(tap())
  page.onHide()
  const second = page.checkin(tap())
  firstCheck.resolve()
  await first
  assert.equal(page.data.openingCheckinType, 'sanitization')
  assert.equal(navigations.length, 0)
  secondCheck.resolve()
  await second
  assert.equal(navigations.length, 1)
  assert.equal(page.data.openingCheckinType, '')
})

test('checkins during service open without the pre-service time check', async () => {
  for (const type of ['sanitization', 'feed']) {
    const { page, calls, navigations } = loadServicePage({ status: 'in_service' })
    await page.checkin(tap(type))
    assert.equal(calls.length, 0)
    assert.equal(navigations.length, 1)
  }
})

test('ineligible order states explain why checkin cannot start', async () => {
  for (const [status, type] of [['completed', 'sanitization'], ['cancelled', 'sanitization'], ['on_the_way', 'feed']]) {
    const { page, calls, navigations, toasts } = loadServicePage({ status })
    await page.checkin(tap(type))
    assert.equal(calls.length, 0)
    assert.equal(navigations.length, 0)
    assert.equal(toasts.length, 1)
  }
})
