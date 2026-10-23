const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { generateKeyPairSync } = require('node:crypto')
const { paymentKeyInputIssue } = require('../../miniprogram/pages/admin/settings/payment-config')

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
})

test('complete merchant and platform PEM inputs accept normal and escaped newlines', () => {
  for (const transform of [value => value, value => value.replace(/\n/g, '\r\n'), value => value.replace(/\n/g, '\\n')]) {
    assert.equal(paymentKeyInputIssue({ privateKeyInput: transform(keys.privateKey), platformPublicKeyInput: transform(keys.publicKey) }), '')
  }
})

test('140-character truncated keys and wrong key types are rejected without including the key in errors', () => {
  for (const value of [keys.privateKey.slice(0, 140), keys.publicKey, 'apiclient_key.pem', keys.privateKey.replace('END PRIVATE KEY', 'END PUBLIC KEY')]) {
    const issue = paymentKeyInputIssue({ privateKeyInput: value })
    assert.match(issue, /商户私钥格式不完整/)
    assert.ok(!issue.includes(keys.privateKey.slice(32, 90)))
  }
  assert.match(paymentKeyInputIssue({ platformPublicKeyInput: keys.publicKey.slice(0, 140) }), /平台公钥格式不完整/)
  assert.match(paymentKeyInputIssue({ platformPublicKeyInput: keys.privateKey }), /平台公钥格式不完整/)
})

test('empty inputs preserve existing settings and are not treated as new invalid keys', () => {
  assert.equal(paymentKeyInputIssue(), '')
  assert.equal(paymentKeyInputIssue({ privateKeyInput: ' ', platformPublicKeyInput: '', privateKeyConfigured: true }), '')
})

function loadPage(relativePath, cloud, wx = {}) {
  let page
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../miniprogram', relativePath), 'utf8'), {
    Page(value) { page = value },
    require(name) {
      if (name.endsWith('/cloud')) return cloud
      if (name.endsWith('/payment-config')) return require(path.resolve(__dirname, '../../miniprogram', path.dirname(relativePath), name))
      if (name.endsWith('/offlineQueue')) return { createClientRequestId: () => 'test-payment' }
      if (name.endsWith('/subscription-options')) return require('../../miniprogram/utils/subscription-options')
      if (name.endsWith('/sessionChat')) return { sessionChatMethods: () => ({}) }
      if (name.endsWith('/nav')) return { navMethods: () => ({}) }
      return {}
    },
    wx, setTimeout, clearTimeout
  })
  page.setData = patch => Object.assign(page.data, patch)
  return page
}

test('settings refuses to submit a truncated merchant private key', () => {
  const errors = []
  const page = loadPage('pages/admin/settings/index.js', {
    showError: error => errors.push(error.message),
    callFunction() { assert.fail('Invalid key must not be submitted') }
  })
  page.data.loaded = true
  page.data.settings.payment.privateKeyInput = keys.privateKey.slice(0, 140)
  page.save()
  assert.equal(errors.length, 1)
  assert.match(errors[0], /商户私钥格式不完整/)
  assert.equal(page.data.saving, false)
})

test('settings submits complete keys unchanged and allows blank inputs to keep stored keys', () => {
  for (const inputs of [{ privateKeyInput: keys.privateKey, platformPublicKeyInput: keys.publicKey }, { privateKeyInput: '', platformPublicKeyInput: '' }]) {
    const calls = []
    const page = loadPage('pages/admin/settings/index.js', {
      showError: error => assert.fail(error.message),
      callFunction: (...args) => { calls.push(args); return new Promise(() => {}) }
    })
    page.data.loaded = true
    Object.assign(page.data.settings.payment, inputs)
    page.save()
    assert.equal(calls.length, 1)
    assert.equal(calls[0][1], 'saveSystemSettings')
    assert.equal(calls[0][2].payment.privateKeyInput, inputs.privateKeyInput)
    assert.equal(calls[0][2].payment.platformPublicKeyInput, inputs.platformPublicKeyInput)
  }
})

test('order payment preserves detailed failure and releases the retry lock', async () => {
  for (const message of ['微信支付下单失败：error:0908F066:PEM routines:get_header_and_data:bad end line', '微信支付下单失败：商户号与 AppID 未绑定', '微信支付回调地址必须是 HTTPS']) {
    const errors = []
    const failure = new Error(message)
    const page = loadPage('pages/client/orders/detail/index.js', {
      showError: error => errors.push(error),
      requestSubscribeTemplates: async () => ({ requested: false }),
      callFunction: async () => { throw failure },
      showLoading() {}, hideLoading() {}
    }, { showToast() { assert.fail('Detailed failure must not be replaced by a toast') } })
    page.data.id = 'order-test'
    page.pay()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(errors.length, 1)
    assert.equal(errors[0], failure)
    assert.equal(page.data.paying, false)
    assert.equal(page._payingLock, false)
  }
})

test('settings logistics panel submits a separate Juhe key and blocks read-only editing', () => {
  const calls = []
  const page = loadPage('pages/admin/settings/index.js', {
    showError: error => assert.fail(error.message), callFunction: (...args) => { calls.push(args); return new Promise(() => {}) }
  })
  const patches = []
  page.setData = patch => {
    patches.push(patch)
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split('.')
      let obj = page.data
      for (const part of parts.slice(0, -1)) obj = obj[part]
      obj[parts.at(-1)] = value
    }
  }
  page.logisticsInput({ currentTarget: { dataset: { field: 'juheKeyInput' } }, detail: { value: 'cannot-change' } })
  assert.equal(patches.length, 0)
  page.data.adminSuper = true
  page.data.loaded = true
  page.logisticsProviderChange({ detail: { value: '0' } })
  page.logisticsInput({ currentTarget: { dataset: { field: 'juheKeyInput' } }, detail: { value: '  TEST_JUHE_KEY_1234567890  ' } })
  page.save()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][2].logistics.juheKeyInput, 'TEST_JUHE_KEY_1234567890')
  assert.equal(calls[0][2].logistics.provider, 'juhe')
  assert.equal(calls[0][2].juheTelecomKeyInput, undefined)
})
