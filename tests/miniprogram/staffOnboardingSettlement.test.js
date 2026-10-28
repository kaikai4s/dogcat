const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

function harness(route, callFunction) {
  let page
  const storage = new Map(), errors = [], toasts = [], modals = [], navigations = []
  const wx = {
    showModal(options) { modals.push(options); if (options.success) options.success({ confirm: true }) },
    showToast(options) { toasts.push(options) }, showLoading() {}, hideLoading() {},
    requestPayment(options) { options.success({}) },
    navigateTo(options) { navigations.push(options.url) },
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, structuredClone(value)), removeStorageSync: key => storage.delete(key)
  }
  const source = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages', route, 'index.js'), 'utf8')
  const helpers = vm.runInNewContext(source + '\n;typeof withWithdraw === "function" ? { withWithdraw } : {}', { wx, Page(value) { page = value }, setTimeout(callback) { callback(); return 0 },
    require(name) {
      if (name.endsWith('/cloud')) return { callFunction, showError: error => errors.push(error) }
      if (name.endsWith('/format')) return { withStaffWorkflowText: value => value, formatDateTime: value => value }
      if (name.endsWith('/theme')) return { applyTheme: () => ({ value: 'day' }), getThemeState: () => ({}) }
      if (name.endsWith('/clipboard')) return { copyText() {} }
      if (name.endsWith('/admin-page-read')) return { optionalAdminRead() {} }
      if (name.endsWith('/image-upload')) return { uploadImage() {} }
      if (name.endsWith('/envList')) return { getActiveEnvId: () => 'test-env' }
      if (name.endsWith('/nav')) return { navMethods: () => ({}) }
      if (name.endsWith('/offlineQueue')) return { createClientRequestId: () => 'synthetic-client-request' }
      throw new Error(`Unexpected dependency: ${name}`)
    }
  })
  page.setData = (patch, callback) => { Object.assign(page.data, patch); if (callback) callback() }
  const originalLoad = page.load
  page.load = () => {}
  return { page, originalLoad, wx, storage, errors, toasts, modals, navigations, helpers }
}

test('training quiz stays closed while locked and toggles after videos complete', () => {
  const { page } = harness('staff/training', async () => {})
  page.data.quiz = { unlocked: false }
  page.toggleQuiz()
  assert.equal(page.data.quizExpanded, false)
  page.data.quiz.unlocked = true
  page.toggleQuiz()
  assert.equal(page.data.quizExpanded, true)
  page.toggleQuiz()
  assert.equal(page.data.quizExpanded, false)
})

test('successful deposit payment retries status query until confirmed and releases busy state', async () => {
  let queries = 0
  const h = harness('staff/training', async (_, action) => {
    if (action === 'createDepositPayment') return { paid: false, payParams: { package: 'prepay_id=TEST' } }
    if (action === 'getDepositStatus') return { deposit: { status: ++queries === 1 ? 'unpaid' : 'paid' }, canPay: queries === 1 }
    throw new Error(action)
  })
  Object.assign(h.page.data, { depositState: { canPay: true }, depositAgreed: true })
  await h.page.payDeposit()
  h.page.agreeDeposit({ detail: { value: ['agreed'] } })
  await h.page.continueDepositRules()
  assert.equal(queries, 2)
  assert.equal(h.page.data.depositState.deposit.status, 'paid')
  assert.equal(h.page.data.depositBusy, false)
  assert.ok(h.toasts.some(toast => toast.title === '保证金已缴纳'))
})

test('ambiguous deposit query does not display payment success', async () => {
  const h = harness('staff/training', async (_, action) => action === 'createDepositPayment'
    ? { paid: true } : { deposit: { status: 'unpaid' }, paymentSyncPending: true })
  Object.assign(h.page.data, { depositState: { canPay: true }, depositAgreed: true })
  await h.page.payDeposit()
  h.page.agreeDeposit({ detail: { value: ['agreed'] } })
  await h.page.continueDepositRules()
  assert.equal(h.page.data.depositBusy, false)
  assert.ok(h.toasts.some(toast => toast.title.includes('结果确认中')))
  assert.ok(!h.toasts.some(toast => toast.title === '保证金已缴纳'))
})

test('deposit checkout creates payment only after rules consent and a complete confirmed address', async () => {
  const calls = []
  const h = harness('staff/training', async (_, action, data) => {
    calls.push({ action, data })
    if (action === 'createDepositPayment') return { paid: true }
    if (action === 'getDepositStatus') return { deposit: { status: 'paid' } }
    throw new Error(action)
  })
  h.page.data.depositState = { canPay: true, supplyDeliveryRequired: true, config: { amount: 500 }, supplies: { supplyFeeAmount: 120 } }
  await h.page.payDeposit()
  assert.equal(h.page.data.depositModal, 'rules')
  assert.equal(calls.length, 0)
  await h.page.continueDepositRules()
  assert.equal(h.page.data.depositModal, 'rules')
  h.page.agreeDeposit({ detail: { value: ['agreed'] } })
  h.page.agreeSupply({ detail: { value: ['agreed'] } })
  await h.page.continueDepositRules()
  assert.equal(h.page.data.depositModal, 'address')
  assert.equal(calls.length, 0)
  await h.page.confirmAddressAndPay()
  assert.equal(calls.length, 0)
  h.page.data.supplyAddress = { name: '测试收件人', phone: '13900001111', province: '上海市', city: '上海市', district: '浦东新区', detail: '测试路 18 号' }
  await h.page.confirmAddressAndPay()
  const payments = calls.filter(call => call.action === 'createDepositPayment')
  assert.equal(payments.length, 1)
  assert.equal(payments[0].data.acceptSupplyPolicy, true)
  assert.equal(payments[0].data.supplyAddress.detail, '测试路 18 号')
})

test('closing deposit consent leaves payment uncreated and reopening requires consent again', async () => {
  const h = harness('staff/training', async () => assert.fail('No payment should be created before checkout completes'))
  h.page.data.depositState = { canPay: true, supplyDeliveryRequired: true }
  await h.page.payDeposit()
  h.page.agreeDeposit({ detail: { value: ['agreed'] } })
  h.page.agreeSupply({ detail: { value: ['agreed'] } })
  h.page.closeDepositModal()
  assert.equal(h.page.data.depositModal, '')
  await h.page.payDeposit()
  assert.equal(h.page.data.depositAgreed, false)
  assert.equal(h.page.data.supplyAgreed, false)
})

test('admin deposit refund reviews supply status and submits the reviewed net amount for audit', async () => {
  const calls = []
  const preview = { id: 'dep', availableRefundAmount: 500, supplyFeeAmount: 120, supplyFeeDue: 120,
    supplyFeeDeductedAmount: 0, estimatedRefundAmount: 380, reimbursementStatus: 'not_applied',
    reimbursementStatusText: '未申请报销，需扣用品费', blocked: false }
  const h = harness('admin/sitters/list', async (_, action, data) => {
    calls.push({ action, data })
    if (action === 'getStaffDepositRefundPreview') return preview
    if (action === 'requestStaffDepositRefund') return { success: true }
    throw new Error(action)
  })
  await h.page.refundDeposit({ currentTarget: { dataset: { item: { depositId: 'dep', realName: '测试宠托师' } } } })
  assert.equal(h.page.data.showDepositRefundModal, true)
  assert.equal(h.page.data.depositRefundPreview.estimatedRefundAmountText, '380.00')
  assert.equal(calls.length, 1)
  h.page.inputDepositRefundReason({ detail: { value: '退出服务' } })
  await h.page.submitDepositRefund()
  assert.deepEqual(calls.map(call => call.action), ['getStaffDepositRefundPreview', 'getStaffDepositRefundPreview', 'requestStaffDepositRefund'])
  assert.equal(h.page.data.showDepositRefundModal, false)
})

test('admin refund waits for pending reimbursement and asks for review again when the preview changes', async () => {
  let preview = { id: 'dep', availableRefundAmount: 500, supplyFeeDue: 120, estimatedRefundAmount: null,
    reimbursementStatus: 'pending', blocked: true, blockedReason: '请先审核首次用品报销' }
  let requests = 0
  const h = harness('admin/sitters/list', async (_, action) => {
    if (action === 'getStaffDepositRefundPreview') return preview
    requests += 1
  })
  const event = { currentTarget: { dataset: { item: { depositId: 'dep' } } } }
  await h.page.refundDeposit(event)
  h.page.data.depositRefundReason = '退出服务'
  await h.page.submitDepositRefund()
  assert.equal(requests, 0)
  preview = { ...preview, blocked: false, estimatedRefundAmount: 380, reimbursementStatus: 'not_applied' }
  await h.page.refundDeposit(event)
  h.page.data.depositRefundReason = '退出服务'
  preview = { ...preview, supplyFeeDue: 0, estimatedRefundAmount: 500, reimbursementStatus: 'approved' }
  await h.page.submitDepositRefund()
  assert.equal(requests, 0)
  assert.equal(h.page.data.depositRefundPreview.estimatedRefundAmountText, '500.00')
  assert.match(h.page.data.depositRefundError, /重新提交/)
})

test('cancelled payment keeps consent, address draft, and checkout ready for retry', async () => {
  const address = { name: '测试收件人', phone: '13900001111', province: '上海市', city: '上海市', district: '浦东新区', detail: '测试路18号' }
  const state = { canPay: true, supplyDeliveryRequired: true, checkoutPolicyKey: 'rules-v1', config: { amount: 500 }, deposit: { status: 'unpaid' } }
  let payments = 0
  const h = harness('staff/training', async (_, action) => {
    if (action === 'createDepositPayment') { payments++; return { payParams: { package: 'prepay_id=TEST' } } }
    if (action === 'getDepositStatus') return state
    throw new Error(action)
  })
  h.wx.requestPayment = options => options.fail({ errMsg: 'requestPayment:fail cancel' })
  Object.assign(h.page.data, { depositState: state, supplyAddress: address })
  await h.page.payDeposit()
  h.page.agreeDeposit({ detail: { value: ['agreed'] } })
  h.page.agreeSupply({ detail: { value: ['agreed'] } })
  await h.page.continueDepositRules()
  await h.page.confirmAddressAndPay()
  assert.equal(payments, 1)
  assert.equal(h.page.data.depositModal, 'address')
  assert.equal(h.page.data.depositAgreed, true)
  assert.equal(h.page.data.supplyAddress.detail, address.detail)
  assert.match(h.page.data.checkoutError, /已取消支付/)
  assert.equal(h.page.data.depositBusy, false)
})

test('changed deposit rules return checkout to consent while retaining the address draft', async () => {
  const h = harness('staff/training', async () => ({ canPay: true, checkoutPolicyKey: 'rules-v2', deposit: { status: 'unpaid' }, supplyDeliveryRequired: true }))
  Object.assign(h.page.data, { depositState: { canPay: true, checkoutPolicyKey: 'rules-v1' }, depositModal: 'address', depositAgreed: true, supplyAgreed: true })
  h.page.supplyAddressInput({ currentTarget: { dataset: { field: 'detail' } }, detail: { value: '尚未提交的门牌号' } })
  await h.page.loadDeposit({ preserveCheckout: true })
  assert.equal(h.page.data.depositModal, 'rules')
  assert.equal(h.page.data.depositAgreed, false)
  assert.equal(h.page.data.supplyAgreed, false)
  assert.equal(h.page.data.supplyAddress.detail, '尚未提交的门牌号')
  assert.match(h.page.data.checkoutError, /规则已更新/)
})

test('uncertain checkout status requires refresh and retains the draft', async () => {
  const h = harness('staff/training', async () => { throw new Error('network timeout') })
  Object.assign(h.page.data, { depositState: { canPay: true }, depositModal: 'address', depositAgreed: true, supplyAgreed: true })
  await h.page.loadDeposit({ preserveCheckout: true })
  assert.equal(h.page.data.depositModal, 'address')
  assert.equal(h.page.data.checkoutNeedsRefresh, true)
  assert.equal(h.page.data.depositLoading, false)
  await h.page.confirmAddressAndPay()
  assert.equal(h.page.data.depositBusy, false)
})

test('a changed policy response cannot reopen checkout after the user closes it', async () => {
  let complete
  const h = harness('staff/training', () => new Promise(resolve => { complete = resolve }))
  Object.assign(h.page.data, { depositState: { canPay: true, checkoutPolicyKey: 'rules-v1' }, depositModal: 'address' })
  const pending = h.page.loadDeposit({ preserveCheckout: true })
  h.page.closeDepositModal()
  complete({ canPay: true, checkoutPolicyKey: 'rules-v2', deposit: { status: 'unpaid' } })
  await pending
  assert.equal(h.page.data.depositModal, '')
  assert.equal(h.page.data.depositLoading, false)
})

test('leaving checkout while payment is being created does not open the cashier afterward', async () => {
  let complete, cashierCalls = 0
  const calls = []
  const h = harness('staff/training', (_, action) => {
    calls.push(action)
    return new Promise(resolve => { complete = resolve })
  })
  h.wx.requestPayment = options => { cashierCalls++; options.success({}) }
  Object.assign(h.page.data, { depositState: { canPay: true }, depositModal: 'rules', depositAgreed: true })
  const pending = h.page.continueDepositRules()
  h.page.onUnload()
  complete({ payParams: { package: 'prepay_id=TEST' } })
  await pending
  assert.equal(cashierCalls, 0)
  assert.equal(h.toasts.length, 0)
  assert.deepEqual(calls, ['createDepositPayment'])
})

test('address validation highlights each invalid field and region picker updates all region fields', () => {
  const h = harness('staff/training', async () => {})
  assert.equal(h.page.validateSupplyAddress(), false)
  assert.deepEqual(Object.keys(h.page.data.supplyAddressErrors), ['name', 'phone', 'region', 'detail'])
  h.page.supplyRegionChange({ detail: { value: ['上海市', '上海市', '浦东新区'] } })
  assert.equal(h.page.data.supplyAddress.city, '上海市')
  assert.equal(h.page.data.supplyAddressErrors.region, undefined)
})

test('refund preview refresh preserves the reason and late responses cannot reopen a closed dialog', async () => {
  let complete
  const h = harness('admin/sitters/list', async () => new Promise(resolve => { complete = resolve }))
  const pending = h.page.refundDeposit({ currentTarget: { dataset: { item: { depositId: 'dep' } } } })
  assert.equal(h.page.data.showDepositRefundModal, true)
  assert.equal(h.page.data.depositRefundPreviewLoading, true)
  h.page.data.depositRefundReason = '已填写的退还原因'
  h.page.closeDepositRefundModal()
  complete({ id: 'dep', estimatedRefundAmount: 500 })
  await pending
  assert.equal(h.page.data.showDepositRefundModal, false)
  assert.equal(h.page.data.depositRefundPreviewLoading, false)
  assert.equal(h.page.data.depositRefundReason, '已填写的退还原因')
  assert.equal(h.page.data.depositRefundPreview, null)
})

test('refund dialog refreshes a completed reimbursement without erasing the typed reason', async () => {
  let preview = { id: 'dep', blocked: true, reimbursementStatus: 'pending', estimatedRefundAmount: null, canRequestRefund: false }
  const h = harness('admin/sitters/list', async () => preview)
  await h.page.refundDeposit({ currentTarget: { dataset: { item: { depositId: 'dep' } } } })
  h.page.data.depositRefundReason = '退出服务'
  preview = { ...preview, blocked: false, reimbursementStatus: 'approved', estimatedRefundAmount: 500, canRequestRefund: true }
  await h.page.refreshDepositRefundPreview()
  assert.equal(h.page.data.depositRefundReason, '退出服务')
  assert.equal(h.page.data.depositRefundPreview.estimatedRefundAmountText, '500.00')
})

test('refund submission ignores its result after leaving the admin page', async () => {
  let complete
  const preview = { id: 'dep', estimatedRefundAmount: 380, reimbursementStatus: 'not_applied', canRequestRefund: true }
  const h = harness('admin/sitters/list', async (_, action) => action === 'getStaffDepositRefundPreview'
    ? preview : new Promise(resolve => { complete = resolve }))
  Object.assign(h.page.data, { showDepositRefundModal: true, depositRefundPreview: preview,
    depositRefundStaff: { depositId: 'dep' }, depositRefundReason: '退出服务' })
  const pending = h.page.submitDepositRefund()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(typeof complete, 'function')
  h.page.onUnload()
  h.page.setData = () => { throw new Error('unloaded page must not update UI') }
  complete({ success: true })
  await pending
  assert.equal(h.toasts.length, 0)
})

test('admin settlement resumes original operation after timeout without a second approval or a new bill', async () => {
  const calls = []
  let attempts = 0
  const h = harness('admin/sitters/list', async (_, action, data) => {
    calls.push({ action, data })
    if (action === 'getStaffSettlementPreview') return { canSettle: true, staffName: '小李', available: 10, pending: 2, frozen: 3, withdrawing: 4, batchCount: 1 }
    if (++attempts === 1) throw new Error('network timeout')
    return { status: 'transferring', hasMore: false }
  })
  const event = { currentTarget: { dataset: { id: 'sp' } } }
  await h.page.settleEarnings(event)
  assert.equal(h.storage.size, 1)
  await h.page.settleEarnings(event)
  const transfers = calls.filter(call => call.action === 'settleStaffEarningsByWechat')
  assert.equal(transfers.length, 2)
  assert.equal(transfers[0].data.clientRequestId, transfers[1].data.clientRequestId)
  assert.equal(transfers[0].data.batchIndex, transfers[1].data.batchIndex)
  assert.equal(h.storage.size, 0)
  assert.equal(h.page.data.settlementBusy, false)
  assert.equal(h.modals.filter(modal => modal.confirmText === '确认转账').length, 1)
  assert.ok(h.modals.some(modal => modal.title === '结清转账已发起'))
})

test('admin settlement sends every planned batch with a single operation ID', async () => {
  const batches = []
  const h = harness('admin/sitters/list', async (_, action, data) => {
    if (action === 'getStaffSettlementPreview') return { canSettle: true, staffName: '小李', available: 280, pending: 0, frozen: 0, withdrawing: 0, batchCount: 2 }
    batches.push(data)
    return { status: 'transferring', hasMore: data.batchIndex === 0 }
  })
  await h.page.settleEarnings({ currentTarget: { dataset: { id: 'sp' } } })
  assert.deepEqual(batches.map(batch => batch.batchIndex), [0, 1])
  assert.equal(batches[0].clientRequestId, batches[1].clientRequestId)
  assert.equal(batches[0].expectedAmount, 280)
})

test('a refused batch displays its actual error and stops before the next transfer batch', async () => {
  const batches = []
  const h = harness('admin/sitters/list', async (_, action, data) => {
    if (action === 'getStaffSettlementPreview') return { canSettle: true, staffName: '小李', available: 280, pending: 0, frozen: 0, withdrawing: 0, batchCount: 2 }
    batches.push(data)
    return { status: 'transferring', transferStatus: 'unknown', needsHandling: true, hasMore: true,
      lastTransferError: '超过单笔转账上下限', lastTransferErrorCode: 'INVALID_REQUEST' }
  })
  await h.page.settleEarnings({ currentTarget: { dataset: { id: 'sp' } } })
  assert.equal(batches.length, 1)
  assert.equal(h.storage.size, 1)
  assert.equal([...h.storage.values()][0].batchIndex, 0)
  assert.match(h.errors[0].message, /超过单笔转账上下限.*INVALID_REQUEST/)
  assert.ok(!h.modals.some(modal => modal.title === '结清转账已发起'))
})

test('manual tail generation reviews the amount and sends pending settlement to finance', async () => {
  const calls = []
  const h = harness('admin/sitters/list', async (_, action, data) => {
    calls.push({ action, data })
    if (action === 'getStaffSettlementPreview') return { canSettleManualTail: true, staffName: '小李', available: 0.07 }
    return { status: 'pending', staffOpenid: 'staff', withdrawId: 'tail-w' }
  })
  await h.page.settleManualTail({ currentTarget: { dataset: { id: 'sp' } } })
  assert.equal(calls[1].action, 'createStaffManualTailSettlement')
  assert.equal(calls[1].data.expectedAmount, 0.07)
  assert.equal(calls[1].data.confirmed, true)
  assert.match(h.modals[0].content, /0.07/)
  assert.match(h.modals[0].content, /审核.*实际付款.*凭证/)
  assert.equal(h.navigations.length, 1)
  assert.match(h.navigations[0], /tab=withdraws&action=settlement&staffOpenid=staff/)
  assert.equal(h.page.data.settlementBusy, false)
  assert.equal(h.storage.size, 0)
  assert.ok(!h.toasts.some(toast => /已到账|已结清/.test(toast.title)))
})

test('ambiguous tail creation retries the original operation without generating another payment record', async () => {
  const calls = []
  let attempts = 0
  const h = harness('admin/sitters/list', async (_, action, data) => {
    calls.push({ action, data })
    if (action === 'getStaffSettlementPreview') return { canSettleManualTail: true, staffName: '小李', available: 0.07 }
    if (++attempts === 1) throw new Error('response lost')
    return { status: 'pending', staffOpenid: 'staff', withdrawId: 'tail-w' }
  })
  const event = { currentTarget: { dataset: { id: 'sp' } } }
  await h.page.settleManualTail(event)
  assert.equal(h.storage.size, 1)
  await h.page.settleManualTail(event)
  const creations = calls.filter(row => row.action === 'createStaffManualTailSettlement')
  assert.equal(creations[0].data.clientRequestId, creations[1].data.clientRequestId)
  assert.equal(h.modals.filter(modal => modal.confirmText === '生成结清单').length, 1)
  assert.equal(h.storage.size, 0)
})

test('a tail with other unsettled funds cannot proceed to manual payment creation', async () => {
  const calls = []
  const h = harness('admin/sitters/list', async (_, action) => {
    calls.push(action)
    return { canSettleManualTail: false, manualTailUnavailableReason: '尚有冻结收益或在途提现' }
  })
  await h.page.settleManualTail({ currentTarget: { dataset: { id: 'sp' } } })
  assert.deepEqual(calls, ['getStaffSettlementPreview'])
  assert.match(h.errors[0].message, /冻结收益/)
  assert.equal(h.storage.size, 0)
  assert.equal(h.page.data.settlementBusy, false)
})

test('resuming a rejected manual tail explains that its earnings have returned instead of requesting payment', async () => {
  const h = harness('admin/sitters/list', async () => ({ status: 'rejected', staffOpenid: 'staff', needsHandling: true }))
  h.storage.set('admin_staff_manual_tail_test-env_sp', { clientRequestId: 'same-tail', expectedAmount: 0.07 })
  await h.page.settleManualTail({ currentTarget: { dataset: { id: 'sp' } } })
  assert.equal(h.modals[0].title, '尾款单需要处理')
  assert.match(h.modals[0].content, /已驳回.*收益已退回余额/)
  assert.equal(h.storage.size, 0)
})

test('staff confirmation button is available only for an active WeChat confirmation request', () => {
  const h = harness('staff/earnings', async () => ({}))
  const waiting = { payoutChannel: 'wechat_wallet', wechatTransferState: 'WAIT_USER_CONFIRM' }
  assert.equal(h.helpers.withWithdraw({ ...waiting, status: 'transferring' }).canConfirmTransfer, true)
  assert.equal(h.helpers.withWithdraw({ ...waiting, status: 'paid' }).canConfirmTransfer, false)
  assert.equal(h.helpers.withWithdraw({ ...waiting, status: 'rejected', transferStatus: 'released' }).canConfirmTransfer, false)
  assert.equal(h.helpers.withWithdraw({ ...waiting, status: 'approved', payoutChannel: 'manual' }).canConfirmTransfer, false)
})


test('late training response cannot overwrite newer completed video progress', async () => {
  const resolves = []
  const h = harness('staff/training', () => new Promise(resolve => resolves.push(resolve)))
  h.page.load = h.originalLoad
  const first = h.page.load()
  const second = h.page.load()
  resolves[1]({ profile: {}, quiz: { unlocked: true }, videos: [{ key: 'v', watched: true }] })
  await second
  resolves[0]({ profile: {}, quiz: { unlocked: false }, videos: [{ key: 'v', watched: false }] })
  await first
  assert.equal(h.page.data.quiz.unlocked, true)
  assert.equal(h.page.data.watchedVideoCount, 1)
  assert.equal(h.page.data.videos[0].watched, true)
})

test('unloaded training page ignores its pending response', async () => {
  let resolve
  const h = harness('staff/training', () => new Promise(done => { resolve = done }))
  const pending = h.originalLoad.call(h.page)
  h.page.onUnload()
  resolve({ profile: {}, quiz: { unlocked: true }, videos: [] })
  await pending
  assert.equal(h.page.data.quiz, null)
})
