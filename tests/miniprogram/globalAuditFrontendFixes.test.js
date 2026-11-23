const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '../../miniprogram')

test('mall checkout passes shippingFee to listMallCoupons and excludes inapplicable coupons', async () => {
  const calls = []
  let pageDef
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/client/mall/checkout/index.js'), 'utf8'), {
    Page: (def) => { pageDef = def },
    require: (name) => {
      if (name.endsWith('/cloud')) {
        return {
          callFunction: async (mod, action, data) => {
            calls.push({ mod, action, data })
            if (action === 'listMallCoupons') {
              return [
                { _id: 'c_ok', name: '满50减10', status: 'available', applicable: true, discountAmount: 10, minOrderAmount: 50 },
                { _id: 'c_bad', name: '满100减20', status: 'available', applicable: false, discountAmount: 20, minOrderAmount: 100 }
              ]
            }
            return []
          },
          showError: () => {},
          ensureLogin: async () => {},
          requestSubscribeTemplates: async () => {},
          loadSystemSettings: async () => {},
          showLoading: () => {},
          hideLoading: () => {}
        }
      }
      if (name.endsWith('/offlineQueue')) return { createClientRequestId: () => 'req_1' }
      return {}
    },
    wx: { showToast() {}, showModal() {}, navigateTo() {}, redirectTo() {}, navigateBack() {} }
  })

  const page = {
    ...pageDef,
    data: {
      ...pageDef.data,
      couponId: 'c_bad',
      couponName: '满100减20',
      items: [{ productId: 'p1', skuId: 's1', price: 40, quantity: 1, shippingFee: 10 }]
    },
    setData(patch, cb) {
      Object.assign(this.data, patch)
      if (cb) cb()
    }
  }

  await page.loadCoupons()
  assert.equal(calls[0].action, 'listMallCoupons')
  assert.equal(calls[0].data.items[0].shippingFee, 10)
  assert.deepEqual(page.data.coupons.map(c => c._id), ['c_ok'])
  assert.equal(page.data.couponId, '')
  assert.equal(page.data.couponName, '')
})

test('staff earnings load and fillAllAvailable respect exact earning subset sums within transfer cap', async () => {
  let pageDef
  const toasts = []
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/staff/earnings/index.js'), 'utf8'), {
    Page: (def) => { pageDef = def },
    wx: { showToast: (t) => toasts.push(t), showModal() {}, showLoading() {}, hideLoading() {}, stopPullDownRefresh() {} },
    require: (name) => {
      if (name.endsWith('/cloud')) {
        return {
          callFunction: async (_, action) => {
            if (action === 'getStaffBalance') {
              return { available: 240, wechatTransferQuota: { singleMaxAmount: 200, effectiveRemainingAmount: 200 } }
            }
            if (action === 'listStaffEarnings') {
              return [
                { _id: 'e1', status: 'available', amount: 80 },
                { _id: 'e2', status: 'available', amount: 80 },
                { _id: 'e3', status: 'available', amount: 80 }
              ]
            }
            return []
          },
          showError: () => {}, showLoading: () => {}, hideLoading: () => {}
        }
      }
      if (name.endsWith('/nav')) return { navMethods: () => ({}) }
      if (name.endsWith('/offlineQueue')) return { createClientRequestId: () => 'req_1' }
      if (name.endsWith('/theme')) return { applyTheme: () => ({ value: 'day' }), getThemeState: () => ({}) }
      return {}
    }
  })

  const page = { ...pageDef, data: { ...pageDef.data }, setData(patch) { Object.assign(this.data, patch) } }
  await page.load()
  assert.equal(page.data.amount, '160.00')
  page.data.amount = ''
  page.fillAllAvailable()
  assert.equal(page.data.amount, '160')

  // Non-greedy exact match [150, 100, 100] with cap 200 finds 200
  page.data.earnings = [
    { _id: 'a1', isAvailable: true, amount: 150 },
    { _id: 'a2', isAvailable: true, amount: 100 },
    { _id: 'a3', isAvailable: true, amount: 100 }
  ]
  page.data.balance = { available: 350, wechatTransferQuota: { singleMaxAmount: 200, effectiveRemainingAmount: 200 } }
  page.fillAllAvailable()
  assert.equal(page.data.amount, '200')
  assert.equal(toasts.length, 0)
})

test('staff checkin camera never enqueues sanitization offline and respects readOnly mode during service', async () => {
  let pageDef
  const enqueued = []
  const toasts = []
  const errors = []
  let navigatedBack = 0
  let checkReadyCalled = 0

  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/staff/checkin/camera/index.js'), 'utf8'), {
    Page: (def) => { pageDef = def },
    require: (name) => {
      if (name.endsWith('/image-upload')) return { uploadImage: ({ success }) => success({ fileID: 'cloud://san.jpg' }) }
      if (name.endsWith('/cloud')) {
        return {
          callFunction: async (mod, action) => {
            if (action === 'checkServiceTimeReadyForCheckin') {
              checkReadyCalled += 1
              return { ok: true }
            }
            if (action === 'createCheckin') throw new Error('network timeout')
            return []
          },
          showError: (err) => errors.push(err),
          getServiceLocation: async () => ({ latitude: 31.2, longitude: 121.5, accuracy: 10 })
        }
      }
      if (name.endsWith('/nav')) return { createPageNav: () => ({}), navMethods: () => ({}) }
      if (name.endsWith('/offlineQueue')) {
        return {
          createClientRequestId: () => 'req_san_1',
          enqueueOfflineTask: (...args) => enqueued.push(args)
        }
      }
      if (name.endsWith('/format')) return { formatCheckinEvent: () => '消毒', withCheckinText: x => x }
      if (name.endsWith('/theme')) return { applyTheme: () => ({ value: 'day' }), getThemeState: () => ({}) }
      return {}
    },
    wx: {
      chooseMedia: ({ success }) => success({ tempFiles: [{ tempFilePath: '/tmp/a.jpg' }] }),
      showToast: (t) => toasts.push(t),
      navigateBack: () => { navigatedBack += 1 }
    },
    setTimeout: (fn) => fn()
  })

  const page = { ...pageDef, data: { ...pageDef.data }, setData(patch) { Object.assign(this.data, patch) } }
  page.onLoad({ id: 'ord_1', eventType: 'sanitization' })
  await page.chooseAndCreateCheckins()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(enqueued.length, 0)
  assert.equal(navigatedBack, 0)
  assert.equal(toasts.some(t => t.title === '已打卡'), false)
  assert.equal(errors.length, 1)

  // Read-only mode blocks uploading during in_service
  page.onLoad({ id: 'ord_1', eventType: 'sanitization', readOnly: '1' })
  assert.equal(page.data.isReadOnly, true)
  const prevChecks = checkReadyCalled
  page.chooseAndCreateCheckins()
  assert.equal(checkReadyCalled, prevChecks)
  assert.equal(toasts[toasts.length - 1].title, '服务已开始，仅可查看服务前消毒凭证')
})

test('global-loading detaches bus listeners on page hide and cloud.showLoading falls back cleanly without polluting bus state', () => {
  const { loadingBus } = require('../../miniprogram/utils/loadingBus')
  let compDef
  vm.runInNewContext(fs.readFileSync(path.join(root, 'components/global-loading/index.js'), 'utf8'), {
    Component: (def) => { compDef = def },
    require: (name) => {
      if (name.endsWith('/loadingBus')) return { loadingBus }
      if (name.endsWith('/cloud-assets')) return { getLoadingCatUrl: () => '/images/loading-cat.gif' }
      return {}
    }
  })

  const comp = {
    data: { ...compDef.data },
    ...compDef.lifetimes,
    pageLifetimes: compDef.pageLifetimes,
    setData(patch) { Object.assign(this.data, patch) }
  }
  comp.attached()
  assert.equal(loadingBus.hasActiveListener(), true)
  loadingBus.show({ title: '加载中' })
  assert.equal(comp.data.visible, true)

  // Page A hides when navigating to Page B (without <global-loading />)
  comp.pageLifetimes.hide.call(comp)
  assert.equal(comp.data.visible, false)
  assert.equal(loadingBus.hasActiveListener(), false)
  assert.equal(loadingBus.getState().isVisible, false)

  // Page B invokes cloud.showLoading -> falls back to native wx.showLoading without setting loadingBus.isVisible = true
  const nativeCalls = []
  global.wx = {
    showLoading: (opts) => nativeCalls.push(opts),
    hideLoading: () => {}
  }
  try {
    delete require.cache[require.resolve('../../miniprogram/utils/cloud')]
    const { showLoading, hideLoading } = require('../../miniprogram/utils/cloud')
    showLoading({ title: '资产加载中' })
    assert.equal(nativeCalls.length, 1)
    assert.equal(nativeCalls[0].title, '资产加载中')
    assert.equal(loadingBus.getState().isVisible, false)
    hideLoading()
  } finally {
    delete global.wx
    comp.detached()
  }

  // Navigating back to Page A re-subscribes without showing a stuck overlay
  comp.pageLifetimes.show.call(comp)
  assert.equal(loadingBus.hasActiveListener(), true)
  assert.equal(comp.data.visible, false)
  comp.detached()
  assert.equal(loadingBus.hasActiveListener(), false)
})

test('lottery admin and client order create pages define noop handler and contiguous schedule check works', () => {
  let lotteryPage
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/admin/lottery/index.js'), 'utf8'), {
    Page: (def) => { lotteryPage = def },
    require: () => ({ optionalAdminRead: async () => [], callFunction: async () => ({}), showError() {}, PET_BLESSINGS: [], getFormattedBlessingList: () => [], getRandomBlessing: () => ({}), resolvePetBlessing: () => ({ name: '', text: '' }) }),
    wx: {}
  })
  assert.equal(typeof lotteryPage.noop, 'function')

  const createExports = require('../../miniprogram/pages/client/orders/create/index.js')
  const check = createExports.checkTimeFitsSitterSchedule('2026-11-23 11:00', '2026-11-23 13:00', {
    available: true,
    slots: [{ start: 8, end: 12 }, { start: 12, end: 18 }],
    busyOrders: []
  })
  assert.equal(check.ok, true)

  let createPageDef
  const realFormat = require('../../miniprogram/utils/format')
  const noopModule = new Proxy({}, { get: (_, prop) => prop === 'navMethods' ? () => ({}) : (() => ({})) })
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/client/orders/create/index.js'), 'utf8'), {
    Page: (def) => { createPageDef = def },
    require: (name) => name.endsWith('/format') ? realFormat : noopModule,
    module: { exports: {} },
    wx: {},
    setTimeout,
    clearTimeout
  })
  assert.equal(typeof createPageDef.noop, 'function')
})
