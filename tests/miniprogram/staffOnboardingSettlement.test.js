const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

function harness(route, callFunction) {
  let page
  const storage = new Map(), errors = [], toasts = [], modals = []
  const wx = {
    showModal(options) { modals.push(options); if (options.success) options.success({ confirm: true }) },
    showToast(options) { toasts.push(options) }, showLoading() {}, hideLoading() {},
    requestPayment(options) { options.success({}) },
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, structuredClone(value)), removeStorageSync: key => storage.delete(key)
  }
  const source = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages', route, 'index.js'), 'utf8')
  vm.runInNewContext(source, { wx, Page(value) { page = value }, setTimeout(callback) { callback(); return 0 },
    require(name) {
      if (name.endsWith('/cloud')) return { callFunction, showError: error => errors.push(error) }
      if (name.endsWith('/format')) return { withStaffWorkflowText: value => value, formatDateTime: value => value }
      if (name.endsWith('/theme')) return { applyTheme: () => ({ value: 'day' }), getThemeState: () => ({}) }
      if (name.endsWith('/clipboard')) return { copyText() {} }
      if (name.endsWith('/admin-page-read')) return { optionalAdminRead() {} }
      if (name.endsWith('/image-upload')) return { uploadImage() {} }
      if (name.endsWith('/envList')) return { getActiveEnvId: () => 'test-env' }
      throw new Error(`Unexpected dependency: ${name}`)
    }
  })
  page.setData = (patch, callback) => { Object.assign(page.data, patch); if (callback) callback() }
  const originalLoad = page.load
  page.load = () => {}
  return { page, originalLoad, wx, storage, errors, toasts, modals }
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
