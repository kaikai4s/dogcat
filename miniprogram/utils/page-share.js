const { getCachedSystemSettings, loadSystemSettings, getCloudEnv } = require('./cloud')

const HOME_PATH = '/pages/client/home/index'
const DEFAULT_COVER = '/images/share-default.png'
const DEFAULT_TITLE = '多芙琳 · 安心上门宠物照护'
const SHARED_HOME_QUERY = 'sharedHome=1'
const SPECIAL_COVERS = new Set(['pages/client/checkin/index', 'pages/client/profile/assets/index'])

let lastSettingsRefresh = 0
let pendingCoverId = ''
let resolvedCover = { id: '', url: '', expiresAt: 0 }

function routeOf(page) {
  return String(page && page.route || '').replace(/^\//, '')
}

function publicTarget(page) {
  const route = routeOf(page)
  if (route === 'pages/client/home/index') return { title: DEFAULT_TITLE, path: HOME_PATH }
  if (route === 'pages/client/orders/create/index') return { title: '预约多芙琳上门宠物照护', path: '/pages/client/orders/create/index' }
  if (route === 'pages/client/sitters/list/index') return { title: '寻找身边的安心宠托师', path: '/pages/client/sitters/list/index' }
  if (route === 'pages/client/mall/list/index') return { title: '逛逛多芙琳宠物用品商城', path: '/pages/client/mall/list/index' }
  if (route === 'pages/client/sitters/detail/index' || route === 'pages/client/mall/detail/index') {
    const id = String(page && page.data && page.data.id || '')
    if (id && id.length <= 128) {
      const title = route.includes('/sitters/') ? '查看多芙琳宠托师档案' : '查看多芙琳宠物用品'
      return { title, path: `/${route}?id=${encodeURIComponent(id)}` }
    }
  }
  return { title: DEFAULT_TITLE, path: HOME_PATH }
}

function isPublicTarget(page) {
  return publicTarget(page).path.split('?')[0] === `/${routeOf(page)}`
}

function coverId() {
  try { return String(getCachedSystemSettings().generalShare?.imageUrl || '').trim() } catch (_) { return '' }
}

function generalCover() {
  const id = coverId()
  if (/^https:\/\//.test(id)) return id
  if (id && id === resolvedCover.id && resolvedCover.expiresAt > Date.now()) return resolvedCover.url
  return DEFAULT_COVER
}

function preloadCover(id) {
  if (!id || !id.startsWith('cloud://') || typeof wx === 'undefined' || !wx.cloud || typeof wx.cloud.getTempFileURL !== 'function') return
  if (resolvedCover.id === id && resolvedCover.expiresAt > Date.now()) return
  if (pendingCoverId === id) return
  pendingCoverId = id
  try {
    wx.cloud.getTempFileURL({
      fileList: [id],
      config: { env: getCloudEnv() },
      success(result) {
        const file = result && result.fileList && result.fileList[0]
        if (pendingCoverId === id && file && /^https:\/\//.test(file.tempFileURL || '')) {
          resolvedCover = { id, url: file.tempFileURL, expiresAt: Date.now() + 30 * 60 * 1000 }
        }
      },
      complete() { if (pendingCoverId === id) pendingCoverId = '' }
    })
  } catch (_) { pendingCoverId = '' }
}

function prepareShareMenu() {
  if (typeof wx === 'undefined') return
  if (typeof wx.showShareMenu === 'function') {
    try { wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] }) } catch (_) {}
  }
  preloadCover(coverId())
  if (Date.now() - lastSettingsRefresh < 60 * 1000) return
  lastSettingsRefresh = Date.now()
  loadSystemSettings().then(settings => preloadCover(settings?.generalShare?.imageUrl || '')).catch(() => {})
}

function decorateAppMessage(page, originalResult) {
  const result = originalResult && typeof originalResult === 'object' ? originalResult : publicTarget(page)
  return { ...result, imageUrl: SPECIAL_COVERS.has(routeOf(page)) ? (result.imageUrl || DEFAULT_COVER) : generalCover() }
}

function decorateTimeline(page, originalResult, originalAppMessage) {
  const route = routeOf(page)
  if (SPECIAL_COVERS.has(route)) {
    const custom = typeof originalAppMessage === 'function' ? originalAppMessage.call(page) : publicTarget(page)
    const path = String(custom && custom.path || '')
    return { title: custom.title || DEFAULT_TITLE, query: path.includes('?') ? path.split('?').slice(1).join('?') : '', imageUrl: custom.imageUrl || DEFAULT_COVER }
  }
  if (originalResult && typeof originalResult === 'object') return { ...originalResult, imageUrl: generalCover() }
  const target = publicTarget(page)
  return { title: target.title, query: isPublicTarget(page) ? (target.path.split('?')[1] || '') : SHARED_HOME_QUERY, imageUrl: generalCover() }
}

function shouldRedirectSharedHome(page, options) {
  return !isPublicTarget(page) && options && options.sharedHome === '1'
}

module.exports = { HOME_PATH, publicTarget, prepareShareMenu, decorateAppMessage, decorateTimeline, shouldRedirectSharedHome }
