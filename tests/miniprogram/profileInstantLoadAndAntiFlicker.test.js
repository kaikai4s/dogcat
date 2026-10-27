const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '../../miniprogram')

function createProfilePage(options = {}) {
  const {
    cachedUser = null,
    cachedDisplay = {},
    callFunctionMock = async () => ({})
  } = options

  let pageConfig = null
  const storage = new Map()

  const mockDisplayCache = {
    scopeKey: (env, user) => user?._id ? JSON.stringify([String(env || ''), String(user._id)]) : '',
    readDisplay: (scope) => cachedDisplay[scope] || {},
    writeDisplay: (scope, kind, val) => {},
    pickSummary: (val = {}) => ({
      points: val.points !== null && val.points !== undefined ? Number(val.points) : null,
      memberLevelName: val.memberLevelName || '',
      badgeTag: val.badgeTag || '',
      badgeStyle: val.badgeStyle || '',
      nameColor: val.nameColor || '',
      nameEffect: val.nameEffect || '',
      pointMultiplier: val.pointMultiplier !== null && val.pointMultiplier !== undefined ? Number(val.pointMultiplier) : null,
      retroCardCount: val.retroCardCount !== null && val.retroCardCount !== undefined ? Number(val.retroCardCount) : null,
      levelDescription: val.levelDescription || ''
    }),
    getAvatar: () => '',
    resolveAvatar: (scope, src) => Promise.resolve(src)
  }

  const cloudMock = {
    getCachedUser: () => cachedUser,
    getCloudEnv: () => 'test-env',
    getCurrentUser: async () => cachedUser,
    subscribeIdentityChange: () => () => {},
    callFunction: callFunctionMock,
    loginWithWechat: async () => cachedUser,
    ensureLogin: async () => cachedUser,
    logoutCurrentUser: () => {},
    showError: () => {}
  }

  const code = fs.readFileSync(path.join(root, 'pages/client/profile/index.js'), 'utf8')

  vm.runInNewContext(code, {
    Page: config => { pageConfig = config },
    require: modulePath => {
      if (modulePath.includes('display-cache')) return mockDisplayCache
      if (modulePath.includes('utils/cloud')) return cloudMock
      if (modulePath.includes('theme')) return { themeOptions: [], applyTheme: () => ({ value: 'day' }), saveTheme: () => {}, getThemeState: () => ({}) }
      if (modulePath.includes('font')) return { fontOptions: [], applyFont: () => ({ value: 'system' }), saveFont: () => {}, getFontState: () => ({}) }
      if (modulePath.includes('clipboard')) return { copyText: () => {} }
      return {}
    },
    wx: {
      getStorageSync: key => storage.get(key),
      setStorageSync: (key, val) => storage.set(key, val),
      setNavigationBarTitle: () => {},
      stopPullDownRefresh: () => {},
      showToast: () => {},
      showModal: () => {}
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
  return { page, setDataLog }
}

test('profile page instant load: pre-populates data from cache with zero blank avatar and zero null flicker', () => {
  const cachedUser = {
    _id: 'user_123',
    nickname: '柴犬小八',
    avatarUrl: 'https://example.com/avatar.jpg',
    phone: '13800138000'
  }
  const scope = JSON.stringify(['test-env', 'user_123'])
  const cachedDisplay = {
    [scope]: {
      summary: {
        points: 1000,
        memberLevelName: '最终等级·霓虹彩虹',
        pointMultiplier: 2.5,
        retroCardCount: 3,
        badgeTag: 'SVIP',
        badgeStyle: 'rainbow',
        levelDescription: '尊贵会员专享'
      }
    }
  }

  const { page } = createProfilePage({ cachedUser, cachedDisplay })

  // 1. 验证首屏实例化阶段已直接填充有效数据，非游客
  assert.equal(page.data.isGuest, false)
  assert.equal(page.data.avatarUrl, 'https://example.com/avatar.jpg')
  assert.equal(page.data.userName, '柴犬小八')
  assert.equal(page.data.memberLevelName, '最终等级·霓虹彩虹')
  assert.equal(page.data.points, 1000)
  assert.equal(page.data.pointMultiplier, 2.5)
  assert.equal(page.data.retroCardCount, 3)
  assert.equal(page.data.badgeTag, 'SVIP')
})

test('profile page applyUser does not reset state with applyGuest on same user', () => {
  const cachedUser = {
    _id: 'user_123',
    nickname: '柴犬小八',
    avatarUrl: 'https://example.com/avatar.jpg'
  }
  const { page, setDataLog } = createProfilePage({ cachedUser })

  page.onLoad()
  page.restoreIdentity()

  // 确保没有被重置为 isGuest: true
  assert.equal(page.data.isGuest, false)
  assert.equal(page.data.avatarUrl, 'https://example.com/avatar.jpg')
  // 确保没有把 userName 重置为 '游客'
  assert.notEqual(page.data.userName, '游客')
})

test('profile page loadPoints diff update avoids redundant setData when values match cache', async () => {
  const cachedUser = { _id: 'user_123', nickname: '柴犬小八' }
  const scope = JSON.stringify(['test-env', 'user_123'])
  const cachedDisplay = {
    [scope]: {
      summary: {
        points: 1000,
        memberLevelName: '最终等级·霓虹彩虹',
        pointMultiplier: 2.5,
        retroCardCount: 3,
        badgeTag: 'SVIP'
      }
    }
  }

  let callAction = ''
  const { page, setDataLog } = createProfilePage({
    cachedUser,
    cachedDisplay,
    callFunctionMock: async (name, action) => {
      callAction = action
      if (action === 'myInfo') {
        return {
          points: 1000,
          memberLevelName: '最终等级·霓虹彩虹',
          pointMultiplier: 2.5,
          retroCardCount: 3,
          currentLevel: { badgeTag: 'SVIP' }
        }
      }
      return {}
    }
  })

  page.onLoad()
  setDataLog.length = 0

  await page.loadPoints()

  assert.equal(callAction, 'myInfo')
  // 因为接口返回的数值与缓存完全一致，diff 为空，不产生多余的 setData
  const hasDiffSetData = setDataLog.some(patch => patch.points !== undefined || patch.memberLevelName !== undefined)
  assert.equal(hasDiffSetData, false)
})

test('profile WXML guards against raw null strings in growth benefits', () => {
  const wxml = fs.readFileSync(path.join(root, 'pages/client/profile/index.wxml'), 'utf8')
  // 不能出现未防护的 "{{pointMultiplier}} 倍积分"
  assert.doesNotMatch(wxml, /\{\{pointMultiplier\}\}\s*倍积分/)
  // 不能出现未防护的 "补签卡 {{retroCardCount}} 张"
  assert.doesNotMatch(wxml, /补签卡\s*\{\{retroCardCount\}\}\s*张/)
  // 必须包含防空防御或三元表达式
  assert.match(wxml, /pointMultiplier !== null/)
  assert.match(wxml, /retroCardCount !== null/)
  // 头像必须包含 binderror 容错处理
  assert.match(wxml, /binderror="onMainAvatarError"/)
})
