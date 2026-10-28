const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const pagePath = name => path.resolve(__dirname, `../../miniprogram/pages/staff/${name}`)

test('deposit policy is next to a required checkbox and reimbursement shows the server conditions', () => {
  const training = fs.readFileSync(pagePath('training/index.wxml'), 'utf8') + fs.readFileSync(pagePath('training/deposit-checkout.wxml'), 'utf8')
  const reimbursement = fs.readFileSync(pagePath('supplies/reimbursement/index.wxml'), 'utf8')
  assert.match(training, /policy-summary[\s\S]*?bindchange="agreeDeposit"[\s\S]*?（必选）/)
  assert.match(training, /bindchange="agreeSupply"[\s\S]*?（必选）/)
  assert.match(training, /disabled="\{\{!depositAgreed \|\| \(depositState\.supplyDeliveryRequired && !supplyAgreed\)/)
  assert.match(training, /supplyQualification\.mode === 'either' \? '以下两项满足任意一项'/)
  assert.match(reimbursement, /qualification\.mode === 'either' \? '以下两项满足任意一项即可申请'/)
  assert.match(reimbursement, /wx:for="\{\{qualification\.conditions\}\}"/)
  assert.match(reimbursement, /disabled="\{\{busy \|\| uploading \|\| loading \|\| \(deliveryMode && !rulesAgreed\)/)
})

test('delivery reimbursement requires explicit consent and sends it to the server', async () => {
  let page
  const calls = [], toasts = []
  vm.runInNewContext(fs.readFileSync(pagePath('supplies/reimbursement/index.js'), 'utf8'), {
    Page(config) { page = config },
    wx: {
      showToast(options) { toasts.push(options.title) }, showLoading() {}, hideLoading() {}
    },
    require(name) {
      if (name.endsWith('/image-upload')) return { uploadImage() {} }
      if (name.endsWith('/cloud')) return { callFunction: async (...args) => { calls.push(args); return {} }, showError() {}, requirePrivacyAuthorize() {} }
      if (name.endsWith('/theme')) return { applyTheme() {}, getThemeState() { return {} } }
      if (name.endsWith('/clipboard')) return { copyText() {} }
      throw new Error(`Unexpected dependency: ${name}`)
    }
  })
  page.setData = patch => Object.assign(page.data, patch)
  page.load = async () => {}
  Object.assign(page.data, { canApply: true, deliveryMode: true, loading: false, busy: false, uploading: false })
  await page.submit()
  assert.equal(calls.length, 0)
  assert.match(toasts[0], /勾选/)
  page.agreeRules({ detail: { value: ['agreed'] } })
  await page.submit()
  assert.equal(calls[0][1], 'submitSupplyReimbursement')
  assert.equal(calls[0][2].rulesConfirmed, true)
})
