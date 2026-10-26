const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function pageWith(callFunction) {
  let page, modal
  const toasts = []
  const storage = new Map()
  const wx = {
    showModal(options) { modal = options }, showToast(options) { toasts.push(options) }, showLoading() {}, hideLoading() {},
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key)
  }
  const decorate = vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/admin/finance/index.js'), 'utf8') + '\n;decorate', {
    wx, Page(value) { page = value }, require(name) {
      if (name.endsWith('/adminAccess')) return require('../../miniprogram/utils/adminAccess')
      if (name.endsWith('/admin-page-read')) return require('../../miniprogram/pages/admin/utils/admin-page-read')
      if (name.endsWith('/image-upload')) return { uploadImage: () => { throw new Error('未模拟图片上传') } }
      if (name.endsWith('/cloud')) return { callFunction, showError() {} }
      if (name.endsWith('/nav')) return { createPageNav() {}, navMethods() { return {} } }
      if (name.endsWith('/format')) return require('../../miniprogram/utils/format')
      throw new Error(`Unexpected dependency ${name}`)
    }
  })
  page.setData = patch => Object.assign(page.data, patch)
  page.loadStaffFinance = () => {}
  page.load = () => {}
  return { page, modal: () => modal, storage, toasts, decorate }
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
  harness.page.markPaid({ currentTarget: { dataset: { id: 'w' } } })
  harness.modal().success({ confirm: true, content: '' })
  assert.equal(calls.length, 2)
  harness.modal().success({ confirm: true, content: 'bank-003' })
  await tick()
  assert.equal(calls[2][1], 'markWithdrawPaid')
  assert.equal(calls[2][2].paymentReference, 'bank-003')
})

test('forfeiture retries reuse stored request ID after an ambiguous network failure', async () => {
  const calls = []
  const harness = pageWith(async (...args) => { calls.push(args); throw new Error('network timeout') })
  const event = { currentTarget: { dataset: { id: 'd', max: 500 } } }
  harness.page.forfeitDeposit(event)
  harness.page.inputForfeitAmount({ detail: { value: '100' } })
  harness.page.inputForfeitReason({ detail: { value: '违规核实' } })
  harness.page.submitForfeitDeposit()
  await tick()
  harness.page.forfeitDeposit(event)
  harness.page.inputForfeitAmount({ detail: { value: '100' } })
  harness.page.inputForfeitReason({ detail: { value: '违规核实' } })
  harness.page.submitForfeitDeposit()
  await tick()
  assert.equal(calls.length, 2)
  assert.ok(calls[0][2].clientRequestId)
  assert.equal(calls[0][2].clientRequestId, calls[1][2].clientRequestId)
  assert.equal(harness.page.data.forfeiting, false)
})

test('deposit approval explains automatic original-payment refund and reports unresolved gateway errors', async () => {
  const calls = []
  const harness = pageWith(async (...args) => {
    calls.push(args)
    return { status: 'refund_approved', refundStatus: 'approved', refundLastError: '微信退款功能尚未启用' }
  })
  harness.page.auditDepositRefund({ currentTarget: { dataset: { id: 'd', approved: true } } })
  assert.match(harness.modal().content, /自动原路退回/)
  harness.modal().success({ confirm: true })
  await tick()
  assert.equal(calls[0][1], 'auditDepositRefund')
  assert.equal(harness.modal().content, '微信退款功能尚未启用')
})

test('historical approved deposits can synchronize and start their original refund from finance', async () => {
  const calls = []
  const harness = pageWith(async (...args) => { calls.push(args); return { refundStatus: 'processing' } })
  await harness.page.syncDepositRefund({ currentTarget: { dataset: { id: 'd' } } })
  assert.equal(calls[0][1], 'syncDepositRefund')
  assert.equal(calls[0][2].id, 'd')
  assert.equal(harness.page.data.actionBusy, false)
})

test('retry shows the gateway refusal and code instead of a generic pending result', async () => {
  const harness = pageWith(async () => ({ status: 'transferring', transferStatus: 'unknown',
    lastTransferError: '超过单笔转账上下限，核实产品设置是否准确', lastTransferErrorCode: 'INVALID_REQUEST' }))
  harness.page.runWithdrawTransferAction('w', 'retryWithdrawTransfer', '正在重试...')
  await tick()
  assert.match(harness.modal().content, /超过单笔转账上下限/)
  assert.match(harness.modal().content, /INVALID_REQUEST/)
  assert.equal(harness.toasts.length, 0)
  assert.equal(harness.page.data.actionBusy, false)
})

test('confirmation guidance is shown only for an actual WAIT_USER_CONFIRM reply', async () => {
  const harness = pageWith(async () => ({ status: 'transferring', transferStatus: 'processing', wechatTransferState: 'WAIT_USER_CONFIRM' }))
  harness.page.queryWithdrawTransfer({ currentTarget: { dataset: { id: 'w' } } })
  await tick()
  assert.equal(harness.modal().title, '待收款人确认收款')
  assert.match(harness.modal().content, /我的收益.*提现记录/)
})

test('small history requests offer returning balance and suppress resubmission', async () => {
  const harness = pageWith(async () => ({}))
  const row = harness.decorate({ amount: 0.07, payoutChannel: 'wechat_wallet', status: 'transferring', transferStatus: 'unknown', wechatTransferState: 'WAIT_USER_CONFIRM' })
  assert.equal(row.belowWechatMinimum, true)
  assert.equal(row.canReturnSmallTransfer, true)
  assert.equal(row.canRecoverTransfer, false)
  assert.equal(row.transferStatusText, '待查询确认')
})

test('returning a historical small withdrawal explains original query and reports restored balance', async () => {
  const calls = []
  const harness = pageWith(async (...args) => { calls.push(args); return { status: 'rejected', transferStatus: 'released' } })
  harness.page.releaseFailedWithdraw({ currentTarget: { dataset: { id: 'w', small: true } } })
  assert.match(harness.modal().content, /原商户查询原单/)
  assert.match(harness.modal().content, /0.10/)
  harness.modal().success({ confirm: true })
  await tick()
  assert.equal(calls[0][1], 'releaseFailedWithdraw')
  assert.equal(calls[0][2].id, 'w')
  assert.equal(harness.toasts[0].title, '已退回可提现余额')
})

test('manual tail payment displays recipient and exact amount and requires actual reference entry', async () => {
  const calls = []
  const harness = pageWith(async (...args) => { calls.push(args); return { status: 'paid' } })
  harness.page.data.requests = [{ _id: 'tail', source: 'admin_manual_tail_settlement', amount: 0.07, recipientName: '小李', status: 'approved' }]
  harness.page.markPaid({ currentTarget: { dataset: { id: 'tail' } } })
  assert.equal(harness.modal().title, '确认小额尾款已付款')
  assert.match(harness.modal().content, /小李.*0.07/)
  harness.modal().success({ confirm: true, content: '' })
  assert.equal(calls.length, 0)
  harness.modal().success({ confirm: true, content: 'SYNTHETIC-BANK-001' })
  await tick()
  assert.equal(calls[0][1], 'markWithdrawPaid')
  assert.equal(calls[0][2].paymentConfirmed, true)
  assert.equal(calls[0][2].paymentReference, 'SYNTHETIC-BANK-001')
})

test('manual tail list and history show manual payment states rather than pending WeChat submission', () => {
  const h = pageWith(async () => ({}))
  const row = h.decorate({ payoutChannel: 'manual', source: 'admin_manual_tail_settlement', status: 'approved', amount: 0.07,
    withdrawHistory: [{ payoutChannel: 'manual', source: 'admin_manual_tail_settlement', status: 'paid', amount: 0.07 }] })
  assert.equal(row.statusText, '待人工付款')
  assert.equal(row.withdrawHistory[0].statusText, '已人工结清')
  assert.equal(row.canRecoverTransfer, false)
  assert.equal(row.canReturnSmallTransfer, false)
})
