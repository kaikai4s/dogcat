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
  assert.equal(h.page.data.depositBusy, false)
  assert.ok(h.toasts.some(toast => toast.title.includes('结果确认中')))
  assert.ok(!h.toasts.some(toast => toast.title === '保证金已缴纳'))
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
