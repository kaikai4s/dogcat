// app.js
const { envList, getActiveEnvId } = require('./envList')
const { getSavedThemeKey, applyTheme, getThemeState } = require('./utils/theme')
const { getSavedFontKey, applyFont, getFontState } = require('./utils/font')
const { copyText } = require('./utils/clipboard')
require('./utils/format')
require('./utils/nav')
require('./utils/offlineQueue')

function installGlobalPreferencePagePatch() {
  if (typeof Page !== 'function' || Page.__preferencePatched) return
  const originalPage = Page
  Page = function patchedPage(options = {}) {
    const originalOnShow = options.onShow
    options.data = { themeClass: 'theme-day', fontClass: 'font-system', ...(options.data || {}) }
    options.onShow = function preferenceOnShow(...args) {
      const theme = applyTheme()
      const font = applyFont()
      this.setData({ ...getThemeState(theme.value), ...getFontState(font.value) })
      if (typeof originalOnShow === 'function') return originalOnShow.apply(this, args)
    }
    return originalPage(options)
  }
  Page.__preferencePatched = true
}

installGlobalPreferencePagePatch()
require('./utils/adminAccess').installAdminPageGuard()

App({
  copyText,
  onLaunch() {
    const env = (typeof getActiveEnvId === 'function' ? getActiveEnvId() : '') || (envList[0] && envList[0].envId ? envList[0].envId : '')

    this.globalData = {
      env,
      user: null,
      isGuest: true,
      authChecked: false,
      activeRole: 'client',
      selectedLocation: null,
      themeKey: getSavedThemeKey(),
      fontKey: getSavedFontKey(),
      lotteryFloatShownThisLaunch: false
    }

    applyTheme(this.globalData.themeKey)
    applyFont(this.globalData.fontKey)

    // 全局防页面栈 10 层溢出守护：检测到 getCurrentPages().length >= 9 时自动降级为 redirectTo
    if (typeof wx !== 'undefined' && wx.navigateTo && !wx.__safeNavigateToPatched) {
      const rawNavigateTo = wx.navigateTo
      wx.navigateTo = function patchedNavigateTo(options) {
        const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
        if (pages.length >= 9) {
          return wx.redirectTo(options)
        }
        return rawNavigateTo.call(wx, {
          ...options,
          fail: (err) => {
            const msg = (err && (err.errMsg || err.message)) || ''
            if (/limit exceed|exceed/i.test(msg)) {
              return wx.redirectTo(options)
            }
            if (options && typeof options.fail === 'function') {
              options.fail(err)
            }
          }
        })
      }
      wx.__safeNavigateToPatched = true
    }

    // 全局加载特效与防触控穿透：优先使用自定义萌宠加载特效（带全屏遮罩），无组件活跃时使用带 mask: true 的原生 showLoading
    if (typeof wx !== 'undefined' && wx.showLoading && !wx.__showLoadingMaskPatched) {
      const rawShowLoading = wx.showLoading
      let loadingBus
      try { loadingBus = require('./utils/loadingBus').loadingBus } catch (_) {}
      wx.showLoading = function patchedShowLoading(options = {}) {
        const opts = typeof options === 'string' ? { title: options } : (options || {})
        const title = opts.title || '加载中...'
        if (loadingBus && typeof loadingBus.show === 'function') {
          loadingBus.show({ title })
        }
        if (!loadingBus || !loadingBus.hasActiveListener()) {
          return rawShowLoading.call(wx, {
            title,
            mask: true,
            ...opts
          })
        }
      }
      wx.__showLoadingMaskPatched = true
    }

    // 全局安全 hideLoading：避免无活跃 loading 时的报错，并同步关闭自定义加载动画
    if (typeof wx !== 'undefined' && wx.hideLoading && !wx.__safeHideLoadingPatched) {
      const rawHideLoading = wx.hideLoading
      let loadingBus
      try { loadingBus = require('./utils/loadingBus').loadingBus } catch (_) {}
      wx.hideLoading = function safeHideLoading(options) {
        if (loadingBus && typeof loadingBus.hide === 'function') {
          try { loadingBus.hide() } catch (_) {}
        }
        try {
          return rawHideLoading.call(wx, options)
        } catch (_) {}
      }
      wx.__safeHideLoadingPatched = true
    }

    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力')
      return
    }

    wx.cloud.init({
      env,
      traceUser: true
    })
  },

  globalData: {
    env: '',
    user: null,
    isGuest: true,
    authChecked: false,
    activeRole: 'client',
    selectedLocation: null,
    themeKey: 'day',
    fontKey: 'system',
    lotteryFloatShownThisLaunch: false
  }
})
