// app.js
const { envList } = require('./envList')
const { getSavedThemeKey, applyTheme, getThemeState } = require('./utils/theme')
const { getSavedFontKey, applyFont, getFontState } = require('./utils/font')

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

App({
  onLaunch() {
    const env = envList[0] && envList[0].envId ? envList[0].envId : ''

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
