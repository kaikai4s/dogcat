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

function createPageNav(query = {}) {
  return {
    canGoBack: getCurrentPages().length > 1,
    fallbackUrl: normalizeUrl(query.fallbackUrl) || getCurrentRouteFallback()
  }
}

function goBack() {
  const pages = getCurrentPages()
  if (pages.length > 1) {
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
