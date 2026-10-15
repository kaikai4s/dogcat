const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '../../miniprogram')

test('mall checkout page implements syncPaymentStatusWithRetry and waits for paid confirmation before redirect', async () => {
  const checkoutSource = fs.readFileSync(path.join(root, 'pages/client/mall/checkout/index.js'), 'utf8')
  assert.match(checkoutSource, /syncPaymentStatusWithRetry\s*\(/)
  assert.match(checkoutSource, /isPaidResult/)
  assert.match(checkoutSource, /wx\.requestPayment[\s\S]+syncPaymentStatusWithRetry/)

  let pageConfig
  const sandbox = {
    Page: (cfg) => { pageConfig = cfg },
    require: (mod) => {
      if (mod.includes('cloud')) {
        return {
          callFunction: async (module, action, data) => {
            if (module === 'payment' && action === 'getPaymentStatus') {
              return { status: 'pending_ship', paymentStatus: 'paid', paid: true }
            }
            return {}
          },
          showError: () => {},
          ensureLogin: async () => {},
          requestSubscribeTemplates: async () => {},
          loadSystemSettings: async () => ({}),
          showLoading: () => {},
          hideLoading: () => {}
        }
      }
      if (mod.includes('offlineQueue')) {
        return { createClientRequestId: () => 'req_test' }
      }
      return {}
    },
    setTimeout: (fn) => fn(),
    clearTimeout: () => {},
    Promise,
    wx: {
      showToast: () => {},
      showLoading: () => {},
      hideLoading: () => {},
      redirectTo: () => {}
    }
  }

  vm.runInNewContext(checkoutSource, sandbox)
  assert.equal(typeof pageConfig.syncPaymentStatusWithRetry, 'function')

  const result = await pageConfig.syncPaymentStatusWithRetry('test_order_123')
  assert.equal(result.paymentStatus, 'paid')
  assert.equal(result.status, 'pending_ship')
})

test('mall order detail page implements syncPaymentStatusWithRetry and handles payment flow cleanly', async () => {
  const detailSource = fs.readFileSync(path.join(root, 'pages/client/mall/orders/detail/index.js'), 'utf8')
  assert.match(detailSource, /syncPaymentStatusWithRetry\s*\(/)
  assert.match(detailSource, /isPaidResult/)
  assert.match(detailSource, /_payingLock/)
  assert.match(detailSource, /showLoading/)

  let pageConfig
  const calls = []
  const sandbox = {
    Page: (cfg) => { pageConfig = cfg },
    require: (mod) => {
      if (mod.includes('cloud')) {
        return {
          callFunction: async (module, action, data) => {
            calls.push({ module, action, data })
            if (module === 'payment' && action === 'createPayment') {
              return { mock: true, paymentNo: 'P20261015MOCK' }
            }
            if (module === 'payment' && action === 'mockPayOrder') {
              return { status: 'paid' }
            }
            if (module === 'payment' && action === 'getPaymentStatus') {
              return { status: 'pending_ship', paymentStatus: 'paid' }
            }
            return {}
          },
          showError: () => {},
          ensureLogin: async () => {},
          requestSubscribeTemplates: async () => ({}),
          loadSystemSettings: async () => ({}),
          showLoading: () => {},
          hideLoading: () => {}
        }
      }
      if (mod.includes('offlineQueue')) {
        return { createClientRequestId: () => 'req_test' }
      }
      if (mod.includes('clipboard')) {
        return { copyText: () => {} }
      }
      return {}
    },
    setTimeout: (fn) => fn(),
    clearTimeout: () => {},
    Promise,
    wx: {
      showToast: () => {},
      showLoading: () => {},
      hideLoading: () => {}
    }
  }

  vm.runInNewContext(detailSource, sandbox)
  assert.equal(typeof pageConfig.syncPaymentStatusWithRetry, 'function')
  assert.equal(typeof pageConfig.pay, 'function')

  const instance = {
    data: { id: 'test_order_detail', paying: false },
    setData(update) { Object.assign(this.data, update) },
    load() { calls.push({ method: 'load' }) },
    syncPaymentStatusWithRetry: pageConfig.syncPaymentStatusWithRetry,
    pay: pageConfig.pay
  }

  await instance.pay()

  assert.equal(instance.data.paying, false)
  assert.equal(instance._payingLock, false)
  const actions = calls.map(c => c.action || c.method)
  assert.ok(actions.includes('createPayment'))
  assert.ok(actions.includes('mockPayOrder'))
  assert.ok(actions.includes('getPaymentStatus'))
  assert.ok(actions.includes('load'))
})

test('mall order detail wxss enforces equal width and height for bottom buttons', () => {
  const wxssSource = fs.readFileSync(path.join(root, 'pages/client/mall/orders/detail/index.wxss'), 'utf8')
  assert.match(wxssSource, /\.bottom-bar\s+button[\s\S]*?flex:\s*1\s*!important/)
  assert.match(wxssSource, /\.bottom-bar\s+button[\s\S]*?height:\s*84rpx\s*!important/)
  assert.match(wxssSource, /\.bottom-bar\s+\.ghost-btn/)
  assert.match(wxssSource, /\.bottom-bar\s+\.buy-btn/)
})

