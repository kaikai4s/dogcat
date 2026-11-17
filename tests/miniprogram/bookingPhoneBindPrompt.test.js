const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const createDir = path.resolve(__dirname, '../../miniprogram/pages/client/orders/create')
const editDir = path.resolve(__dirname, '../../miniprogram/pages/client/profile/edit')

function loadRealCloud({ callFunction, modals, toasts } = {}) {
  const globalData = { user: null }
  const wx = {
    getStorageSync: () => '',
    setStorageSync() {},
    removeStorageSync() {},
    showLoading() {},
    hideLoading() {},
    showToast(opts) { if (toasts) toasts.push(opts) },
    showModal(opts) { if (modals) modals.push(opts) },
    cloud: {
      init() {},
      async callFunction({ name, data }) {
        const res = await callFunction(data.module, data.action, data.data)
        return { result: { ok: true, data: res } }
      }
    }
  }
  const mod = { exports: {} }
  const envList = { envList: [{ envId: 'env-1' }], getActiveEnvId: () => 'env-1' }
  const subOpts = { subscriptionTemplateIssue: () => ({}) }
  const theme = { getSavedThemeKey: () => 'day', saveTheme() {} }
  const font = { getSavedFontKey: () => 'system', saveFont() {} }
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../miniprogram/utils/cloud.js'), 'utf8'), {
    module: mod,
    exports: mod.exports,
    require(req) {
      if (req.includes('envList')) return envList
      if (req.includes('subscription-options')) return subOpts
      if (req.includes('theme')) return theme
      if (req.includes('font')) return font
      return {}
    },
    wx,
    getApp: () => ({ globalData }),
    console,
    setTimeout,
    clearTimeout
  })
  return { cloud: mod.exports, wx, globalData }
}

function loadCreatePage({ userPhone = '' } = {}) {
  let page
  const navCalls = []
  const toasts = []
  const modals = []
  const cloudCalls = []
  const format = require('../../miniprogram/utils/format')
  const { cloud, globalData } = loadRealCloud({
    modals,
    toasts,
    callFunction: async (module, action, data) => {
      cloudCalls.push({ module, action, data })
      if (module === 'auth' && action === 'loginByPhoneCode') {
        return { _id: 'user', phone: '13800138000' }
      }
      if (action === 'listServiceOptions') return [{ key: 'feed', price: 49 }]
      if (action === 'listPets') return [{ _id: 'pet1', name: 'Momo', species: 'cat' }]
      return []
    }
  })

  const fakeUser = { _id: 'user', phone: userPhone }
  globalData.user = fakeUser

  const wx = {
    getStorageSync: () => null,
    setStorageSync() {},
    removeStorageSync() {},
    navigateTo(opts) { navCalls.push(opts.url) },
    redirectTo(opts) { navCalls.push(opts.url) },
    pageScrollTo() {},
    showToast(opts) { toasts.push(opts) },
    showModal(opts) { modals.push(opts) },
    cloud: {}
  }

  const navModule = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../miniprogram/utils/nav.js'), 'utf8'), {
    module: navModule,
    require: () => ({ getRoleHome: () => '/pages/client/home/index' }),
    wx,
    getCurrentPages: () => [{ route: 'pages/client/orders/create/index' }]
  })

  const deps = {
    ...cloud,
    loadSystemSettings: async () => ({}),
    getCachedSystemSettings: () => ({}),
    getCurrentUser: async () => fakeUser,
    ensureLogin: async () => globalData.user,
    applyTheme: () => ({ value: 'day' }),
    getThemeState: () => ({}),
    getSelectedLocation: () => null,
    toBeijingDate: format.toBeijingDate,
    parseBeijingDate: format.parseBeijingDate,
    showError() {},
    callFunction: async (module, action, data) => {
      cloudCalls.push({ module, action, data })
      if (module === 'auth' && action === 'loginByPhoneCode') return { _id: 'user', phone: '13800138000' }
      if (action === 'listServiceOptions') return [{ key: 'feed', price: 49 }]
      if (action === 'listPets') return [{ _id: 'pet1', name: 'Momo', species: 'cat' }]
      return []
    }
  }

  vm.runInNewContext(fs.readFileSync(path.join(createDir, 'index.js'), 'utf8'), {
    Page(config) { page = config },
    require: (name) => name.endsWith('/nav') ? navModule.exports : deps,
    wx,
    getApp: () => ({ globalData }),
    getCurrentPages: () => [{ route: 'pages/client/orders/create/index' }],
    console: { error() {}, warn() {} },
    setTimeout,
    clearTimeout
  })

  page.setData = function (updates, callback) {
    for (const [key, value] of Object.entries(updates)) {
      const parts = key.split('.')
      let target = this.data
      for (const part of parts.slice(0, -1)) target = target[part]
      target[parts[parts.length - 1]] = value
    }
    if (callback) callback.call(this)
  }

  return { page, navCalls, toasts, modals, cloudCalls, globalData }
}

test('orders/create WXML provides both inline banner and modal phone-binding entry points', () => {
  const wxml = fs.readFileSync(path.join(createDir, 'index.wxml'), 'utf8')
  const editWxml = fs.readFileSync(path.join(editDir, 'index.wxml'), 'utf8')

  assert.ok(wxml.includes('wx:if="{{user && !user.phone}}" class="booking-phone-banner"'))
  assert.ok(wxml.includes('wx:if="{{showPhoneBindModal}}" class="phone-bind-modal-backdrop"'))
  assert.ok(wxml.includes('open-type="getPhoneNumber"'))
  assert.ok(wxml.includes('bindgetphonenumber="bindPhoneNumber"'))
  assert.ok(wxml.includes('bindtap="goBindPhone"'))
  assert.ok(editWxml.includes('wx:if="{{returnOnPhoneBind}}"'))
})

test('orders/create opens phone-binding prompt on submit/coupon check and allows inline bind or jump to profile edit', async () => {
  const { page, navCalls, cloudCalls } = loadCreatePage({ userPhone: '' })
  page.onLoad()
  await page.onShow()

  page.setData({ agreeAgreement: true })
  page.create()

  assert.equal(page.data.showPhoneBindModal, true)
  assert.equal(page.data.bookingNotice, '')

  page.closePhoneBindModal()
  assert.equal(page.data.showPhoneBindModal, false)

  // Selecting coupon also prompts phone binding cleanly when unbound.
  page.chooseCoupon()
  assert.equal(page.data.showPhoneBindModal, true)

  // Navigating to profile edit closes modal and targets booking phone focus query.
  page.goBindPhone()
  assert.equal(page.data.showPhoneBindModal, false)
  assert.deepEqual(navCalls, ['/pages/client/profile/edit/index?from=booking&focus=phone'])

  // Inline WeChat phone authorization binds immediately without leaving the booking page.
  page.openPhoneBindModal()
  assert.equal(page.data.showPhoneBindModal, true)
  await page.bindPhoneNumber({ detail: { code: 'wx_code_123' } })
  assert.ok(cloudCalls.some((c) => c.module === 'auth' && c.action === 'loginByPhoneCode' && c.data.code === 'wx_code_123'))
  assert.equal(page.data.user.phone, '13800138000')
  assert.equal(page.data.showPhoneBindModal, false)
  assert.notEqual(page.validateRequired(), '请先绑定手机号')

  page.onUnload()
})

test('profile/edit auto-returns to orders/create when opened with from=booking', async () => {
  let editPage
  let backed = false
  const timers = []
  const { cloud, wx, globalData } = loadRealCloud({
    callFunction: async () => ({ _id: 'u1', phone: '13900139000' })
  })
  wx.navigateBack = () => { backed = true }

  vm.runInNewContext(fs.readFileSync(path.join(editDir, 'index.js'), 'utf8'), {
    Page(config) { editPage = config },
    require: (req) => req.includes('/cloud') ? cloud : ({ createPageNav: () => ({}), navMethods: () => ({}) }),
    wx,
    getApp: () => ({ globalData }),
    getCurrentPages: () => [{ route: 'orders/create' }, { route: 'profile/edit' }],
    console,
    setTimeout(fn) { timers.push(fn); return timers.length },
    clearTimeout() {}
  })

  editPage.setData = function (updates) {
    for (const [key, value] of Object.entries(updates)) {
      const parts = key.split('.')
      let target = this.data
      for (const part of parts.slice(0, -1)) target = target[part]
      target[parts[parts.length - 1]] = value
    }
  }

  editPage.onLoad({ from: 'booking', focus: 'phone' })
  assert.equal(editPage.data.returnOnPhoneBind, true)
  assert.equal(editPage.data.focusPhone, true)

  await editPage.bindPhone({ detail: { code: 'phone_auth_code' } })
  assert.equal(editPage.data.form.phone, '13900139000')
  assert.equal(timers.length, 1)
  timers[0]()
  assert.equal(backed, true)
})
