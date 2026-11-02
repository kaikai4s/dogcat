const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '../../miniprogram')

test('首页自定义导航栏配置: navigationStyle 为 custom', () => {
  const jsonContent = fs.readFileSync(path.join(root, 'pages/client/home/index.json'), 'utf8')
  const config = JSON.parse(jsonContent)
  assert.equal(config.navigationStyle, 'custom', '首页必须开启自定义导航栏 custom')
  assert.equal(config.navigationBarTextStyle, 'black')
})

test('首页自定义导航栏 WXML 与 WXSS: 包含品牌小狗Logo、白橙色渐变平滑过渡、特效文字、吸顶毛玻璃与分割线', () => {
  const wxml = fs.readFileSync(path.join(root, 'pages/client/home/index.wxml'), 'utf8')
  const wxss = fs.readFileSync(path.join(root, 'pages/client/home/index.wxss'), 'utf8')

  // 1. WXML 结构
  assert.match(wxml, /class="[^"]*custom-nav-bar/)
  assert.match(wxml, /nav-brand-dog-img/)
  assert.match(wxml, /dovlin-logo-dog\.png/)
  assert.match(wxml, /多芙琳/)
  assert.match(wxml, /Dovelin/)
  assert.match(wxml, /nav-sparkle-star/)
  assert.doesNotMatch(wxml, /nav-bar-placeholder/)
  assert.match(wxml, /nav-bar-height="\{\{navBarHeight/)

  // 2. WXSS 顶部未下滑状态：白橙色渐变与页面背景连成一整块、无分割线、无阴影
  assert.match(wxss, /\.custom-nav-bar\.nav-at-top\s*\{[^}]*background:\s*linear-gradient\(180deg,\s*#ffe7cb/)
  assert.match(wxss, /\.custom-nav-bar\.nav-at-top\s*\{[^}]*border-bottom:\s*1rpx solid transparent/)
  assert.match(wxss, /\.client-home-page\s*\{[^}]*background:\s*linear-gradient\(180deg,\s*#ffe7cb/)
  assert.match(wxss, /\.home-hero-section\s*\{[^}]*linear-gradient\(180deg,\s*#ffe7cb/)

  // 3. WXSS 下滑状态：毛玻璃、细微分割线、阴影
  assert.match(wxss, /\.custom-nav-bar\.nav-scrolled\s*\{[^}]*backdrop-filter:\s*blur/)
  assert.match(wxss, /\.custom-nav-bar\.nav-scrolled\s*\{[^}]*border-bottom:\s*1rpx solid/)

  // 4. 文字特效与星芒动效
  assert.match(wxss, /background:\s*linear-gradient/)
  assert.match(wxss, /-webkit-background-clip:\s*text/)
  assert.match(wxss, /@keyframes sparkleBlink/)

  // 5. 下拉刷新组件与页面配置完全适配白橙暖色背景
  const refreshWxml = fs.readFileSync(path.join(root, 'components/dovlin-refresh/index.wxml'), 'utf8')
  const refreshWxss = fs.readFileSync(path.join(root, 'components/dovlin-refresh/index.wxss'), 'utf8')
  assert.match(refreshWxml, /refresher-background="\{\{background\}\}"/)
  assert.match(refreshWxss, /\.dovlin-refresher-container\s*\{[^}]*background:\s*#FFE7CB/)
  assert.match(wxml, /<dovlin-refresh[^>]*background="#FFE7CB"/)
})

test('首页自定义导航栏交互逻辑: 胶囊适配、滚动阈值切换 isNavScrolled 与一键回滚顶部', async () => {
  let pageConfig = null
  let scrolledToTopCalled = false
  let pageScrollToArgs = null

  const mockWx = {
    getWindowInfo: () => ({ statusBarHeight: 48 }),
    getMenuButtonBoundingClientRect: () => ({
      top: 52,
      bottom: 84,
      left: 280,
      right: 367,
      width: 87,
      height: 32
    }),
    pageScrollTo: (opts) => {
      pageScrollToArgs = opts
    },
    getStorageSync: () => null,
    setStorageSync: () => {},
    stopPullDownRefresh: () => {}
  }

  const mockDeps = {
    getSelectedLocation: () => null,
    chooseSelectedLocation: () => {},
    callFunction: async () => ({}),
    showError: () => {},
    ensureLogin: async () => ({}),
    getCurrentUser: async () => null,
    getCachedSystemSettings: () => ({}),
    loadSystemSettings: async () => ({}),
    loadMessageUnread: () => {},
    startStaffEntryUnread: () => {},
    stopStaffEntryUnread: () => {},
    applyTheme: () => ({}),
    getThemeState: () => ({}),
    safeNavigateTo: () => {},
    formatDateTime: () => ''
  }

  const mockHeroMedia = {
    getCachedHeroMedia: () => null,
    resolveHeroMedia: async () => null
  }

  const context = {
    Page(cfg) {
      pageConfig = cfg
    },
    wx: mockWx,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    require: (pkg) => {
      if (pkg.includes('hero-media')) return mockHeroMedia
      return mockDeps
    }
  }

  const jsCode = fs.readFileSync(path.join(root, 'pages/client/home/index.js'), 'utf8')
  vm.runInNewContext(jsCode, context)

  const page = {
    ...pageConfig,
    data: { ...pageConfig.data },
    setData(patch, cb) {
      Object.assign(this.data, patch)
      if (typeof cb === 'function') cb()
    },
    selectComponent(selector) {
      if (selector === '#dovlinRefresh') {
        return {
          scrollToTop: () => {
            scrolledToTopCalled = true
          }
        }
      }
      return null
    }
  }

  // 1. 初始化导航栏尺寸
  page.onLoad()
  assert.equal(page.data.statusBarHeight, 48)
  // titleBarHeight = (52 - 48) * 2 + 32 = 40
  assert.equal(page.data.titleBarHeight, 40)
  assert.equal(page.data.navBarHeight, 88)
  assert.equal(page.data.isNavScrolled, false)

  // 2. 顶部微小滚动 (<= 15px)，仍处于 nav-at-top
  page.onHomeScroll({ detail: { scrollTop: 10 } })
  assert.equal(page.data.isNavScrolled, false)
  assert.equal(page.data.pageScrollTop, 10)

  // 3. 向下滑动超过阈值 (> 15px)，自动切换为 nav-scrolled 吸顶与分割线模式
  page.onHomeScroll({ detail: { scrollTop: 60 } })
  assert.equal(page.data.isNavScrolled, true)
  assert.equal(page.data.pageScrollTop, 60)

  // 4. 原生页面滚动事件也可触发同样平滑切换
  page.onPageScroll({ scrollTop: 5 })
  assert.equal(page.data.isNavScrolled, false)
  assert.equal(page.data.pageScrollTop, 5)

  page.onPageScroll({ scrollTop: 120 })
  assert.equal(page.data.isNavScrolled, true)

  // 5. 点击导航栏 Logo 区域，能够平滑滚回顶部
  page.onNavLogoTap()
  assert.equal(scrolledToTopCalled, true, '应当调用 refresh 组件的 scrollToTop 平滑回顶')
})
