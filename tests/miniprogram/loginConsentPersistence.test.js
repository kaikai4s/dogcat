const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '../../miniprogram')

test('profile page preserves showConsentModal and loginAgreed on onShow / refreshProfile', async () => {
  let pageConfig = null
  const cloudMock = {
    getCachedUser: () => null,
    getCloudEnv: () => 'test-env',
    getCurrentUser: async () => null,
    subscribeIdentityChange: () => () => {},
    callFunction: async () => ({}),
    loginWithWechat: async () => null,
    ensureLogin: async () => null,
    logoutCurrentUser: () => {},
    showError: () => {}
  }

  const code = fs.readFileSync(path.join(root, 'pages/client/profile/index.js'), 'utf8')

  vm.runInNewContext(code, {
    Page: config => { pageConfig = config },
    require: modulePath => {
      if (modulePath.includes('display-cache')) return {
        scopeKey: () => '',
        readDisplay: () => ({}),
        writeDisplay: () => {},
        pickSummary: () => ({}),
        getAvatar: () => '',
        resolveAvatar: (s, src) => Promise.resolve(src)
      }
      if (modulePath.includes('utils/cloud')) return cloudMock
      if (modulePath.includes('theme')) return { themeOptions: [], applyTheme: () => ({ value: 'day' }), saveTheme: () => {}, getThemeState: () => ({}) }
      if (modulePath.includes('font')) return { fontOptions: [], applyFont: () => ({ value: 'system' }), saveFont: () => {}, getFontState: () => ({}) }
      if (modulePath.includes('clipboard')) return { copyText: () => {} }
      return {}
    },
    wx: {
      setNavigationBarTitle: () => {},
      stopPullDownRefresh: () => {},
      showModal: () => {},
      showToast: () => {}
    },
    getApp: () => ({ globalData: {} }),
    clearTimeout: () => {},
    setTimeout: (fn) => setTimeout(fn, 0),
    console
  })

  assert.ok(pageConfig)

  const instance = {
    ...pageConfig,
    data: { ...pageConfig.data },
    setData(patch, cb) {
      Object.assign(this.data, patch)
      if (typeof cb === 'function') cb()
    }
  }

  // 模拟初始加载
  instance.onLoad()
  assert.equal(instance.data.showConsentModal, false)
  assert.equal(instance.data.loginAgreed, false)

  // 模拟用户点击微信登录，唤起协议弹窗
  instance.setData({ showConsentModal: true, loginAgreed: true })
  assert.equal(instance.data.showConsentModal, true)
  assert.equal(instance.data.loginAgreed, true)

  // 模拟用户从协议页面返回，触发 onShow
  await instance.onShow()

  // 验证弹窗与勾选状态依然得到保留，未被 applyGuest() 关掉
  assert.equal(instance.data.showConsentModal, true)
  assert.equal(instance.data.loginAgreed, true)
})

test('agreement page onUnderstand syncs state to previous page and navigates back', () => {
  let pageConfig = null
  let navigatedBack = false
  const storage = new Map()

  const prevPage = {
    data: {
      showConsentModal: false,
      loginAgreed: false
    },
    setData(patch) {
      Object.assign(this.data, patch)
    }
  }

  const code = fs.readFileSync(path.join(root, 'pages/common/agreement/index.js'), 'utf8')

  vm.runInNewContext(code, {
    Page: config => { pageConfig = config },
    require: () => ({}),
    getCurrentPages: () => [prevPage, {}],
    wx: {
      setStorageSync: (k, v) => storage.set(k, v),
      navigateBack: ({ fail } = {}) => {
        navigatedBack = true
      },
      redirectTo: () => {}
    },
    console
  })

  assert.ok(pageConfig)

  const instance = {
    ...pageConfig,
    data: {
      ...pageConfig.data,
      type: 'user_service',
      viewOnly: true
    },
    setData(patch, cb) {
      Object.assign(this.data, patch)
      if (typeof cb === 'function') cb()
    }
  }

  instance.onUnderstand()

  assert.equal(navigatedBack, true)
  assert.equal(prevPage.data.showConsentModal, true)
  assert.equal(prevPage.data.loginAgreed, true)
  assert.ok(storage.has('agreed_agreement_user_service'))
})
