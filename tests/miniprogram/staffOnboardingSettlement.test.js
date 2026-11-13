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

test('manual redemption retries the saved operation after a timeout and locks its reviewed amount', async () => {
  const submitted = []
  const h = harness('admin/sitters/list', async (_, action, data) => {
    if (action === 'getStaffRedemptionPreview') return { enabled: true, available: 100, estimated: 120 }
    submitted.push(structuredClone(data))
    if (submitted.length === 1) throw new Error('network timeout')
    return { status: 'paid' }
  })
  h.page.data.profiles = [{ _id: 'sp', realName: '小李' }]
  const event = { currentTarget: { dataset: { id: 'sp' } } }
  await h.page.openRedemption(event)
  Object.assign(h.page.data, { redemptionAmount: '30.25', redemptionImage: 'cloud://test.bucket/proof.png', redemptionConfirmed: true })
  await h.page.submitRedemption()
  assert.equal(h.page.data.redemptionLocked, true)
  h.page.redemptionInput({ currentTarget: { dataset: { field: 'redemptionAmount' } }, detail: { value: '50' } })
  assert.equal(h.page.data.redemptionAmount, '30.25')
  h.page.closeRedemption()
  await h.page.openRedemption(event)
  await h.page.submitRedemption()
  assert.deepEqual(submitted[1], submitted[0])
  assert.equal(submitted[0].amount, 30.25)
  assert.equal(h.storage.size, 0)
  assert.equal(h.page.data.redemptionStaff, null)
})

test('a redemption result arriving after leaving the page remains available for confirmation', async () => {
  for (const rejected of [false, true]) {
    let finish
    const h = harness('admin/sitters/list', (_, action) => action === 'getStaffRedemptionPreview'
      ? Promise.resolve({ enabled: true, available: 100, estimated: 100 })
      : new Promise((resolve, reject) => { finish = rejected ? reject : resolve }))
    h.page.data.profiles = [{ _id: 'sp' }]
    await h.page.openRedemption({ currentTarget: { dataset: { id: 'sp' } } })
    Object.assign(h.page.data, { redemptionAmount: '30', redemptionImage: 'cloud://test.bucket/proof.png', redemptionConfirmed: true })
    const pending = h.page.submitRedemption()
    const key = 'admin_staff_redemption_test-env_sp'
    const operation = structuredClone(h.storage.get(key))
    h.page.onUnload()
    h.page.setData = () => assert.fail('An unloaded page cannot update its view')
    finish(rejected ? Object.assign(new Error('请重新核对'), { code: 'STAFF_REDEMPTION_REVIEW_REQUIRED' }) : { status: 'paid' })
    await pending
    assert.deepEqual(h.storage.get(key), operation)
    assert.equal(h.toasts.length, 0)
    assert.equal(h.errors.length, 0)
  }
})

test('a late redemption response cannot erase a newer pending operation stored by another page', async () => {
  for (const rejected of [false, true]) {
    let finish
    const h = harness('admin/sitters/list', (_, action) => action === 'getStaffRedemptionPreview'
      ? Promise.resolve({ enabled: true, available: 100, estimated: 100 })
      : new Promise((resolve, reject) => { finish = rejected ? reject : resolve }))
    h.page.data.profiles = [{ _id: 'sp' }]
    await h.page.openRedemption({ currentTarget: { dataset: { id: 'sp' } } })
    Object.assign(h.page.data, { redemptionAmount: '30', redemptionImage: 'cloud://test.bucket/proof.png', redemptionConfirmed: true })
    const pending = h.page.submitRedemption()
    const key = 'admin_staff_redemption_test-env_sp'
    const newer = { ...structuredClone(h.storage.get(key)), clientRequestId: 'next-operation', amount: 20 }
    h.storage.set(key, newer)
    finish(rejected ? Object.assign(new Error('请重新核对'), { code: 'STAFF_REDEMPTION_REVIEW_REQUIRED' }) : { status: 'paid' })
    await pending
    assert.deepEqual(h.storage.get(key), newer)
    assert.equal(h.page.data.redemptionStaff, null)
    await h.page.openRedemption({ currentTarget: { dataset: { id: 'sp' } } })
    assert.equal(h.page.data.redemptionLocked, true)
    assert.equal(h.page.data.redemptionAmount, '20')
    assert.equal(h.page._redemptionOperation.clientRequestId, 'next-operation')
  }
})

test('manual redemption requires proof and payment confirmation and prevents duplicate clicks', async () => {
  let finish
  const calls = []
  const h = harness('admin/sitters/list', (_, action, data) => new Promise(resolve => { calls.push({ action, data }); finish = resolve }))
  Object.assign(h.page.data, { redemptionStaff: { _id: 'sp' }, redemptionPreview: { enabled: true, available: 100 }, redemptionAmount: '30' })
  await h.page.submitRedemption()
  assert.equal(calls.length, 0)
  h.page.data.redemptionImage = 'cloud://test.bucket/proof.png'
  await h.page.submitRedemption()
  assert.equal(calls.length, 0)
  h.page.data.redemptionConfirmed = true
  const first = h.page.submitRedemption()
  await h.page.submitRedemption()
  h.page.closeRedemption()
  assert.equal(calls.length, 1)
  assert.equal(h.page.data.redemptionStaff._id, 'sp')
  finish({ status: 'paid' })
  await first
  assert.equal(h.page.data.redemptionBusy, false)
})

test('redemption form displays and enforces the current batch limit before submitting', async () => {
  const submissions = []
  const h = harness('admin/sitters/list', async (_, action, data) => {
    if (action === 'getStaffRedemptionPreview') return { enabled: true, available: 105, estimated: 105, maxRedemptionAmount: 50 }
    submissions.push(data)
    return { status: 'paid' }
  })
  h.page.data.profiles = [{ _id: 'sp' }]
  await h.page.openRedemption({ currentTarget: { dataset: { id: 'sp' } } })
  assert.equal(h.page.data.redemptionPreview.maxRedemptionAmountText, '50.00')
  Object.assign(h.page.data, { redemptionAmount: '60', redemptionImage: 'cloud://test.bucket/proof.png', redemptionConfirmed: true })
  await h.page.submitRedemption()
  assert.equal(submissions.length, 0)
  assert.match(h.errors[0].message, /本次.*50.00/)
  assert.equal(h.storage.size, 0)
  h.page.data.redemptionAmount = '50'
  await h.page.submitRedemption()
  assert.equal(submissions.length, 1)
  assert.equal(submissions[0].amount, 50)
})

test('a late redemption preview cannot reopen a closed modal', async () => {
  let finish
  const h = harness('admin/sitters/list', () => new Promise(resolve => { finish = resolve }))
  h.page.data.profiles = [{ _id: 'sp' }]
  const pending = h.page.openRedemption({ currentTarget: { dataset: { id: 'sp' } } })
  h.page.closeRedemption()
  h.page.setData = () => assert.fail('Closed modal must ignore the late preview')
  finish({ enabled: true, available: 100, estimated: 120 })
  await pending
})

test('staff earnings in manual mode shows the remaining estimate and cannot invoke withdrawal', async () => {
  const calls = []
  const h = harness('staff/earnings', async (_, action) => {
    calls.push(action)
    if (action === 'getStaffBalance') return { manualRedemption: true, withdrawalEnabled: false, estimated: 90, available: 70, pending: 20, redeemed: 30 }
    if (action === 'listStaffEarnings') return [{ _id: 'e', status: 'available', amount: 70, redeemedAmount: 30 }]
    if (action === 'listMyWithdraws') return [{ _id: 'w', status: 'paid', source: 'admin_earning_redemption', amount: 30 }]
    throw new Error(action)
  })
  h.page.load = h.originalLoad
  await h.page.load()
  assert.equal(h.page.data.balance.estimatedText, '90.00')
  assert.equal(h.page.data.earnings[0].statusText, '已结算')
  assert.equal(h.page.data.withdraws[0].statusText, '已兑换')
  h.page.data.amount = '70'
  await h.page.withdraw()
  assert.equal(calls.length, 3)
})

test('pending redemption remains accessible after its mode is disabled', async () => {
  const h = harness('admin/sitters/list', async () => ({ list: [{ _id: 'sp', manualRedemption: false }], page: 1, hasMore: false, total: 1 }))
  h.storage.set('admin_staff_redemption_test-env_sp', { staffProfileId: 'sp', clientRequestId: 'saved' })
  h.page.load = h.originalLoad
  await h.page.load({ reset: true })
  assert.equal(h.page.data.profiles[0].redemptionPending, true)
  const source = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/admin/sitters/list/index.wxml'), 'utf8')
  assert.match(source, /item.manualRedemption \|\| item.redemptionPending/)
})

test('held earnings do not appear in the available list or count in either earnings mode', async () => {
  for (const manualRedemption of [true, false]) {
    const h = harness('staff/earnings', async (_, action) => {
      if (action === 'getStaffBalance') return { manualRedemption, available: 10 }
      if (action === 'listStaffEarnings') return [
        { _id: 'free', status: 'available', amount: 10 },
        { _id: 'refund', status: 'available', amount: 20, pendingRefundIds: ['r'] },
        { _id: 'incident', status: 'available', amount: 30, frozenIncidentId: 'i' },
        { _id: 'withdraw', status: 'available', amount: 40, withdrawRequestId: 'w' }
      ]
      return []
    })
    h.page.load = h.originalLoad
    h.page.data.earningFilterStatus = 'available'
    await h.page.load()
    assert.equal(h.page.data.availableEarningsCount, 1)
    assert.deepEqual(Array.from(h.page.data.filteredEarnings, e => e._id), ['free'])
    assert.deepEqual(Array.from(h.page.data.earnings.slice(1), e => e.statusText), ['退款处理中', '已冻结', '提现处理中'])
    h.page.filterEarnings({ currentTarget: { dataset: { status: '' } } })
    assert.equal(h.page.data.filteredEarnings.length, 4)
    h.page.filterEarnings({ currentTarget: { dataset: { status: 'available' } } })
    assert.deepEqual(Array.from(h.page.data.filteredEarnings, e => e._id), ['free'])
  }
})

test('stale staff balance responses cannot overwrite a newer manual mode or update after unload', async () => {
  const pending = []
  const h = harness('staff/earnings', (_, action) => action === 'getStaffBalance'
    ? new Promise(resolve => pending.push(resolve)) : Promise.resolve([]))
  h.page.load = h.originalLoad
  const old = h.page.load(), latest = h.page.load()
  pending[1]({ manualRedemption: true, withdrawalEnabled: false, estimated: 70 })
  await latest
  pending[0]({ manualRedemption: false, withdrawalEnabled: true, available: 100 })
  await old
  assert.equal(h.page.data.balance.manualRedemption, true)
  assert.equal(h.page.data.balance.estimatedText, '70.00')
  const unloading = h.page.load()
  h.page.onUnload()
  h.page.setData = () => assert.fail('No updates after unload')
  pending[2]({ available: 200 })
  await unloading
})

test('a rejected redemption refreshes the reviewed balance while retaining proof and entered amount', async () => {
  let previews = 0
  const h = harness('admin/sitters/list', async (_, action) => {
    if (action === 'getStaffRedemptionPreview') return { enabled: true, available: ++previews === 1 ? 100 : 20, estimated: 20 }
    throw Object.assign(new Error('兑换金额超过当前可兑换收益，请刷新后核对'), { code: 'STAFF_REDEMPTION_REVIEW_REQUIRED' })
  })
  h.page.data.profiles = [{ _id: 'sp' }]
  await h.page.openRedemption({ currentTarget: { dataset: { id: 'sp' } } })
  Object.assign(h.page.data, { redemptionAmount: '30', redemptionImage: 'cloud://test.bucket/proof.png', redemptionConfirmed: true })
  await h.page.submitRedemption()
  assert.equal(h.page.data.redemptionPreview.available, 20)
  assert.equal(h.page.data.redemptionAmount, '30')
  assert.equal(h.page.data.redemptionImage, 'cloud://test.bucket/proof.png')
  assert.equal(h.page.data.redemptionConfirmed, false)
  assert.equal(h.page.data.redemptionLocked, false)
  assert.equal(h.storage.size, 0)
})

test('resetting the sitter list clears selections from the previous deposit filter', async () => {
  const h = harness('admin/sitters/list', async () => ({ list: [{ _id: 'visible', depositStandardAmount: 100, depositBalance: 50 }], page: 1, hasMore: false, total: 1 }))
  h.page.load = h.originalLoad
  Object.assign(h.page.data, { profiles: [{ _id: 'hidden', selected: true }], selectedIds: ['hidden'], minDeposit: '40', maxDeposit: '60' })
  await h.page.load({ reset: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.page.data.selectedIds.length, 0)
  assert.equal(h.page.data.profiles[0]._id, 'visible')
  assert.equal(h.page.data.profiles[0].selected, false)
})

test('batch repayment submits exactly the sitter IDs reviewed in its preview', async () => {
  const calls = []
  const h = harness('admin/sitters/list', async (_, action, data) => { calls.push({ action, data }); return { count: 1 } })
  Object.assign(h.page.data, { profiles: [{ _id: 'visible', depositTopUpAmount: 50 }], selectedIds: ['hidden', 'visible'] })
  h.page.openRepayModal()
  assert.equal(h.page.data.selectedProfiles.length, 1)
  // Later selection changes cannot alter an already displayed confirmation.
  h.page.data.selectedIds = ['hidden', 'different']
  await h.page.confirmBatchRepay()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 1)
  assert.deepEqual(Array.from(calls[0].data.staffProfileIds), ['visible'])
})

test('a newer balance filter replaces an in-flight list request and ignores its late response', async () => {
  const requests = []
  const h = harness('admin/sitters/list', (_, action, data) => new Promise(resolve => requests.push({ data, resolve })))
  h.page.load = h.originalLoad
  const old = h.page.load({ reset: true })
  h.page.data.minDeposit = '50'
  const latest = h.page.load({ reset: true })
  assert.equal(requests.length, 2)
  requests[1].resolve({ list: [{ _id: 'matching' }], page: 1, hasMore: false, total: 1 })
  await latest
  requests[0].resolve({ list: [{ _id: 'obsolete' }], page: 1, hasMore: false, total: 1 })
  await old
  assert.equal(requests[1].data.minDeposit, '50')
  assert.equal(h.page.data.profiles[0]._id, 'matching')
  assert.equal(h.page.data.loading, false)
})

test('failed sitter pagination retries the same page and keeps the applied deposit filter', async () => {
  const requests = []
  let fail = true
  const h = harness('admin/sitters/list', async (_, action, data) => {
    requests.push({ ...data })
    if (data.page === 2 && fail) { fail = false; throw new Error('network error') }
    return { list: [{ _id: `page-${data.page}` }], page: data.page, hasMore: true, total: 40 }
  })
  h.page.load = h.originalLoad
  h.page.data.minDeposit = '50'
  await h.page.load({ reset: true })
  await new Promise(resolve => setImmediate(resolve))
  h.page.data.minDeposit = '100'
  await h.page.loadMore()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.page.data.page, 1)
  await h.page.loadMore()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(requests.map(row => row.page), [1, 2, 2])
  assert.deepEqual(requests.map(row => row.minDeposit), ['50', '50', '50'])
  assert.deepEqual(Array.from(h.page.data.profiles, row => row._id), ['page-1', 'page-2'])
})

test('batch repayment remains locked during submission and keeps its reviewed IDs across list refreshes', async () => {
  let finish
  const calls = []
  const h = harness('admin/sitters/list', (_, action, data) => {
    calls.push({ action, data })
    if (action === 'batchRequireDepositRepay') return new Promise(resolve => { finish = resolve })
    return Promise.resolve({ list: [{ _id: 'new', depositTopUpAmount: 20 }], page: 1, hasMore: false, total: 1 })
  })
  h.page.load = h.originalLoad
  Object.assign(h.page.data, { profiles: [{ _id: 'reviewed', depositTopUpAmount: 50 }], selectedIds: ['reviewed'] })
  h.page.openRepayModal()
  const pending = h.page.confirmBatchRepay()
  h.page.closeRepayModal()
  assert.equal(h.page.data.showRepayModal, true)
  assert.equal(h.page.data.submittingRepay, true)
  await h.page.load({ reset: true })
  h.page.data.selectedIds = ['new']
  h.page.openRepayModal()
  await h.page.confirmBatchRepay()
  assert.deepEqual(Array.from(h.page.data.selectedProfiles, p => p._id), ['reviewed'])
  assert.equal(calls.filter(c => c.action === 'batchRequireDepositRepay').length, 1)
  finish({ count: 1 })
  await pending
  assert.equal(h.page.data.showRepayModal, false)
  assert.equal(h.page.data.submittingRepay, false)
})

test('an obsolete list failure does not clear the newer request loading state or display an error', async () => {
  const requests = []
  const h = harness('admin/sitters/list', () => new Promise((resolve, reject) => requests.push({ resolve, reject })))
  h.page.load = h.originalLoad
  const old = h.page.load({ reset: true })
  const current = h.page.load({ reset: true })
  requests[0].reject(new Error('obsolete failure'))
  await old
  assert.equal(h.page.data.loading, true)
  assert.equal(h.errors.length, 0)
  requests[1].resolve({ list: [{ _id: 'current' }], page: 1, total: 1, hasMore: false })
  await current
  assert.equal(h.page.data.loading, false)
  assert.equal(h.page.data.profiles[0]._id, 'current')
})

test('unloaded sitter pages ignore pending list and batch repayment responses', async () => {
  for (const action of ['listStaffProfiles', 'batchRequireDepositRepay']) {
    let finish
    const h = harness('admin/sitters/list', () => new Promise(resolve => { finish = resolve }))
    h.page.load = h.originalLoad
    Object.assign(h.page.data, { profiles: [{ _id: 'reviewed', depositTopUpAmount: 50 }], selectedIds: ['reviewed'] })
    h.page.openRepayModal()
    const pending = action === 'listStaffProfiles' ? h.page.load({ reset: true }) : h.page.confirmBatchRepay()
    h.page.onUnload()
    h.page.setData = () => assert.fail('Must not update an unloaded page')
    finish(action === 'listStaffProfiles' ? { list: [], page: 1, hasMore: false, total: 0 } : { count: 1 })
    await pending
    assert.equal(h.toasts.length, 0)
    assert.equal(h.errors.length, 0)
  }
})

test('top-up reuses the original supply address and skips renewed supply consent while delivery edits still require it', async () => {
  const calls = []
  const address = { name: '原收件人', phone: '13900001111', province: '上海市', city: '上海市', district: '浦东新区', detail: '原地址 18 号' }
  const state = { canPay: true, topUpAmount: 1, supplyDeliveryRequired: true, supplyConsentRequired: false,
    deposit: { _id: 'topup', status: 'unpaid' }, supplyDeposit: { _id: 'original', status: 'paid', supplyPolicyAcceptedAt: '2026-11-01', supplyAddress: address } }
  const h = harness('staff/training', async (_, action, data) => {
    calls.push({ action, data })
    if (action === 'getDepositStatus') return structuredClone(state)
    if (action === 'createDepositPayment') {
      state.canPay = false
      state.deposit.status = 'paid'
      return { paid: true }
    }
    throw new Error(action)
  })
  await h.page.loadDeposit()
  assert.equal(h.page.data.supplyAddress.detail, address.detail)
  await h.page.payDeposit()
  h.page.agreeDeposit({ detail: { value: ['agreed'] } })
  await h.page.continueDepositRules()
  const payments = calls.filter(call => call.action === 'createDepositPayment')
  assert.equal(payments.length, 1)
  assert.equal(payments[0].data.acceptSupplyPolicy, false)
  assert.equal(h.page.data.depositModal, '')
  h.page.openSupplyDelivery()
  await h.page.loadDeposit({ preserveCheckout: true })
  h.page.agreeDeposit({ detail: { value: ['agreed'] } })
  await h.page.continueDepositRules()
  assert.equal(h.page.data.depositModal, 'rules')
  h.page.agreeSupply({ detail: { value: ['agreed'] } })
  await h.page.continueDepositRules()
  assert.equal(h.page.data.depositModal, 'address')
  assert.equal(h.page.data.supplyAddress.detail, address.detail)
})

test('checkout amount labels show the shortfall for payment and combined balance for address editing', () => {
  const template = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/staff/training/deposit-checkout.wxml'), 'utf8')
  const amounts = [...template.matchAll(/¥\{\{([^}]+)\}\}/g)].map(match => match[1]).filter(expression => !expression.includes('checkoutSupplyFeeAmount'))
  assert.equal(amounts.length, 2)
  for (const [standard, balance] of [[99, 50], [100, 50], [501, 500]]) {
    const depositState = { config: { amount: standard }, topUpAmount: standard - balance, depositBalance: balance, deposit: { paidAmount: 1 } }
    for (const expression of amounts) assert.equal(vm.runInNewContext(expression, { depositState, depositIntent: 'payment' }), standard - balance)
    assert.equal(vm.runInNewContext(amounts[0], { depositState, depositIntent: 'delivery' }), balance)
  }
})

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
  assert.equal(h.errors[0].message, '超过单笔转账上下限')
  assert.doesNotMatch(h.errors[0].message, /INVALID_REQUEST/)
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

test('supplyAddressInput updates address smoothly without focus flickering or keyboard dismissal', () => {
  const h = harness('staff/training', async () => ({}))
  const template = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/staff/training/deposit-checkout.wxml'), 'utf8')
  // 模板中不能有动态绑定 focus="{{supplyAddressFocus..." 属性，否则在微信小程序中每次 setData 都会触发 native input 的失焦并收起键盘
  assert.equal(template.includes('focus="{{supplyAddressFocus'), false, 'input must not bind focus to dynamic expression to avoid keyboard closing on each character')

  h.page.data.supplyAddressErrors = { name: '请填写收件人姓名', phone: '请填写手机号' }
  h.page.data.supplyAddress = { name: '', phone: '' }

  let lastPatch = null
  h.page.setData = (patch) => {
    lastPatch = patch
    Object.assign(h.page.data, patch)
  }

  // 输入第一个字符
  h.page.supplyAddressInput({ currentTarget: { dataset: { field: 'name' } }, detail: { value: '张' } })
  assert.equal(h.page.data.supplyAddress.name, '张')
  assert.equal(h.page.data.supplyAddressErrors.name, undefined)
  assert.equal(h.page.data.supplyAddressErrors.phone, '请填写手机号')
  assert.equal('supplyAddressFocus' in lastPatch, false)

  // 输入第二个字符
  h.page.supplyAddressInput({ currentTarget: { dataset: { field: 'name' } }, detail: { value: '张三' } })
  assert.equal(h.page.data.supplyAddress.name, '张三')
  // 错误已经清除的情况下，不需要再次向 patch 中塞入 supplyAddressErrors
  assert.equal('supplyAddressErrors' in lastPatch, false)
  assert.equal('supplyAddressFocus' in lastPatch, false)
})
