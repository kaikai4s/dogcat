const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const pagePath = path.resolve(__dirname, '../../miniprogram/pages/admin/mall/orders/index')
const template = fs.readFileSync(pagePath + '.wxml', 'utf8')

function fixture() {
  let page
  const calls = [], toasts = [], confirmations = [], errors = []
  vm.runInNewContext(fs.readFileSync(pagePath + '.js', 'utf8'), {
    Page(value) { page = value },
    require(name) {
      if (name.endsWith('/cloud')) return {
        callFunction: (...args) => { calls.push(args); return Promise.resolve({}) },
        showError: error => errors.push(error)
      }
      return {}
    },
    wx: {
      showToast: options => toasts.push(options),
      showModal: options => confirmations.push(options)
    }
  })
  page.setData = patch => Object.assign(page.data, patch)
  page.load = () => {}
  page.data.orders = [{ _id: 'mall-1', orderNo: 'MALL001', payAmount: 100, maxRefundable: 80 }]
  page.openManualRefundModal({ currentTarget: { dataset: { id: 'mall-1' } } })
  function input(binding, value) {
    const element = [...template.matchAll(/<input\b[^>]*>/g)].map(match => match[0])
      .find(tag => tag.includes(`value="{{${binding}}}"`))
    assert.ok(element, `Missing input for ${binding}`)
    const field = element.match(/data-field="([^"]+)"/)[1]
    const handler = element.match(/bindinput="([^"]+)"/)[1]
    page[handler]({ currentTarget: { dataset: { field } }, detail: { value } })
  }
  return { page, calls, toasts, confirmations, errors, input }
}

test('manual mall refund submits the entered partial amount and reason from the rendered inputs', async () => {
  const { page, calls, confirmations, errors, input } = fixture()
  input('manualRefundAmount', '25.50')
  input('manualRefundReason', '  商品破损，协商部分退款  ')
  page.submitManualRefund()
  assert.equal(confirmations.length, 1)
  assert.match(confirmations[0].content, /25\.50/)
  assert.equal(calls.length, 0, 'No refund before confirmation')
  confirmations[0].success({ confirm: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'adminMall')
  assert.equal(calls[0][1], 'refundOrder')
  assert.equal(calls[0][2].orderId, 'mall-1')
  assert.equal(calls[0][2].refundAmount, 25.5)
  assert.equal(calls[0][2].reason, '商品破损，协商部分退款')
  assert.equal(errors.length, 0)
  assert.equal(page.data.showManualRefundModal, false)
})

test('blank manual refund reason and an entered amount exceeding the balance remain blocked', () => {
  const { page, calls, toasts, confirmations, input } = fixture()
  input('manualRefundReason', '   ')
  page.submitManualRefund()
  assert.equal(toasts.at(-1).title, '请填写退款说明')
  input('manualRefundReason', '协商退款')
  input('manualRefundAmount', '80.01')
  page.submitManualRefund()
  assert.match(toasts.at(-1).title, /不能超过最大可退/)
  assert.equal(confirmations.length, 0)
  assert.equal(calls.length, 0)
})

test('cancelling refund confirmation retains the entered form without calling the refund API', () => {
  const { page, calls, confirmations, input } = fixture()
  input('manualRefundReason', '协商退款')
  input('manualRefundAmount', '20')
  page.submitManualRefund()
  confirmations[0].success({ confirm: false })
  assert.equal(calls.length, 0)
  assert.equal(page.data.manualRefundAmount, '20')
  assert.equal(page.data.manualRefundReason, '协商退款')
})
