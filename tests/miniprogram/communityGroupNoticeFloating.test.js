const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

function pageAt(relativePath, bindings = {}) {
  const file = path.resolve(__dirname, '../../miniprogram', relativePath)
  const localRequire = createRequire(file)
  let pageOptions = null
  const storage = bindings.storage || new Map()
  const toasts = []

  const wx = {
    getStorageSync: (k) => storage.get(k),
    setStorageSync: (k, v) => storage.set(k, v),
    showToast: (o) => toasts.push(o),
    navigateTo: () => {},
    createIntersectionObserver: () => ({ relativeToViewport: () => ({ observe: () => {} }) }),
    ...bindings.wx
  }

  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Page(options) {
      pageOptions = options
    },
    require(name) {
      if (name.endsWith('/cloud')) {
        return {
          getCurrentUser: bindings.getCurrentUser || (async () => null),
          callFunction: bindings.callFunction || (async () => ({})),
          getCachedSystemSettings: () => ({}),
          loadSystemSettings: () => Promise.resolve({}),
          getSelectedLocation: () => null,
          chooseSelectedLocation: async () => ({}),
          showError: () => {},
          ensureLogin: async () => ({})
        }
      }
      if (name.endsWith('/theme')) {
        return {
          applyTheme: () => ({ value: 'day' }),
          getThemeState: () => ({ themeClass: 'theme-day' })
        }
      }
      if (name.endsWith('/hero-media') || name.endsWith('/client-nav') || name.endsWith('/nav')) {
        return {
          loadMessageUnread: () => {},
          getCachedHeroMedia: () => null,
          resolveHeroMedia: () => {},
          safeNavigateTo: () => {}
        }
      }
      return localRequire(name)
    },
    wx,
    getApp: () => ({ globalData: {} }),
    clearTimeout,
    setTimeout
  })

  const page = {
    ...pageOptions,
    data: JSON.parse(JSON.stringify(pageOptions.data))
  }

  page.setData = function (patch) {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.')
      let target = this.data
      for (const part of parts.slice(0, -1)) {
        if (!target[part]) target[part] = {}
        target = target[part]
      }
      target[parts[parts.length - 1]] = value
    }
  }

  return { page, storage, toasts }
}

test('同小区拼单浮窗: 界面元素与不挤占正文样式校验', () => {
  const wxml = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/client/home/index.wxml'), 'utf8')
  assert.match(wxml, /home-group-notice-wrapper/)
  assert.match(wxml, /notice-close-btn/)
  assert.match(wxml, /dismissGroupNotice/)
  assert.match(wxml, /notice-today-btn/)
  assert.match(wxml, /dismissGroupNoticeToday/)
  assert.match(wxml, /今日不再显示/)

  const wxss = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/client/home/index.wxss'), 'utf8')
  // 必须使用 fixed 悬浮定位，绝不能普通流挤压页面原本元素
  assert.match(wxss, /position:\s*fixed/)
  // 必须具备半透明毛玻璃质感
  assert.match(wxss, /backdrop-filter:\s*blur/)
})

test('同小区拼单浮窗: 点击取消图标能够关闭本次显示', async () => {
  const mockNotice = { communityName: '翠湖花园', availableCount: 2, myGroups: [] }
  const { page } = pageAt('pages/client/home/index.js', {
    getCurrentUser: async () => ({ openid: 'u1' }),
    callFunction: async () => mockNotice
  })

  page._isPageActive = true
  await page.loadCommunityGroups()
  assert.equal(page.data.showCommunityGroupNotice, true)
  assert.equal(page.data.communityGroupNotice.availableCount, 2)

  // 点击关闭
  page.dismissGroupNotice()
  assert.equal(page.data.showCommunityGroupNotice, false)
  assert.equal(page.data.groupNoticeDismissed, true)
})

test('同小区拼单浮窗: 点击今日不再显示则记录日期，当日刷新与进入均不弹窗', async () => {
  const mockNotice = { communityName: '翠湖花园', availableCount: 3, myGroups: [] }
  const storage = new Map()
  const { page, toasts } = pageAt('pages/client/home/index.js', {
    getCurrentUser: async () => ({ openid: 'u1' }),
    callFunction: async () => mockNotice,
    storage
  })

  page._isPageActive = true
  await page.loadCommunityGroups()
  assert.equal(page.data.showCommunityGroupNotice, true)

  // 点击“今日不再显示”
  page.dismissGroupNoticeToday()
  assert.equal(page.data.showCommunityGroupNotice, false)
  assert.equal(toasts.some((t) => t.title.includes('今日将不再提示')), true)

  // 验证 storage 写入了当天日期
  const todayStr = new Date().toISOString().slice(0, 10)
  assert.equal(storage.get('dismiss_community_group_notice_date'), todayStr)

  // 模拟重新进入页面或下一次轮询，验证依然保持不显示
  const newSession = pageAt('pages/client/home/index.js', {
    getCurrentUser: async () => ({ openid: 'u1' }),
    callFunction: async () => mockNotice,
    storage
  })
  newSession.page._isPageActive = true
  newSession.page.onShow()
  assert.equal(newSession.page.data.showCommunityGroupNotice, false)

  await newSession.page.loadCommunityGroups()
  assert.equal(newSession.page.data.showCommunityGroupNotice, false)
})
