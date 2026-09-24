const { envList } = require('../envList')
const { getSavedThemeKey, saveTheme } = require('./theme')
const { getSavedFontKey, saveFont } = require('./font')

const ENTRY_READ_TIMEOUT_MS = 15000
const entryReads = new Set(['auth.me', 'auth.checkSession', 'system.getHomePageData', 'system.getSettings', 'order.listServiceOptions', 'pet.listPets', 'client.listAddresses'])
const pendingEntryReads = new Set()
const pendingUserRequests = new Map()
let foregroundListenerInstalled = false
let authRevision = 0

function isCloudResultExpired(error) {
  return Number(error && (error.errCode || error.code)) === -404010 || /-404010|result expired|timeout for result fetching/i.test(error && (error.errMsg || error.message) || '')
}

function boundedEntryRead(invoke, name, action) {
  if (!foregroundListenerInstalled && typeof wx.onAppShow === 'function') {
    wx.onAppShow(() => pendingEntryReads.forEach((check) => check()))
    foregroundListenerInstalled = true
  }
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ENTRY_READ_TIMEOUT_MS
    let settled = false
    let timer
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      pendingEntryReads.delete(expire)
      if (error) reject(error)
      else resolve(value)
    }
    const expire = () => {
      if (Date.now() < deadline) return false
      const error = new Error('连接超时，请检查网络后重试')
      Object.assign(error, { code: 'ENTRY_READ_TIMEOUT', module: name, action })
      finish(error)
      return true
    }
    pendingEntryReads.add(expire)
    timer = setTimeout(expire, ENTRY_READ_TIMEOUT_MS)
    Promise.resolve().then(invoke).then(
      (value) => { if (!expire()) finish(null, value) },
      (error) => { if (!expire()) finish(error) }
    )
  })
}

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
  const requestAuthRevision = authRevision

  if (!env) {
    return Promise.reject(new Error('请先在 miniprogram/envList.js 配置云开发环境 ID'))
  }

  const invoke = () => wx.cloud.callFunction({
    name: 'api',
    data: {
      module: name,
      action,
      data
    }
  })
  const request = entryReads.has(`${name}.${action}`) ? boundedEntryRead(invoke, name, action) : invoke()
  return request.then((res) => {
    const result = res.result || {}
    if (!result.ok) {
      const err = new Error(result.message || '云函数调用失败')
      err.code = result.code || ''
      err.details = result.details || null
      err.module = name
      err.action = action
      // session 失效时清除缓存，下次操作重新验证
      if (result.message && result.message.includes('登录') && requestAuthRevision === authRevision) {
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
  const title = isCloudResultExpired(error)
    ? '连接已过期，请重试；如刚返回小程序，请重新打开页面。'
    : message.includes('collection.get') || message.includes('-501003')
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
    coordinateType: source.coordinateType || 'gcj02',
    locationSource: source.locationSource || 'unknown',
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

function normalizeSubscriptionConfig(subscription = {}) {
  const templates = subscription.templates || {}
  return {
    enabled: subscription.enabled === true,
    templates: {
      orderPaid: templates.orderPaid || '',
      orderAssigned: templates.orderAssigned || '',
      orderAccepted: templates.orderAccepted || '',
      serviceStart: templates.serviceStart || '',
      serviceFinish: templates.serviceFinish || '',
      remoteUnlock: templates.remoteUnlock || '',
      refundResult: templates.refundResult || '',
      disputeUpdate: templates.disputeUpdate || '',
      withdrawResult: templates.withdrawResult || '',
      upcomingServiceReminder: templates.upcomingServiceReminder || templates.serviceReminder || ''
    }
  }
}

function normalizeHomePageConfig(homePage = {}) {
  const defaultModules = {
    quickBooking: true,
    nearbySitters: true,
    repeatBooking: true,
    hotServices: true,
    newbieCoupon: true,
    featuredSitters: true,
    platformAssurance: true,
    historyStats: true,
    lottery: true
  }
  const modules = homePage.modules || {}
  return {
    ctaTitle: homePage.ctaTitle || '立即预约上门宠护',
    ctaSubtitle: homePage.ctaSubtitle || '填写宠物和服务时间，平台认证宠托师快速响应。',
    ctaText: homePage.ctaText || '立即预约',
    nearbyTitle: homePage.nearbyTitle || '附近宠托师',
    repeatTitle: homePage.repeatTitle || '一键复购',
    couponTitle: homePage.couponTitle || '新人优惠',
    assuranceTitle: homePage.assuranceTitle || '平台保障',
    modules: Object.keys(defaultModules).reduce((result, key) => ({ ...result, [key]: modules[key] !== false }), {})
  }
}

function getCachedSystemSettings() {
  const cached = wx.getStorageSync(SYSTEM_SETTINGS_STORAGE_KEY) || {}
  return {
    enableTestAddressMode: cached.enableTestAddressMode === true,
    enablePetBreedAi: cached.enablePetBreedAi !== false,
    subscription: normalizeSubscriptionConfig(cached.subscription),
    homeHeroCarousel: normalizeHomeHeroCarousel(cached.homeHeroCarousel),
    homePage: normalizeHomePageConfig(cached.homePage),
    staffSupplies: cached.staffSupplies || null
  }
}

function setCachedSystemSettings(settings) {
  const source = settings || {}
  const normalized = {
    enableTestAddressMode: source.enableTestAddressMode === true,
    enablePetBreedAi: source.enablePetBreedAi !== false,
    subscription: normalizeSubscriptionConfig(source.subscription),
    homeHeroCarousel: normalizeHomeHeroCarousel(source.homeHeroCarousel),
    homePage: normalizeHomePageConfig(source.homePage),
    staffSupplies: source.staffSupplies || null
  }
  wx.setStorageSync(SYSTEM_SETTINGS_STORAGE_KEY, normalized)
  return normalized
}

function loadSystemSettings() {
  return callFunction('system', 'getSettings')
    .then(setCachedSystemSettings)
    .catch(() => getCachedSystemSettings())
}

function requestSubscribeTemplates(templateKeys = [], scene = '', options = {}) {
  const requestWithSettings = (settings) => {
    const subscription = settings.subscription || {}
    if (!subscription.enabled) return Promise.resolve({ requested: false, reason: 'subscription_disabled' })
    if (typeof wx.requestSubscribeMessage !== 'function') return Promise.resolve({ requested: false, reason: 'request_api_unavailable' })
    const templates = subscription.templates || {}
    const resolveTemplateId = (key) => templates[key] || (key === 'upcomingServiceReminder' ? templates.serviceStart : '')
    const requestKeys = Array.from(new Set(templateKeys)).filter(resolveTemplateId)
    const tmplIds = Array.from(new Set(requestKeys.map(resolveTemplateId))).slice(0, 5)
    const limitedKeys = requestKeys.filter((key) => tmplIds.includes(resolveTemplateId(key)))
    if (!tmplIds.length) return Promise.resolve({ requested: false, reason: 'template_not_configured' })
    return new Promise((resolve) => {
      wx.requestSubscribeMessage({
        tmplIds,
        success: (res) => resolve({ requested: true, templateKeys: limitedKeys, templateIds: tmplIds, results: res || {} }),
        fail: (error) => resolve({ requested: false, reason: 'request_failed', errorCode: error && error.errCode, error: error && (error.errMsg || error.message) || '' })
      })
    }).then((result) => {
      if (!result.requested) return result
      const templateIds = {}
      limitedKeys.forEach((key) => { templateIds[key] = resolveTemplateId(key) })
      const recording = callFunction('system', 'recordSubscriptionConsent', { templateKeys: limitedKeys, templateIds, results: result.results, scene })
          .then(() => result)
          .catch(() => result)
      return options.waitForConsent === false ? result : recording
    })
  }

  // Prepared settings keep the native authorization call inside the tap gesture.
  if (options.settings) return requestWithSettings(options.settings)
  const cachedSettings = getCachedSystemSettings()
  const cachedSubscription = cachedSettings.subscription || {}
  const cachedTemplates = cachedSubscription.templates || {}
  const hasCachedTemplate = templateKeys.some((key) => cachedTemplates[key] || (key === 'upcomingServiceReminder' && cachedTemplates.serviceStart))
  if (cachedSubscription.enabled && hasCachedTemplate) return requestWithSettings(cachedSettings)
  return loadSystemSettings().then(requestWithSettings).catch((error) => ({ requested: false, reason: 'settings_load_failed', error: error && (error.message || error.errMsg) || '' }))
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
        const saved = saveSelectedLocation({ ...location, locationSource: 'manual' })
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
  return requirePrivacyAuthorize().then(() => {
    return new Promise((resolve, reject) => {
      wx.getLocation({
        type: 'gcj02',
        isHighAccuracy: true,
        highAccuracyExpireTime: 6000,
        success: (location) => {
          const saved = saveSelectedLocation({ ...location, name: '当前位置', locationSource: 'gps' })
          if (saved) resolve(saved)
          else reject(new Error('位置信息无效'))
        },
        fail: reject
      })
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
const PENDING_INVITE_KEY = 'vip_pet_pending_invite'

function getAppData() {
  const app = getApp()
  if (app && !app.globalData) app.globalData = {}
  return app && app.globalData ? app.globalData : {}
}

function getCachedUser() {
  return getAppData().user || null
}

function setCachedUser(user) {
  authRevision += 1
  pendingUserRequests.clear()
  const globalData = getAppData()
  globalData.user = user || null
  globalData.isGuest = !user
  globalData.authChecked = true
  if (user && user.activeRole) globalData.activeRole = user.activeRole
  if (user) {
    wx.removeStorageSync(AUTH_LOGGED_OUT_KEY)
    const themeKey = user.themeKey || (user.preferences && user.preferences.themeKey)
    const fontKey = user.fontKey || (user.preferences && user.preferences.fontKey)
    if (themeKey) saveTheme(themeKey)
    if (fontKey) saveFont(fontKey)
  }
  return user || null
}

function logoutCurrentUser() {
  authRevision += 1
  pendingUserRequests.clear()
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

function savePendingInvite(invite = {}) {
  const inviteCode = String(invite.inviteCode || '').trim()
  const inviterOpenid = String(invite.inviterOpenid || '').trim()
  if (!inviteCode && !inviterOpenid) return null
  const payload = { inviteCode, inviterOpenid, capturedAt: Date.now() }
  wx.setStorageSync(PENDING_INVITE_KEY, payload)
  return payload
}

function getPendingInvitePayload() {
  const invite = wx.getStorageSync(PENDING_INVITE_KEY) || {}
  const inviteCode = String(invite.inviteCode || '').trim()
  const inviterOpenid = String(invite.inviterOpenid || '').trim()
  return {
    ...(inviteCode ? { inviteCode } : {}),
    ...(inviterOpenid ? { inviterOpenid } : {})
  }
}

function clearPendingInvite() {
  wx.removeStorageSync(PENDING_INVITE_KEY)
}

function getCurrentUser(options = {}) {
  const cached = getCachedUser()
  if (cached) return Promise.resolve(cached)
  if (options.silent !== false && wx.getStorageSync(AUTH_LOGGED_OUT_KEY)) return Promise.resolve(null)
  const action = options.sessionOnly ? 'checkSession' : 'me'
  let pending = pendingUserRequests.get(action)
  if (!pending || pending.deadline <= Date.now()) {
    const revision = authRevision
    pending = { deadline: Date.now() + ENTRY_READ_TIMEOUT_MS }
    pending.promise = callFunction('auth', action)
      .then((user) => revision === authRevision ? setCachedUser(user) : getCachedUser())
      .finally(() => {
        if (pendingUserRequests.get(action) === pending) pendingUserRequests.delete(action)
      })
    pendingUserRequests.set(action, pending)
  }
  return pending.promise.catch((error) => {
    // Transport failures do not mean the user has logged out.
    if (options.silent !== false && isLoginRequiredError(error)) return null
    throw error
  })
}

function loginWithWechat(extraData = {}) {
  wx.removeStorageSync(AUTH_LOGGED_OUT_KEY)
  const inviteData = getPendingInvitePayload()
  return callFunction('auth', 'login', { themeKey: getSavedThemeKey(), fontKey: getSavedFontKey(), ...inviteData, ...extraData }).then((user) => {
    clearPendingInvite()
    return setCachedUser(user)
  })
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
  return getCurrentUser({ silent: true, sessionOnly: true })
    .then((user) => {
      if (options.isActive && !options.isActive()) throw { code: LOGIN_CANCEL_CODE, message: '操作已结束' }
      if (user) return user
      return showLoginModal(options).then(() => {
        if (options.isActive && !options.isActive()) throw { code: LOGIN_CANCEL_CODE, message: '操作已结束' }
        wx.navigateTo({ url: '/pages/client/profile/index' })
        throw { code: LOGIN_CANCEL_CODE, message: '请先完成微信登录' }
      })
    })
    .catch((error) => {
      if (options.isActive && !options.isActive()) throw { code: LOGIN_CANCEL_CODE, message: '操作已结束' }
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
  requestSubscribeTemplates,
  chooseSelectedLocation,
  requireSelectedLocation,
  getServiceLocation,
  getCachedUser,
  setCachedUser,
  logoutCurrentUser,
  getCurrentUser,
  savePendingInvite,
  loginWithWechat,
  ensureLogin,
  isLoginRequiredError
}
