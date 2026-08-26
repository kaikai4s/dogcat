const { callFunction, getCurrentUser } = require('./cloud')

function loadMessageUnread(page, role = 'client') {
  if (!page || typeof page.setData !== 'function') return Promise.resolve(null)
  return getCurrentUser({ silent: true })
    .then((user) => {
      if (!user) {
        page.setData({ messageUnreadCount: 0, messageHasUnread: false })
        return null
      }
      const moduleName = role === 'staff' ? 'staffMessage' : 'message'
      return callFunction(moduleName, 'getUnreadSummary', {})
        .then((summary) => {
          const totalUnread = Number(summary && summary.totalUnread || 0)
          page.setData({ messageUnreadCount: totalUnread, messageHasUnread: totalUnread > 0 })
          return summary
        })
    })
    .catch(() => {
      page.setData({ messageUnreadCount: 0, messageHasUnread: false })
      return null
    })
}

module.exports = { loadMessageUnread }
