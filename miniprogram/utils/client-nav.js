const { callFunction, getCurrentUser } = require('./cloud')

const unreadCache = {
  client: null,
  staff: null
}

function applyUnreadState(page, totalUnread) {
  if (!page || typeof page.setData !== 'function') return
  const count = Math.max(Number(totalUnread || 0), 0)
  page.setData({
    messageUnreadCount: count,
    messageHasUnread: count > 0,
    messageShowUnreadDot: false,
    messageUnreadCountText: count > 99 ? '99+' : String(count)
  })
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
  return getCurrentUser({ silent: true })
    .then((user) => {
      if (!user) {
        const empty = { totalUnread: 0, hasUnread: false }
        setCachedUnread(role, empty)
        return empty
      }
      const moduleName = role === 'staff' ? 'staffMessage' : 'message'
      return callFunction(moduleName, 'getUnreadSummary', {})
        .then((summary) => {
          const totalUnread = Math.max(Number(summary && summary.totalUnread || 0), 0)
          const result = { totalUnread, hasUnread: totalUnread > 0 }
          setCachedUnread(role, result)
          return result
        })
    })
    .catch(() => {
      return getCachedUnread(role) || { totalUnread: 0, hasUnread: false }
    })
}

function loadMessageUnread(page, role = 'client') {
  if (!page || typeof page.setData !== 'function') return Promise.resolve(null)
  
  // 1. 先用已有缓存即时渲染，切换页面 0 毫秒展示未读角标
  const cached = getCachedUnread(role)
  if (cached && typeof cached.totalUnread === 'number') {
    applyUnreadState(page, cached.totalUnread)
  }

  // 2. 异步请求后台最新准确未读数
  return fetchUnreadSummary(role).then((summary) => {
    applyUnreadState(page, summary.totalUnread)
    return summary
  })
}

function refreshUnread(role = 'client') {
  return fetchUnreadSummary(role)
}

module.exports = {
  loadMessageUnread,
  refreshUnread,
  getCachedUnread,
  setCachedUnread,
  applyUnreadState
}
