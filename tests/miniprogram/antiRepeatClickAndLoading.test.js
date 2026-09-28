const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '../../miniprogram')

test('loadingBus manages global show and hide events with state tracking', () => {
  const { loadingBus } = require('../../miniprogram/utils/loadingBus')
  assert.equal(typeof loadingBus.on, 'function')
  assert.equal(typeof loadingBus.off, 'function')
  assert.equal(typeof loadingBus.show, 'function')
  assert.equal(typeof loadingBus.hide, 'function')

  const events = []
  const onShow = (data) => events.push({ type: 'show', ...data })
  const onHide = () => events.push({ type: 'hide' })

  loadingBus.on('show', onShow)
  loadingBus.on('hide', onHide)
  assert.equal(loadingBus.hasActiveListener(), true)

  loadingBus.show({ title: '测试加载中...' })
  assert.equal(loadingBus.getState().isVisible, true)
  assert.equal(loadingBus.getState().currentTitle, '测试加载中...')
  assert.equal(events.length, 1)
  assert.equal(events[0].title, '测试加载中...')

  loadingBus.hide()
  assert.equal(loadingBus.getState().isVisible, false)
  assert.equal(events.length, 2)
  assert.equal(events[1].type, 'hide')

  loadingBus.off('show', onShow)
  loadingBus.off('hide', onHide)
  assert.equal(loadingBus.hasActiveListener(), false)
})

test('app.wxss enforces pointer-events: none and visual feedback for disabled buttons', () => {
  const appWxss = fs.readFileSync(path.join(root, 'app.wxss'), 'utf8')
  assert.match(appWxss, /button\[disabled\]/)
  assert.match(appWxss, /pointer-events:\s*none\s*!important/)
  assert.match(appWxss, /cursor:\s*not-allowed\s*!important/)
})

test('app.json registers global-loading component globally', () => {
  const appJson = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
  assert.ok(appJson.usingComponents)
  assert.equal(appJson.usingComponents['global-loading'], '/components/global-loading/index')
})

test('staff home index.js implements multi-layer concurrency lock and loading feedback during order grab', async () => {
  const source = fs.readFileSync(path.join(root, 'pages/staff/home/index.js'), 'utf8')
  let pageInstance
  const calls = []
  const loadings = []
  const hideLoadings = []

  const mockCloud = {
    callFunction: async (module, action, data) => {
      calls.push({ module, action, data })
      await new Promise((r) => setTimeout(r, 20))
      return { success: true }
    },
    requirePrivacyAuthorize: async () => {},
    requestSubscribeTemplates: async () => {},
    showError: () => {},
    showLoading: (opts) => loadings.push(opts),
    hideLoading: () => hideLoadings.push(true)
  }

  vm.runInNewContext(source, {
    Page(options) {
      pageInstance = options
    },
    require(name) {
      if (name.includes('cloud')) return mockCloud
      if (name.includes('theme')) return { applyTheme: () => ({ value: 'day' }), getThemeState: () => ({}) }
      return {}
    },
    wx: {
      showToast() {},
      getStorageSync() { return '' },
      setStorageSync() {}
    },
    setTimeout,
    clearTimeout
  })

  // Bind mock page methods
  pageInstance.data = { ...pageInstance.data }
  pageInstance.setData = function(update, cb) {
    Object.assign(this.data, update)
    if (cb) cb()
  }

  assert.equal(pageInstance.data.acceptingOrderId, '')

  // Simulate first accept tap
  pageInstance.submitAcceptOrder = (orderId, riskConfirmed) => {
    calls.push({ module: 'staff', action: 'acceptOrder', data: { orderId, riskConfirmed } })
    pageInstance._isAccepting = false
    pageInstance.setData({ acceptingOrderId: '' })
    mockCloud.hideLoading()
  }

  const promise1 = pageInstance.accept({ currentTarget: { dataset: { id: 'order-123' } } })
  // Verify immediate in-memory synchronous lock and UI state
  assert.equal(pageInstance._isAccepting, true)
  assert.equal(pageInstance.data.acceptingOrderId, 'order-123')
  assert.ok(loadings.length > 0)
  assert.equal(loadings[0].title, '正在抢单...')

  // Simulate rapid second click on the same or another order while the first is pending
  pageInstance.accept({ currentTarget: { dataset: { id: 'order-123' } } })
  pageInstance.accept({ currentTarget: { dataset: { id: 'order-456' } } })

  await new Promise((r) => setTimeout(r, 60))

  // Only one check risk and one acceptOrder should have reached
  assert.equal(calls.filter(c => c.action === 'checkAcceptOrderRisk').length, 1)
  assert.equal(calls.filter(c => c.action === 'acceptOrder').length, 1)
  // Lock must be released upon completion
  assert.equal(pageInstance._isAccepting, false)
  assert.equal(pageInstance.data.acceptingOrderId, '')
  assert.ok(hideLoadings.length > 0)
})

test('staff home index.wxml binds acceptingOrderId to disable buttons and show loading state', () => {
  const wxml = fs.readFileSync(path.join(root, 'pages/staff/home/index.wxml'), 'utf8')
  // Regular grab button
  assert.match(wxml, /disabled="\{\{acceptingOrderId\}\}"/)
  assert.match(wxml, /loading="\{\{acceptingOrderId === item\._id\}\}"/)
  assert.match(wxml, /\{\{acceptingOrderId === item\._id \? '抢单中\.\.\.' : '立即抢单'\}\}/)

  // Urgent grab button
  assert.match(wxml, /\{\{acceptingOrderId === item\._id \? '抢单中\.\.\.' : '加急抢单'\}\}/)
})

test('core transaction pages contain anti-repeat click locks and loading indicators', () => {
  // Client order creation
  const createOrderJs = fs.readFileSync(path.join(root, 'pages/client/orders/create/index.js'), 'utf8')
  assert.match(createOrderJs, /this\.creatingOrder \|\| this\.data\.creating/)
  assert.match(createOrderJs, /正在创建订单/)

  // Client order payment
  const orderDetailJs = fs.readFileSync(path.join(root, 'pages/client/orders/detail/index.js'), 'utf8')
  assert.match(orderDetailJs, /this\._payingLock/)
  assert.match(orderDetailJs, /准备支付中/)

  // Staff service start & finish
  const serviceJs = fs.readFileSync(path.join(root, 'pages/staff/orders/service/index.js'), 'utf8')
  assert.match(serviceJs, /this\._startingLock/)
  assert.match(serviceJs, /this\._finishingLock/)
  assert.match(serviceJs, /正在准备开始服务/)
  assert.match(serviceJs, /正在完成服务/)

  // Staff earnings withdraw
  const earningsJs = fs.readFileSync(path.join(root, 'pages/staff/earnings/index.js'), 'utf8')
  assert.match(earningsJs, /this\._submittingLock/)
  assert.match(earningsJs, /正在提交提现/)

  // Mall checkout
  const mallCheckoutJs = fs.readFileSync(path.join(root, 'pages/client/mall/checkout/index.js'), 'utf8')
  assert.match(mallCheckoutJs, /this\._submittingLock/)
  assert.match(mallCheckoutJs, /正在提交订单/)
})
