const THEME_STORAGE_KEY = 'vip_pet_theme'

const themeOptions = [
  { label: '白天', value: 'day', className: 'theme-day', navBackground: '#FFF8EC', navText: 'black' },
  { label: '黑夜', value: 'night', className: 'theme-night', navBackground: '#17151f', navText: 'white' },
  { label: '阳光', value: 'sunshine', className: 'theme-sunshine', navBackground: '#fff6d8', navText: 'black' },
  { label: '温暖', value: 'warm', className: 'theme-warm', navBackground: '#fff2e8', navText: 'black' }
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

function applyTheme(themeKey) {
  const option = setGlobalTheme(themeKey || getSavedThemeKey())
  wx.setNavigationBarColor({
    frontColor: option.navText === 'white' ? '#ffffff' : '#000000',
    backgroundColor: option.navBackground,
    animation: { duration: 180, timingFunc: 'easeIn' }
  })
  return option
}

function saveTheme(themeKey) {
  const option = getThemeOption(themeKey)
  wx.setStorageSync(THEME_STORAGE_KEY, option.value)
  return applyTheme(option.value)
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
