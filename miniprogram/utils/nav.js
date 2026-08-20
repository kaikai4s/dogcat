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

function navMethods() {
  return { goBack }
}

module.exports = { createPageNav, navMethods, getCurrentRouteFallback }
