const { getRoleHome } = require('./roles')

const MAIN_NAV_URLS = {
  client: [
    '/pages/client/home/index',
    '/pages/client/sitters/list/index',
    '/pages/client/orders/list/index',
    '/pages/client/messages/index',
    '/pages/client/profile/index'
  ],
  staff: [
    '/pages/staff/home/index',
    '/pages/staff/orders/list/index',
    '/pages/staff/messages/index',
    '/pages/staff/certification/index',
    '/pages/staff/profile/index'
  ],
  admin: [
    '/pages/admin/home/index',
    '/pages/admin/orders/list/index',
    '/pages/admin/staff-audit/list/index',
    '/pages/admin/incidents/list/index',
    '/pages/admin/checkin-config/index',
    '/pages/admin/points/index',
    '/pages/admin/settings/index',
    '/pages/admin/pets/list/index'
  ]
}

function getNavBarInfo(wxApi) {
  const api = wxApi || (typeof wx !== 'undefined' ? wx : null)
  let statusBarHeight = 44
  let titleBarHeight = 44
  try {
    const windowInfo = (api && ((api.getWindowInfo && api.getWindowInfo()) || (api.getSystemInfoSync && api.getSystemInfoSync()))) || {}
    if (windowInfo.statusBarHeight) {
      statusBarHeight = windowInfo.statusBarHeight
    }
    const menu = api && api.getMenuButtonBoundingClientRect ? api.getMenuButtonBoundingClientRect() : null
    if (menu && menu.top && menu.height) {
      titleBarHeight = (menu.top - statusBarHeight) * 2 + menu.height
    } else {
      titleBarHeight = 44
    }
  } catch (_) {
    statusBarHeight = 44
    titleBarHeight = 44
  }
  return {
    statusBarHeight,
    titleBarHeight,
    navBarHeight: statusBarHeight + titleBarHeight
  }
}

function navigateRoleRoute(url, role = 'client') {
  if (!url) return
  const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
  const current = pages[pages.length - 1]
  const currentRoute = current && current.route ? (current.route.startsWith('/') ? current.route : '/' + current.route) : ''
  if (currentRoute === url) return
  const mainUrls = Array.isArray(role) ? role : (MAIN_NAV_URLS[role] || MAIN_NAV_URLS.client)
  if (mainUrls.includes(url)) {
    wx.redirectTo({ url })
  } else {
    safeNavigateTo({ url })
  }
}

function normalizeUrl(url) {
  const text = String(url || '').trim()
  if (!text) return ''
  return text.startsWith('/') ? text : `/${text}`
}

function getCurrentRouteFallback() {
  const pages = getCurrentPages()
  const current = pages[pages.length - 1]
  const route = normalizeUrl(current && current.route)
  if (route.startsWith('/pages/staff/')) return getRoleHome('staff')
  if (route.startsWith('/pages/admin/')) return getRoleHome('admin')
  if (route.startsWith('/pages/client/')) return getRoleHome('client')
  const app = getApp()
  const activeRole = app && app.globalData && app.globalData.activeRole
  return getRoleHome(activeRole || 'client')
}

function isSameDomainRoute(sourceRoute, targetRoute) {
  const sourcePrefix = (sourceRoute.match(/^\/pages\/([^/]+)\//) || [])[1]
  const targetPrefix = (targetRoute.match(/^\/pages\/([^/]+)\//) || [])[1]
  if (!sourcePrefix || !targetPrefix) return true
  return sourcePrefix === targetPrefix
}

function createPageNav(query = {}) {
  const pages = getCurrentPages()
  const current = pages[pages.length - 1]
  const currentRoute = normalizeUrl(current && current.route)
  const prevPage = pages.length > 1 ? pages[pages.length - 2] : null
  const prevRoute = normalizeUrl(prevPage && prevPage.route)

  const hasSameDomainPrevPage = Boolean(prevRoute && isSameDomainRoute(currentRoute, prevRoute))

  return {
    canGoBack: hasSameDomainPrevPage,
    fallbackUrl: normalizeUrl(query.fallbackUrl) || getCurrentRouteFallback()
  }
}

function goBack() {
  const pages = getCurrentPages()
  const current = pages[pages.length - 1]
  const currentRoute = normalizeUrl(current && current.route)
  const prevPage = pages.length > 1 ? pages[pages.length - 2] : null
  const prevRoute = normalizeUrl(prevPage && prevPage.route)

  if (prevRoute && isSameDomainRoute(currentRoute, prevRoute)) {
    wx.navigateBack()
    return
  }

  const fallbackUrl = normalizeUrl(this && this.data && this.data.fallbackUrl) || getCurrentRouteFallback()
  wx.redirectTo({ url: fallbackUrl })
}

/**
 * 安全的页面导航跳转
 * 微信小程序限制最大页面栈深度为 10 层。
 * 当检测到 getCurrentPages().length >= 9 时自动降级为 redirectTo，彻底杜绝栈溢出崩溃。
 */
function safeNavigateTo(options) {
  if (!options || !options.url) return
  const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
  if (pages.length >= 9) {
    wx.redirectTo(options)
  } else {
    wx.navigateTo({
      ...options,
      fail: (err) => {
        const msg = (err && (err.errMsg || err.message)) || ''
        if (/limit exceed|exceed/i.test(msg)) {
          wx.redirectTo(options)
        } else if (/timeout/i.test(msg)) {
          const currentPages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
          const current = currentPages[currentPages.length - 1]
          const currentRoute = current && current.route ? (current.route.startsWith('/') ? current.route : '/' + current.route) : ''
          const targetPath = (options.url || '').split('?')[0]
          if (currentRoute === targetPath) {
            if (typeof options.success === 'function') options.success({ errMsg: 'navigateTo:ok' })
            return
          }
          wx.redirectTo({
            ...options,
            fail: (fallbackErr) => {
              if (typeof options.fail === 'function') options.fail(fallbackErr || err)
            }
          })
        } else if (typeof options.fail === 'function') {
          options.fail(err)
        }
      }
    })
  }
}

function navMethods() {
  return { goBack, safeNavigateTo }
}

module.exports = {
  MAIN_NAV_URLS,
  createPageNav,
  getNavBarInfo,
  navMethods,
  getCurrentRouteFallback,
  safeNavigateTo,
  navigateRoleRoute
}
