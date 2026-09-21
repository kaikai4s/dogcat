const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function pageWith(callFunction) {
  let page, modal
  const storage = new Map()
  const wx = {
    showModal(options) { modal = options }, showToast() {}, showLoading() {}, hideLoading() {},
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key)
  }
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/admin/finance/index.js'), 'utf8'), {
    wx, Page(value) { page = value }, require(name) {
      if (name.endsWith('/cloud')) return { callFunction, showError() {} }
      if (name.endsWith('/nav')) return { createPageNav() {}, navMethods() { return {} } }
      throw new Error(`Unexpected dependency ${name}`)
    }
  })
  page.setData = patch => Object.assign(page.data, patch)
  page.loadStaffFinance = () => {}
  return { page, modal: () => modal, storage }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('manual confirmations require evidence and send explicit payment confirmation', async () => {
  const calls = []
  const harness = pageWith(async (...args) => { calls.push(args) })
  harness.page.confirmDepositRefund({ currentTarget: { dataset: { id: 'd' } } })
  harness.modal().success({ confirm: true, content: '' })
  assert.equal(calls.length, 0)
  harness.modal().success({ confirm: true, content: ' bank-001 ' })
  await tick()
  assert.equal(calls[0][1], 'confirmDepositRefund')
  assert.equal(calls[0][2].paymentReference, 'bank-001')
  assert.equal(calls[0][2].paymentConfirmed, true)
  assert.equal(harness.page.data.actionBusy, false)
  harness.page.paySupplyReimbursement({ currentTarget: { dataset: { id: 's' } } })
  harness.modal().success({ confirm: true, content: 'bank-002' })
  await tick()
  assert.equal(calls[1][1], 'paySupplyReimbursement')
})

test('forfeiture retries reuse stored request ID after an ambiguous network failure', async () => {
  const calls = []
  const harness = pageWith(async (...args) => { calls.push(args); throw new Error('network timeout') })
  const event = { currentTarget: { dataset: { id: 'd', max: 500 } } }
  harness.page.forfeitDeposit(event)
  harness.modal().success({ confirm: true, content: '100|违规核实' })
  await tick()
  harness.page.forfeitDeposit(event)
  harness.modal().success({ confirm: true, content: '100|违规核实' })
  await tick()
  assert.equal(calls.length, 2)
  assert.ok(calls[0][2].clientRequestId)
  assert.equal(calls[0][2].clientRequestId, calls[1][2].clientRequestId)
  assert.equal(harness.page.data.actionBusy, false)
})
