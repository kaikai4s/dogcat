const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const flush = () => new Promise(resolve => setImmediate(resolve))

function fixture(orderPatch = {}, apiResult = {}, upload = async () => ({ fileID: 'cloud://proof' })) {
  let page
  const calls = [], modals = [], toasts = [], errors = [], uploads = []
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/admin/orders/detail/index.js'), 'utf8'), {
    Page: config => { page = config }, console, Date, setTimeout, clearTimeout,
    require(name) {
      if (name.endsWith('/cloud')) return {
        getCloudEnv: () => 'test-env', showError: error => errors.push(error),
        callFunction: async (...args) => { calls.push(args); return apiResult }
      }
      if (name.endsWith('/image-upload')) return { uploadImage: async options => { uploads.push(options); return upload(options) } }
      if (name.endsWith('/format')) return require('../../miniprogram/utils/format')
      if (name.endsWith('/nav')) return { navMethods: () => ({}), createPageNav: () => ({}) }
      return {}
    },
    wx: { showModal: modal => modals.push(modal), showToast: toast => toasts.push(toast) }
  })
  page.setData = patch => Object.assign(page.data, patch)
  page.load = () => {}
  page.data.id = 'order'
  page.data.detail = { order: { payAmount: 100, standardStaffReward: 70, ...orderPatch } }
  page.openManualCompleteModal()
  page.data.manualCompleteRemarkInput = '已核实全部服务'
  return { page, calls, modals, toasts, errors, uploads }
}

test('manual completion preview accounts for refunds and keeps cent precision for every input path', () => {
  const f = fixture({ refundedAmount: 40 })
  assert.equal(f.page.data.computedFinalReward, '42.00')
  f.page.inputManualDeductAmount({ detail: { value: '20' } })
  assert.equal(f.page.data.computedFinalReward, '22.00')
  f.page.quickSetDeduct({ currentTarget: { dataset: { type: 'half' } } })
  assert.equal(f.page.data.computedFinalReward, '7.00')
  f.page.quickSetDeduct({ currentTarget: { dataset: { type: 'all' } } })
  assert.equal(f.page.data.computedFinalReward, '0.00')
  f.page.inputManualDeductAmount({ detail: { value: '20' } })
  f.page.submitManualComplete()
  assert.match(f.modals[0].content, /预计收益：¥22.00/)
})

for (const input of ['-1', '0.005', 'invalid', 'Infinity']) {
  test(`invalid manual deduction ${input} never opens a confirmation or invokes completion`, () => {
    const f = fixture()
    f.page.data.manualDeductAmountInput = input
    f.page.submitManualComplete()
    assert.equal(f.modals.length, 0)
    assert.equal(f.calls.length, 0)
    assert.match(f.toasts[0].title, /两位小数/)
  })
}

test('manual completion uploads temporary evidence and shows group waiting without claiming settlement', async () => {
  const f = fixture({ groupBuyId: 'group', paymentStatus: 'refunding' }, { partialGroupCompleted: true, status: 'day_completed' })
  f.page.data.manualCompleteImages = ['wxfile://temporary-proof.jpg', 'cloud://existing']
  f.page.submitManualComplete()
  assert.match(f.modals[0].content, /等待同团住户完成再统一结算/)
  assert.match(f.modals[0].content, /暂不可提现/)
  f.modals[0].success({ confirm: true })
  assert.equal(f.page.data.submittingManualComplete, true)
  f.page.submitManualComplete()
  assert.equal(f.modals.length, 1)
  await flush()
  assert.equal(f.uploads.length, 1)
  assert.equal(f.uploads[0].config.env, 'test-env')
  assert.deepEqual(Array.from(f.calls[0][2].evidenceImages), ['cloud://proof', 'cloud://existing'])
  assert.match(f.toasts.at(-1).title, /待拼单统一结算/)
  assert.equal(f.page.data.submittingManualComplete, false)
})

test('failed proof upload keeps the modal open and never submits a temporary file to completion', async () => {
  const f = fixture({}, {}, async () => { throw new Error('upload unavailable') })
  f.page.data.manualCompleteImages = ['wxfile://temporary.jpg']
  f.page.submitManualComplete()
  f.modals[0].success({ confirm: true })
  await flush()
  assert.equal(f.calls.length, 0)
  assert.equal(f.errors[0].message, 'upload unavailable')
  assert.equal(f.page.data.showManualCompleteModal, true)
  assert.equal(f.page.data.submittingManualComplete, false)
})
