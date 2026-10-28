const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '../../miniprogram')

function createStaffProfilePage(options = {}) {
  const {
    cachedUser = null,
    storageData = {},
    callFunctionMock = async () => ({})
  } = options

  let pageConfig = null
  const storage = new Map(Object.entries(storageData))

  const cloudMock = {
    getCachedUser: () => cachedUser,
    callFunction: callFunctionMock,
    showError: () => {},
    chooseSelectedLocation: async () => ({})
  }

  const code = fs.readFileSync(path.join(root, 'pages/staff/profile/index.js'), 'utf8')

  vm.runInNewContext(code, {
    Page: config => { pageConfig = config },
    require: modulePath => {
      if (modulePath.includes('cloud')) return cloudMock
      if (modulePath.includes('image-upload')) return { uploadImage: () => {} }
      if (modulePath.includes('format')) return { withStaffWorkflowText: (p) => p }
      if (modulePath.includes('theme')) return { applyTheme: () => ({ value: 'day' }), getThemeState: () => ({}) }
      if (modulePath.includes('client-nav')) return { loadMessageUnread: () => {} }
      if (modulePath.includes('profileCardStyle')) return {
        DEFAULT_CARD_STYLE: {},
        isHexColor: () => true,
        normalizeCardStyle: (p) => ({}),
        buildCardStyle: () => ''
      }
      return {}
    },
    wx: {
      getStorageSync: key => storage.get(key),
      setStorageSync: (key, val) => storage.set(key, val),
      showToast: () => {},
      redirectTo: () => {},
      stopPullDownRefresh: () => {}
    },
    getApp: () => ({ globalData: {} }),
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: (id) => clearTimeout(id)
  })

  const page = { ...pageConfig, data: { ...pageConfig.data } }
  const setDataLog = []
  page.setData = function(patch, cb) {
    setDataLog.push(patch)
    Object.assign(this.data, patch)
    if (cb) cb()
  }
  return { page, setDataLog, storage }
}

test('staff profile instant load: pre-populates certified status from cache with zero "未入驻" flash', () => {
  const cachedUser = {
    _id: 'user_s1',
    nickname: '王牌宠托师小李',
    avatarUrl: 'https://example.com/sitter.jpg'
  }
  const cachedProfile = {
    _id: 'p1',
    auditStatus: 'approved',
    staffLevel: 'certified',
    serviceAddress: '成都市武侯区某小区',
    serviceLatitude: 30.65,
    serviceLongitude: 104.06
  }
  const cachedBalance = {
    available: 128.5,
    pending: 45.0,
    withdrawn: 300.0
  }

  const { page } = createStaffProfilePage({
    cachedUser,
    storageData: {
      staff_profile_display_cache_v1: {
        profile: cachedProfile,
        balance: cachedBalance,
        cachedAt: Date.now()
      }
    }
  })

  // 1. 验证首屏实例化阶段已直接填充有效数据，处于已就绪状态
  assert.equal(page.data.loadingProfile, false)
  assert.equal(page.data.statusTitle, '认证宠托师')
  assert.notEqual(page.data.statusTitle, '未入驻')
  assert.equal(page.data.displayName, '王牌宠托师小李')
  assert.equal(page.data.avatarUrl, 'https://example.com/sitter.jpg')
  assert.equal(page.data.balance.availableText, '128.50')
  assert.equal(page.data.balance.pendingText, '45.00')
})

test('staff profile cold start: enters skeleton loading state and hides misleading "未入驻" text', async () => {
  const cachedUser = {
    _id: 'user_s2',
    nickname: '新宠托师'
  }

  let callCount = 0
  const { page, storage } = createStaffProfilePage({
    cachedUser,
    storageData: {}, // 无缓存
    callFunctionMock: async (name, action) => {
      callCount++
      if (name === 'auth' && action === 'me') {
        return { nickname: '新宠托师', roles: ['staff'] }
      }
      if (name === 'staff' && action === 'getStaffProfile') {
        return { auditStatus: 'approved', staffLevel: 'certified', serviceAddress: '地址' }
      }
      if (name === 'finance' && action === 'getStaffBalance') {
        return { available: 50.0, pending: 0, withdrawn: 0 }
      }
      return {}
    }
  })

  // 1. 冷启动无缓存时，处于骨架预加载状态
  assert.equal(page.data.loadingProfile, true)
  // 必须为空，不能暴露误导用户的“未入驻”
  assert.notEqual(page.data.statusTitle, '未入驻')
  assert.equal(page.data.profile, null)

  // 2. 接口调用完成
  await page.loadProfile()

  assert.equal(page.data.loadingProfile, false)
  assert.equal(page.data.statusTitle, '认证宠托师')
  assert.equal(page.data.balance.availableText, '50.00')

  // 3. 验证已成功写入缓存供下次秒开
  const saved = storage.get('staff_profile_display_cache_v1')
  assert.ok(saved)
  assert.equal(saved.profile.staffLevel, 'certified')
})

test('staff profile WXML contains skeleton loading structure for hero, wallet, and config cards', () => {
  const wxml = fs.readFileSync(path.join(root, 'pages/staff/profile/index.wxml'), 'utf8')
  // 验证骨架屏类名存在
  assert.match(wxml, /staff-hero-skeleton/)
  assert.match(wxml, /skeleton-wallet-card/)
  assert.match(wxml, /skeleton-config-card/)
  // 验证在没有 statusTitle 时不强行显示空粉色徽章
  assert.match(wxml, /wx:if="\{\{statusTitle\}\}"/)
})
