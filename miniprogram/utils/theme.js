const THEME_STORAGE_KEY = 'vip_pet_theme'

const themeOptions = [
  { label: '白天', value: 'day', className: 'theme-day', navBackground: '#FFF8EC', navText: 'black' },
  { label: '黑夜', value: 'night', className: 'theme-night', navBackground: '#17151f', navText: 'white' }
]

function getThemeOption(themeKey) {
  return themeOptions.find((item) => item.value === themeKey) || themeOptions[0]
}

function normalizeThemeKey(themeKey) {
  return getThemeOption(themeKey).value
}

function getThemeIndex(themeKey) {
  const normalized = normalizeThemeKey(themeKey)
  return Math.max(themeOptions.findIndex((item) => item.value === normalized), 0)
}

function getSavedThemeKey() {
  return normalizeThemeKey(wx.getStorageSync(THEME_STORAGE_KEY) || 'day')
}

function setGlobalTheme(themeKey) {
  const option = getThemeOption(themeKey)
  const app = getApp()
  if (app && !app.globalData) app.globalData = {}
  if (app && app.globalData) app.globalData.themeKey = option.value
  return option
}

let lastAppliedTheme = null

function applyTheme(themeKey, animate = false) {
  const option = setGlobalTheme(themeKey || getSavedThemeKey())
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
  const option = getThemeOption(themeKey)
  wx.setStorageSync(THEME_STORAGE_KEY, option.value)
  return applyTheme(option.value, true)
}

function getThemeState(themeKey) {
  const option = getThemeOption(themeKey || getSavedThemeKey())
  return {
    themeKey: option.value,
    themeClass: option.className,
    themeIndex: getThemeIndex(option.value),
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
