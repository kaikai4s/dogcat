const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function settingsPage() {
  let page
  const calls = [], errors = [], pending = []
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/settings/index.js'), 'utf8'), {
    Page(config) { page = config },
    wx: { showToast() {} },
    require(name) {
      if (name.endsWith('/subscription-options')) return require('../../miniprogram/utils/subscription-options')
      if (name.endsWith('/payment-config')) return require('../../miniprogram/pages/admin/settings/payment-config')
      return {
        callFunction: (...args) => { calls.push(args); return new Promise(resolve => pending.push(resolve)) },
        setCachedSystemSettings() {},
        showError: error => errors.push(error.message)
      }
    }
  })
  page.setData = patch => {
    for (const [key, value] of Object.entries(patch)) {
      const fields = key.split('.')
      const target = fields.slice(0, -1).reduce((obj, field) => obj[field], page.data)
      target[fields[fields.length - 1]] = value
    }
  }
  page.data.loaded = true
  page.data.settings.staffTraining.quiz = structuredClone(require('../../cloudfunctions/api/config/constants').DEFAULT_STAFF_TRAINING_QUIZ)
  return { page, calls, errors, completeSave: settings => pending[0](settings) }
}

test('administrator can select both reimbursement conditions, save, and reload them', async () => {
  const { page, calls, errors, completeSave } = settingsPage()
  page.reimbursementModesChange({ detail: { value: ['order_count', 'invite_count'] } })
  page.data.settings.staffSupplies.reimbursementOrderCount = 5
  page.data.settings.staffSupplies.reimbursementInviteCount = 2
  page.save()
  assert.deepEqual(errors, [])
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1], 'saveSystemSettings')
  const saved = calls[0][2].staffSupplies
  assert.equal(saved.reimbursementMode, 'either')
  assert.equal(saved.reimbursementOrderCount, 5)
  assert.equal(saved.reimbursementInviteCount, 2)

  completeSave(calls[0][2])
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(errors, [])
  const reloaded = page.data.settings.staffSupplies
  assert.equal(reloaded.reimbursementMode, 'either')
  assert.equal(reloaded.reimbursementOrderCount, 5)
  assert.equal(reloaded.reimbursementInviteCount, 2)
})

test('unchecking one condition keeps only the selected condition, and empty selection cannot be saved', () => {
  const { page, calls, errors } = settingsPage()
  for (const mode of ['order_count', 'invite_count']) {
    page.reimbursementModesChange({ detail: { value: [mode] } })
    assert.equal(page.data.settings.staffSupplies.reimbursementMode, mode)
  }
  page.reimbursementModesChange({ detail: { value: [] } })
  page.save()
  assert.equal(calls.length, 0)
  assert.match(errors[0], /至少选择一种报销资格方式/)
})

test('settings rejects invalid reimbursement thresholds before submitting', () => {
  for (const field of ['reimbursementOrderCount', 'reimbursementInviteCount']) {
    for (const value of ['', ' ', 'invalid', '-1', '1.5', 'Infinity', null, true, Number.MAX_SAFE_INTEGER + 1]) {
      const { page, calls, errors } = settingsPage()
      page.reimbursementModesChange({ detail: { value: ['order_count', 'invite_count'] } })
      page.data.settings.staffSupplies[field] = value
      page.save()
      assert.equal(calls.length, 0, `${field}=${JSON.stringify(value)} must not be submitted`)
      assert.match(errors[0], /非负整数/)
    }
  }
})

test('settings accepts explicit zero and nonnegative integer input strings', () => {
  const { page, calls, errors } = settingsPage()
  page.reimbursementModesChange({ detail: { value: ['order_count', 'invite_count'] } })
  page.data.settings.staffSupplies.reimbursementOrderCount = '5'
  page.data.settings.staffSupplies.reimbursementInviteCount = '0'
  page.save()
  assert.deepEqual(errors, [])
  assert.equal(calls.length, 1)
})
