const FONT_STORAGE_KEY = 'vip_pet_font'
const loadedFontFaces = {}

const fontOptions = [
  {
    label: '默认清爽',
    value: 'system',
    className: 'font-system',
    bodyFamily: 'AppSystemFont',
    titleFamily: 'AppSystemTitleFont',
    remoteUrl: '',
    titleRemoteUrl: ''
  },
  {
    label: '软萌圆体',
    value: 'rounded',
    className: 'font-rounded',
    bodyFamily: 'AppRoundedFont',
    titleFamily: 'AppRoundedTitleFont',
    remoteUrl: '',
    titleRemoteUrl: ''
  },
  {
    label: '国风楷体',
    value: 'clean',
    className: 'font-clean',
    bodyFamily: 'AppKaiFont',
    titleFamily: 'AppKaiTitleFont',
    remoteUrl: '',
    titleRemoteUrl: ''
  },
  {
    label: '典雅宋韵',
    value: 'serif',
    className: 'font-serif',
    bodyFamily: 'AppSongFont',
    titleFamily: 'AppSongTitleFont',
    remoteUrl: '',
    titleRemoteUrl: ''
  },
  {
    label: '手账花体',
    value: 'cute',
    className: 'font-cute',
    bodyFamily: 'AppCuteFont',
    titleFamily: 'AppCuteTitleFont',
    remoteUrl: '',
    titleRemoteUrl: ''
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

function loadRemoteFontFace(family, url) {
  if (!family || !url || loadedFontFaces[family]) return Promise.resolve()
  if (typeof wx === 'undefined' || typeof wx.loadFontFace !== 'function') return Promise.resolve()
  loadedFontFaces[family] = 'loading'
  return new Promise((resolve) => {
    wx.loadFontFace({
      family,
      source: `url("${url}")`,
      global: true,
      success: () => {
        loadedFontFaces[family] = 'loaded'
        resolve()
      },
      fail: () => {
        loadedFontFaces[family] = 'failed'
        resolve()
      }
    })
  })
}

function loadFontAssets(option) {
  return Promise.all([
    loadRemoteFontFace(option.bodyFamily, option.remoteUrl),
    loadRemoteFontFace(option.titleFamily, option.titleRemoteUrl || option.remoteUrl)
  ])
}

function setGlobalFont(fontKey) {
  const option = getFontOption(fontKey)
  const app = getApp()
  if (app && !app.globalData) app.globalData = {}
  if (app && app.globalData) app.globalData.fontKey = option.value
  loadFontAssets(option)
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
    fontName: option.label,
    fontPreviewText: option.value === 'system' ? '默认清爽' : '花体预览 · 毛孩安心'
  }
}

module.exports = {
  fontOptions,
  getFontOption,
  normalizeFontKey,
  getFontIndex,
  getSavedFontKey,
  getFontState,
  loadFontAssets,
  applyFont,
  saveFont
}
