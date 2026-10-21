const THEME_STORAGE_KEY = 'vip_pet_theme'

const themeOptions = [
  { label: '默认', value: 'day', className: 'theme-day', navBackground: '#FFF8EC', navText: 'black' }
]

function getThemeOption(themeKey) {
  return themeOptions[0]
}

function normalizeThemeKey(themeKey) {
  return 'day'
}

function getThemeIndex(themeKey) {
  return 0
}

function getSavedThemeKey() {
  return 'day'
}

function setGlobalTheme(themeKey) {
  const option = getThemeOption('day')
  const app = typeof getApp === 'function' ? getApp() : null
  if (app && !app.globalData) app.globalData = {}
  if (app && app.globalData) app.globalData.themeKey = option.value
  return option
}

let lastAppliedTheme = null

function applyTheme(themeKey, animate = false) {
  const option = setGlobalTheme('day')
  if (typeof wx !== 'undefined' && typeof wx.setNavigationBarColor === 'function') {
    const shouldAnimate = Boolean(animate && lastAppliedTheme && lastAppliedTheme !== option.value)
    lastAppliedTheme = option.value
    try {
      wx.setNavigationBarColor({
        frontColor: option.navText === 'white' ? '#ffffff' : '#000000',
        backgroundColor: option.navBackground,
        animation: shouldAnimate ? { duration: 180, timingFunc: 'easeIn' } : { duration: 0 }
      })
    } catch (_) {}
  }
  return option
}

function saveTheme(themeKey) {
  const option = getThemeOption('day')
  if (typeof wx !== 'undefined' && typeof wx.setStorageSync === 'function') {
    try {
      wx.setStorageSync(THEME_STORAGE_KEY, option.value)
    } catch (_) {}
  }
  return applyTheme(option.value, true)
}

function getThemeState(themeKey) {
  const option = getThemeOption('day')
  return {
    themeKey: option.value,
    themeClass: option.className,
    themeIndex: 0,
    themeName: option.label
  }
}

module.exports = {
  themeOptions,
  getThemeOption,
  normalizeThemeKey,
  getThemeIndex,
  getSavedThemeKey,
  getThemeState,
  applyTheme,
  saveTheme
}
