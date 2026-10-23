const { callFunction, getCurrentUser } = require('./cloud')

const unreadCache = {
  client: null,
  staff: null
}

function applyUnreadState(page, summaryOrTotal) {
  if (!page || typeof page.setData !== 'function') return
  const isObj = typeof summaryOrTotal === 'object' && summaryOrTotal !== null
  const count = Math.max(Number((isObj ? summaryOrTotal.totalUnread : summaryOrTotal) || 0), 0)
  const orderCount = isObj && typeof summaryOrTotal.orderUnread === 'number' ? Math.max(summaryOrTotal.orderUnread, 0) : 0
  const systemCount = isObj && typeof summaryOrTotal.systemUnread === 'number' ? Math.max(summaryOrTotal.systemUnread, 0) : 0
  const updateData = {
    messageUnreadCount: count,
    messageHasUnread: count > 0,
    messageShowUnreadDot: false,
    messageUnreadCountText: count > 99 ? '99+' : String(count)
  }
  if (isObj && (typeof summaryOrTotal.orderUnread === 'number' || typeof summaryOrTotal.systemUnread === 'number')) {
    updateData.orderUnreadCount = orderCount
    updateData.orderHasUnread = orderCount > 0
    updateData.orderUnreadCountText = orderCount > 99 ? '99+' : String(orderCount)
    updateData.systemUnreadCount = systemCount
    updateData.systemHasUnread = systemCount > 0
    updateData.systemUnreadCountText = systemCount > 99 ? '99+' : String(systemCount)
  }
  page.setData(updateData)
}

function getCachedUnread(role = 'client') {
  if (unreadCache[role] !== null) return unreadCache[role]
  try {
    const storageKey = `vip_pet_${role}_unread_summary`
    const stored = wx.getStorageSync(storageKey)
    if (stored && typeof stored.totalUnread === 'number') {
      unreadCache[role] = stored
      return stored
    }
  } catch (e) {}
  return null
}

function setCachedUnread(role, summary) {
  unreadCache[role] = summary
  try {
    const storageKey = `vip_pet_${role}_unread_summary`
    wx.setStorageSync(storageKey, summary)
  } catch (e) {}
}

function fetchUnreadSummary(role = 'client') {
  return getCurrentUser({ silent: true, sessionOnly: true })
    .then((user) => {
      if (!user) {
        const empty = { totalUnread: 0, orderUnread: 0, systemUnread: 0, hasUnread: false }
        setCachedUnread(role, empty)
        return empty
      }
      const moduleName = role === 'staff' ? 'staffMessage' : 'message'
      return callFunction(moduleName, 'getUnreadSummary', {})
        .then((summary) => {
          const totalUnread = Math.max(Number(summary && summary.totalUnread || 0), 0)
          const orderUnread = Math.max(Number(summary && summary.orderUnread || 0), 0)
          const systemUnread = Math.max(Number(summary && summary.systemUnread || 0), 0)
          const result = { totalUnread, orderUnread, systemUnread, hasUnread: totalUnread > 0 }
          setCachedUnread(role, result)
          return result
        })
    })
    .catch(() => {
      return getCachedUnread(role) || { totalUnread: 0, orderUnread: 0, systemUnread: 0, hasUnread: false }
    })
}

function loadMessageUnread(page, role = 'client') {
  if (!page || typeof page.setData !== 'function') return Promise.resolve(null)
  
  // 1. 先用已有缓存即时渲染，切换页面 0 毫秒展示未读角标
  const cached = getCachedUnread(role)
  if (cached && typeof cached.totalUnread === 'number') {
    applyUnreadState(page, cached)
  }

  // 2. 异步请求后台最新准确未读数
  return fetchUnreadSummary(role).then((summary) => {
    applyUnreadState(page, summary)
    return summary
  })
}

// The client and staff inboxes remain separate; this badge belongs to the staff entry.
function stopStaffEntryUnread(page) {
  page._staffUnreadRevision = (page._staffUnreadRevision || 0) + 1
  clearTimeout(page._staffUnreadTimer)
}

function startStaffEntryUnread(page) {
  if (page._staffEntryVisible === false) return Promise.resolve()
  stopStaffEntryUnread(page)
  const revision = page._staffUnreadRevision
  const active = () => page._staffUnreadRevision === revision
  const apply = count => {
    if (active()) page.setData({ staffUnreadCount: count, staffUnreadCountText: count > 99 ? '99+' : String(count) })
  }
  const refresh = async () => {
    try {
      const user = await getCurrentUser({ silent: true, sessionOnly: true })
      if (!active()) return
      if (!user || !(user.roles || []).includes('staff')) { apply(0); return }
      const summary = await callFunction('staffMessage', 'getUnreadSummary', {})
      const current = await getCurrentUser({ silent: true, sessionOnly: true })
      if (!current || (current.openid || current._id) !== (user.openid || user._id) || !(current.roles || []).includes('staff')) { apply(0); return }
      apply(Math.max(Number(summary && summary.totalUnread || 0), 0))
    } catch (_) { /* Keep the last displayed count on a transient network failure. */ }
    finally {
      if (active()) page._staffUnreadTimer = setTimeout(refresh, 30000)
    }
  }
  return refresh()
}

function refreshUnread(role = 'client') {
  return fetchUnreadSummary(role)
}

module.exports = {
  loadMessageUnread,
  startStaffEntryUnread,
  stopStaffEntryUnread,
  refreshUnread,
  getCachedUnread,
  setCachedUnread,
  applyUnreadState
}
