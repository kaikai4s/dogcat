const { getRoleHome } = require('./roles')

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

module.exports = { createPageNav, navMethods, getCurrentRouteFallback, safeNavigateTo }
