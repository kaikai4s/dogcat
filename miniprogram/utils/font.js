const FONT_STORAGE_KEY = 'vip_pet_font'

const fontOptions = [
  {
    label: '系统默认',
    value: 'system',
    className: 'font-system'
  },
  {
    label: '圆润可爱',
    value: 'rounded',
    className: 'font-rounded'
  },
  {
    label: '清爽阅读',
    value: 'clean',
    className: 'font-clean'
  },
  {
    label: '典雅宋体',
    value: 'serif',
    className: 'font-serif'
  },
  {
    label: '手账风',
    value: 'cute',
    className: 'font-cute'
  }
]

function getFontOption(fontKey) {
  return fontOptions.find((item) => item.value === fontKey) || fontOptions[0]
}

function normalizeFontKey(fontKey) {
  return getFontOption(fontKey).value
}

function getFontIndex(fontKey) {
  const normalized = normalizeFontKey(fontKey)
  return Math.max(fontOptions.findIndex((item) => item.value === normalized), 0)
}

function getSavedFontKey() {
  return normalizeFontKey(wx.getStorageSync(FONT_STORAGE_KEY) || 'system')
}

function setGlobalFont(fontKey) {
  const option = getFontOption(fontKey)
  const app = getApp()
  if (app && !app.globalData) app.globalData = {}
  if (app && app.globalData) app.globalData.fontKey = option.value
  return option
}

function applyFont(fontKey) {
  return setGlobalFont(fontKey || getSavedFontKey())
}

function saveFont(fontKey) {
  const option = getFontOption(fontKey)
  wx.setStorageSync(FONT_STORAGE_KEY, option.value)
  return applyFont(option.value)
}

function getFontState(fontKey) {
  const option = getFontOption(fontKey || getSavedFontKey())
  return {
    fontKey: option.value,
    fontClass: option.className,
    fontIndex: getFontIndex(option.value),
    fontName: option.label
  }
}

module.exports = {
  fontOptions,
  getFontOption,
  normalizeFontKey,
  getFontIndex,
  getSavedFontKey,
  getFontState,
  applyFont,
  saveFont
}
