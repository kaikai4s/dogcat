function normalizeRoute(route) {
  const text = String(route || '')
  return text.startsWith('/') ? text.slice(1) : text
}

function withSlash(route) {
  return '/' + normalizeRoute(route)
}

function getSectionHomeUrl(route, query = {}) {
  const path = normalizeRoute(route)
  if (path.startsWith('pages/client/orders/')) return '/pages/client/orders/list/index'
  if (path.startsWith('pages/client/sitters/favorites/')) return query.from === 'profile' ? '/pages/client/profile/index' : '/pages/client/sitters/list/index'
  if (path.startsWith('pages/client/sitters/detail/')) return query.from === 'favorites' ? '/pages/client/profile/index' : '/pages/client/sitters/list/index'
  if (path.startsWith('pages/client/sitters/')) return '/pages/client/sitters/list/index'
  if (path.startsWith('pages/client/addresses/')) return '/pages/client/profile/index'
  if (path.startsWith('pages/client/pets/')) return '/pages/client/home/index'
  if (path.startsWith('pages/client/home-security/')) return '/pages/client/home/index'
  if (path.startsWith('pages/client/profile/edit/')) return query.from === 'staff' ? '/pages/staff/profile/index' : '/pages/client/profile/index'
  if (path.startsWith('pages/client/profile/')) return '/pages/client/profile/index'

  if (path.startsWith('pages/staff/orders/')) return '/pages/staff/orders/list/index'
  if (path.startsWith('pages/staff/checkin/') || path.startsWith('pages/staff/sos/')) return '/pages/staff/orders/list/index'
  if (path.startsWith('pages/staff/certification/')) return '/pages/staff/certification/index'
  if (path.startsWith('pages/staff/profile/')) return '/pages/staff/profile/index'
  if (path.startsWith('pages/staff/')) return '/pages/staff/home/index'

  if (path.startsWith('pages/admin/orders/')) return '/pages/admin/orders/list/index'
  if (path.startsWith('pages/admin/staff-audit/')) return '/pages/admin/staff-audit/list/index'
  if (path.startsWith('pages/admin/evidence/')) return '/pages/admin/orders/list/index'
  if (path.startsWith('pages/admin/incidents/')) return '/pages/admin/incidents/list/index'
  if (path.startsWith('pages/admin/service-prices/')) return '/pages/admin/home/index'
  if (path.startsWith('pages/admin/')) return '/pages/admin/home/index'

  return '/pages/client/home/index'
}

function getCurrentRoute() {
  const pages = getCurrentPages()
  return pages.length ? pages[pages.length - 1].route : ''
}

function createPageNav(query) {
  return {
    sectionHomeUrl: getSectionHomeUrl(getCurrentRoute(), query),
    canGoBack: getCurrentPages().length > 1
  }
}

function goBack() {
  const pages = getCurrentPages()
  if (pages.length > 1) {
    wx.navigateBack()
    return
  }
  goSectionHome()
}

function goSectionHome() {
  const pages = getCurrentPages()
  const current = pages.length ? pages[pages.length - 1] : null
  const url = current && current.data && current.data.sectionHomeUrl ? current.data.sectionHomeUrl : getSectionHomeUrl(getCurrentRoute())
  if (withSlash(getCurrentRoute()) === url) return
  wx.redirectTo({ url })
}

function navMethods() {
  return { goBack, goSectionHome }
}

module.exports = { createPageNav, getSectionHomeUrl, navMethods }
