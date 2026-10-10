const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const flush = () => new Promise(resolve => setImmediate(resolve))

function setup({ refundAmount = 25.5, confirm = true, consentError = false } = {}) {
  const calls = []
  const subscriptions = []
  let finishConsent
  let page
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/client/orders/detail/index.js'), 'utf8'), {
    Page(value) { page = value },
    wx: { showModal(options) { options.success({ confirm }) }, showToast() {} },
    require(name) {
      if (name.endsWith('/sessionChat')) return { sessionChatMethods: () => ({}) }
      if (name.endsWith('/nav')) return { navMethods: () => ({}) }
      if (name.endsWith('/cloud')) return {
        callFunction(module, action) {
          calls.push(action)
          return Promise.resolve(action === 'getCancelQuote' ? { canCancel: true, refundAmount, ruleText: '可取消' } : {})
        },
        requestSubscribeTemplates(keys, scene, options) {
          subscriptions.push({ keys, scene, options })
          return new Promise((resolve, reject) => { finishConsent = () => consentError ? reject(new Error('request failed')) : resolve({ requested: true, results: { refund: 'reject' } }) })
        },
        showError(error) { throw error }
      }
      if (name.endsWith('/offlineQueue')) return { createClientRequestId: () => 'cancel-test' }
      return {}
    }
  })
  page.setData = function (value) { Object.assign(this.data, value) }
  page.data.id = 'order'
  page.load = () => {}
  return { page, calls, subscriptions, finish: () => finishConsent() }
}

for (const consentError of [false, true]) {
  test(`service cancellation waits for refund consent and proceeds after ${consentError ? 'API failure' : 'rejection'}`, async () => {
    const { page, calls, subscriptions, finish } = setup({ consentError })
    page.cancelOrder()
    page.cancelOrder()
    await flush()
    assert.deepEqual(calls, ['getCancelQuote'])
    assert.equal(subscriptions.length, 1)
    assert.deepEqual([...subscriptions[0].keys], ['refundResult'])
    assert.equal(subscriptions[0].options.waitForConsent, false)
    finish()
    await flush()
    assert.deepEqual(calls, ['getCancelQuote', 'cancelOrder'])
    assert.equal(page.data.cancelling, false)
  })
}

test('unpaid cancellation and dismissed cancellation do not consume refund subscription', async () => {
  const unpaid = setup({ refundAmount: 0 })
  unpaid.page.cancelOrder()
  await flush()
  assert.equal(unpaid.subscriptions.length, 0)
  assert.deepEqual(unpaid.calls, ['getCancelQuote', 'cancelOrder'])
  const dismissed = setup({ confirm: false })
  dismissed.page.cancelOrder()
  await flush()
  assert.equal(dismissed.subscriptions.length, 0)
  assert.deepEqual(dismissed.calls, ['getCancelQuote'])
  assert.equal(dismissed.page.data.cancelling, false)
})
