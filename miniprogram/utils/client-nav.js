const { callFunction, getCurrentUser } = require('./cloud')

function loadMessageUnread(page, role = 'client') {
  if (!page || typeof page.setData !== 'function') return Promise.resolve(null)
  return getCurrentUser({ silent: true })
    .then((user) => {
      if (!user) {
        page.setData({ messageUnreadCount: 0, messageHasUnread: false, messageShowUnreadDot: false, messageUnreadCountText: '0' })
        return null
      }
      const moduleName = role === 'staff' ? 'staffMessage' : 'message'
      return callFunction(moduleName, 'getUnreadSummary', {})
        .then((summary) => {
          const totalUnread = Math.max(Number(summary && summary.totalUnread || 0), 0)
          page.setData({
            messageUnreadCount: totalUnread,
            messageHasUnread: totalUnread > 0,
            messageShowUnreadDot: totalUnread === 1,
            messageUnreadCountText: totalUnread > 99 ? '99+' : String(totalUnread)
          })
          return summary
        })
    })
    .catch(() => {
      page.setData({ messageUnreadCount: 0, messageHasUnread: false, messageShowUnreadDot: false, messageUnreadCountText: '0' })
      return null
    })
}

module.exports = { loadMessageUnread }
