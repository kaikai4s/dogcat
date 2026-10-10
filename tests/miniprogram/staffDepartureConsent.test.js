const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function setup(result, hold = false) {
  let page, authorize
  const toasts = [], requests = []
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/client/orders/detail/index.js'), 'utf8'), {
    Page(config) { page = config }, wx: { showToast: value => toasts.push(value) },
    require: (name) => name.includes('nav') ? { createPageNav: () => ({}), navMethods: () => ({}) } : name.includes('sessionChat') ? { sessionChatMethods: () => ({}) } : { requestSubscribeTemplates: (...args) => {
      requests.push(args)
      return hold ? new Promise(resolve => { authorize = resolve }) : Promise.resolve(result)
    }, showError: error => { throw error } }
  })
  return { page, toasts, requests, finish: value => authorize(value) }
}

for (const status of ['accept', 'reject', 'ban', 'filter']) {
  test('order detail reports actual departure consent: ' + status, async () => {
    const { page, toasts, requests } = setup({ requested: true, templateIds: ['departure', 'shared'],
      templateIdByKey: { staffDeparture: 'departure', orderAccepted: 'shared', serviceStart: 'shared' },
      results: { departure: status, shared: 'reject' } })
    await page.subscribeServiceUpdates()
    assert.equal(toasts[0].icon, status === 'accept' ? 'success' : 'none')
    assert.equal(toasts[0].title, status === 'accept' ? '已同意出发提醒' : '未开启提醒，可重新订阅')
    assert.equal(requests[0][0].length, 3)
    assert.equal(requests[0][2].waitForConsent, false)
  })
}

test('partial consent does not claim departure is authorized', async () => {
  const { page, toasts } = setup({ requested: true, templateIds: ['departure', 'other'],
    templateIdByKey: { staffDeparture: 'departure' }, results: { departure: 'reject', other: 'accept' } })
  await page.subscribeServiceUpdates()
  assert.equal(toasts[0].title, '部分提醒已同意')
})

test('failed authorization releases duplicate-click guard and does not show success', async () => {
  const { page, requests, finish, toasts } = setup(null, true)
  const pending = page.subscribeServiceUpdates()
  page.subscribeServiceUpdates()
  assert.equal(requests.length, 1)
  finish({ requested: false, reason: 'request_failed' })
  await pending
  assert.equal(page._subscribingUpdates, false)
  assert.equal(toasts[0].icon, 'none')
})

test('in-service client can authorize finish notification and rejection never reports success', async () => {
  for (const status of ['accept', 'reject']) {
    const { page, toasts, requests } = setup({ requested: true, templateIds: ['finish'], templateIdByKey: { serviceFinish: 'finish' }, results: { finish: status } })
    page.data.order = { status: 'in_service' }
    await page.subscribeServiceUpdates()
    assert.deepEqual([...requests[0][0]], ['serviceFinish', 'serviceProgress', 'remoteUnlock'])
    assert.equal(toasts[0].title, status === 'accept' ? '已同意服务提醒' : '未开启提醒，可重新订阅')
  }
})
