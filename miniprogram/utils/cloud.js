const { envList } = require('../envList')

function getCloudEnv() {
  const app = getApp()
  if (app && !app.globalData) app.globalData = {}
  const globalData = app && app.globalData ? app.globalData : {}
  const env = globalData.env || (envList[0] && envList[0].envId ? envList[0].envId : '')
  if (env && app && app.globalData && !app.globalData.env) {
    app.globalData.env = env
    if (wx.cloud) wx.cloud.init({ env, traceUser: true })
  }
  return env
}

function callFunction(name, action, data = {}) {
  const env = getCloudEnv()

  if (!env) {
    return Promise.reject(new Error('请先在 miniprogram/envList.js 配置云开发环境 ID'))
  }

  return wx.cloud.callFunction({
    name: 'api',
    data: {
      module: name,
      action,
      data
    }
  }).then((res) => {
    const result = res.result || {}
    if (!result.ok) {
      const err = new Error(result.message || '云函数调用失败')
      err.code = result.code || ''
      err.details = result.details || null
      err.module = name
      err.action = action
      // session 失效时清除缓存，下次操作重新验证
      if (result.message && result.message.includes('登录')) {
        setCachedUser(null)
      }
      throw err
    }
    return result.data
  })
}

function showError(error) {
  const message = error && (error.message || error.errMsg) || ''
  if (!message || message.includes('cancel') || message.includes('canceled')) {
    return
  }
  const title = message.includes('collection.get') || message.includes('-501003')
    ? '请先在云开发中创建数据库集合并部署 api 云函数'
    : message
  const shouldUseModal = title.length > 18 || /AI|模型|图片|照片|云开发/.test(title)
  if (shouldUseModal) {
    wx.showModal({
      title: '操作失败',
      content: title,
      showCancel: false
    })
    return
  }
  wx.showToast({
    title,
    icon: 'none'
  })
}

const LOCATION_STORAGE_KEY = 'vip_pet_selected_location'
const SYSTEM_SETTINGS_STORAGE_KEY = 'vip_pet_system_settings'

function normalizeLocation(location) {
  const source = location || {}
  const latitude = Number(source.latitude || 0)
  const longitude = Number(source.longitude || 0)
  if (!latitude || !longitude) return null
  return {
    name: source.name || source.locationName || '已选择位置',
    address: source.address || source.locationTip || '',
    latitude,
    longitude,
    accuracy: Number(source.accuracy || 0),
    updatedAt: source.updatedAt || Date.now()
  }
}

function getSelectedLocation() {
  return normalizeLocation(wx.getStorageSync(LOCATION_STORAGE_KEY) || {})
}

function saveSelectedLocation(location) {
  const normalized = normalizeLocation({ ...location, updatedAt: Date.now() })
  if (!normalized) return null
  wx.setStorageSync(LOCATION_STORAGE_KEY, normalized)
  const app = getApp()
  if (app && app.globalData) app.globalData.selectedLocation = normalized
  return normalized
}

function normalizeHomeHeroCarousel(carousel = {}) {
  const source = typeof carousel === 'object' && carousel !== null ? carousel : {}
  const rawItems = Array.isArray(source.items) ? source.items : []
  const items = rawItems
    .map((item, index) => {
      const type = item && item.type === 'video' ? 'video' : 'image'
      const fileId = String(item && item.fileId || '').trim()
      if (!fileId) return null
      return {
        id: String(item && item.id || '').trim() || `hero_${Date.now()}_${index}`,
        type,
        fileId,
        posterFileId: String(item && item.posterFileId || '').trim(),
        title: String(item && item.title || '').trim(),
        subtitle: String(item && item.subtitle || '').trim(),
        enabled: item && item.enabled !== false,
        sort: Number(item && item.sort) || (index + 1) * 10
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.sort - b.sort)

  const interval = Number(source.rotateIntervalMs || source.interval || 0)
  const rotateIntervalMs = interval >= 1000 ? Math.min(interval, 30000) : 5000

  return {
    enabled: source.enabled === true,
    autoRotate: source.autoRotate !== false,
    rotateIntervalMs,
    items
  }
}

function getCachedSystemSettings() {
  const cached = wx.getStorageSync(SYSTEM_SETTINGS_STORAGE_KEY) || {}
  return {
    enableTestAddressMode: cached.enableTestAddressMode === true,
    homeHeroCarousel: normalizeHomeHeroCarousel(cached.homeHeroCarousel)
  }
}

function setCachedSystemSettings(settings) {
  const source = settings || {}
  const normalized = {
    enableTestAddressMode: source.enableTestAddressMode === true,
    homeHeroCarousel: normalizeHomeHeroCarousel(source.homeHeroCarousel)
  }
  wx.setStorageSync(SYSTEM_SETTINGS_STORAGE_KEY, normalized)
  return normalized
}

function loadSystemSettings() {
  return callFunction('system', 'getSettings')
    .then(setCachedSystemSettings)
    .catch(() => getCachedSystemSettings())
}

function requirePrivacyAuthorize() {
  return new Promise((resolve, reject) => {
    if (typeof wx.requirePrivacyAuthorize !== 'function') {
      resolve()
      return
    }
    wx.requirePrivacyAuthorize({
      success: resolve,
      fail: reject
    })
  })
}

function openChooseLocation() {
  return new Promise((resolve, reject) => {
    wx.chooseLocation({
      success: (location) => {
        const saved = saveSelectedLocation(location)
        if (saved) resolve(saved)
        else reject(new Error('位置信息无效'))
      },
      fail: reject
    })
  })
}

function chooseSelectedLocation() {
  return loadSystemSettings().then((settings) => {
    if (settings.enableTestAddressMode) return openChooseLocation()
    return requirePrivacyAuthorize().then(openChooseLocation)
  })
}

function getCurrentLocation() {
  return new Promise((resolve, reject) => {
    wx.getLocation({
      type: 'gcj02',
      success: (location) => {
        const saved = saveSelectedLocation({ ...location, name: '当前位置' })
        if (saved) resolve(saved)
        else reject(new Error('位置信息无效'))
      },
      fail: reject
    })
  })
}

function confirmManualLocation() {
  return new Promise((resolve, reject) => {
    wx.showModal({
      title: '定位失败',
      content: '未能获取实时定位，可手动选择当前位置继续。',
      confirmText: '手动选择',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) resolve()
        else reject(new Error('未获取到定位，本次操作未提交'))
      },
      fail: reject
    })
  })
}

function getServiceLocation() {
  return loadSystemSettings().then((settings) => {
    if (settings.enableTestAddressMode) return openChooseLocation()
    return requirePrivacyAuthorize()
      .then(getCurrentLocation)
      .catch(() => confirmManualLocation().then(openChooseLocation))
  })
}

function requireSelectedLocation() {
  const saved = getSelectedLocation()
  if (saved) return Promise.resolve(saved)
  return chooseSelectedLocation()
}

const LOGIN_CANCEL_CODE = 'LOGIN_CANCELLED'
const AUTH_LOGGED_OUT_KEY = 'vip_pet_auth_logged_out'

function getAppData() {
  const app = getApp()
  if (app && !app.globalData) app.globalData = {}
  return app && app.globalData ? app.globalData : {}
}

function getCachedUser() {
  return getAppData().user || null
}

function setCachedUser(user) {
  const globalData = getAppData()
  globalData.user = user || null
  globalData.isGuest = !user
  globalData.authChecked = true
  if (user && user.activeRole) globalData.activeRole = user.activeRole
  if (user) wx.removeStorageSync(AUTH_LOGGED_OUT_KEY)
  return user || null
}

function logoutCurrentUser() {
  wx.setStorageSync(AUTH_LOGGED_OUT_KEY, true)
  const globalData = getAppData()
  globalData.user = null
  globalData.isGuest = true
  globalData.authChecked = true
  globalData.activeRole = 'client'
}

function isLoginRequiredError(error) {
  const message = error && error.message ? error.message : String(error || '')
  return message.includes('请先登录') || message.includes('登录') || error.code === LOGIN_CANCEL_CODE
}

function getCurrentUser(options = {}) {
  const cached = getCachedUser()
  if (cached) return Promise.resolve(cached)
  if (options.silent !== false && wx.getStorageSync(AUTH_LOGGED_OUT_KEY)) return Promise.resolve(null)
  return callFunction('auth', 'me')
    .then(setCachedUser)
    .catch((error) => {
      setCachedUser(null)
      if (options.silent !== false && isLoginRequiredError(error)) return null
      throw error
    })
}

function loginWithWechat() {
  wx.removeStorageSync(AUTH_LOGGED_OUT_KEY)
  return callFunction('auth', 'login').then(setCachedUser)
}

function showLoginModal(options = {}) {
  return new Promise((resolve, reject) => {
    wx.showModal({
      title: options.title || '需要登录',
      content: options.content || '登录后可继续操作。',
      confirmText: '微信登录',
      cancelText: '暂不登录',
      success: (res) => {
        if (res.confirm) resolve()
        else reject({ code: LOGIN_CANCEL_CODE, message: '已取消登录' })
      },
      fail: reject
    })
  })
}

function ensureLogin(options = {}) {
  const cached = getCachedUser()
  if (cached) return Promise.resolve(cached)
  return getCurrentUser({ silent: true })
    .then((user) => {
      if (user) return user
      return showLoginModal(options).then(() => {
        wx.navigateTo({ url: '/pages/client/profile/index' })
        throw { code: LOGIN_CANCEL_CODE, message: '请先完成微信登录' }
      })
    })
    .catch((error) => {
      if (error && error.code === LOGIN_CANCEL_CODE) throw error
      showError(error)
      throw error
    })
}

module.exports = {
  getCloudEnv,
  callFunction,
  showError,
  getSelectedLocation,
  saveSelectedLocation,
  requirePrivacyAuthorize,
  loadSystemSettings,
  setCachedSystemSettings,
  getCachedSystemSettings,
  chooseSelectedLocation,
  requireSelectedLocation,
  getServiceLocation,
  getCachedUser,
  setCachedUser,
  logoutCurrentUser,
  getCurrentUser,
  loginWithWechat,
  ensureLogin,
  isLoginRequiredError
}
