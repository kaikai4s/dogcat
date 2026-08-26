const { callFunction, showError, ensureLogin } = require('../../../utils/cloud')
const { formatDateTime } = require('../../../utils/format')
const { loadMessageUnread } = require('../../../utils/client-nav')
const { applyTheme, getThemeState } = require('../../../utils/theme')

function pageList(result) {
  return Array.isArray(result) ? { list: result, hasMore: false, page: 1, total: result.length } : (result || { list: [], hasMore: false, page: 1, total: 0 })
}

function withThreadText(thread) {
  if (!thread) return thread
  return {
    ...thread,
    titleText: thread.orderTitle || thread.serviceSummary || (thread.petName ? `${thread.petName}的订单` : '订单消息'),
    lastMessageAtText: formatDateTime(thread.lastMessageAt),
    hasUnread: Number(thread.unreadCount || 0) > 0
  }
}

Page({
  data: {
    themeClass: 'theme-day',
    threads: [],
    page: 1,
    pageSize: 20,
    hasMore: true,
    loading: false,
    total: 0,
    messageUnreadCount: 0,
    messageHasUnread: false
  },
  onShow() {
    this.applyCurrentTheme()
    ensureLogin({ content: '登录后可查看消息。' })
      .then(() => {
        this.load({ reset: true })
        loadMessageUnread(this)
      })
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },
  onReachBottom() {
    this.loadMore()
  },
  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },
  load(options = {}) {
    if (this.data.loading) return
    const reset = options.reset === true
    const page = reset ? 1 : this.data.page
    this.setData({ loading: true })
    callFunction('message', 'listThreads', { page, pageSize: this.data.pageSize })
      .then((result) => {
        const pageData = pageList(result)
        const threads = pageData.list.map(withThreadText)
        this.setData({
          threads: reset ? threads : this.data.threads.concat(threads),
          page: pageData.page,
          hasMore: pageData.hasMore,
          total: pageData.total,
          loading: false
        })
      })
      .catch((error) => {
        this.setData({ loading: false })
        showError(error)
      })
  },
  loadMore() {
    if (!this.data.hasMore || this.data.loading) return
    this.setData({ page: this.data.page + 1 }, () => this.load())
  },
  openThread(e) {
    const threadId = e.currentTarget.dataset.id
    if (!threadId) return
    wx.navigateTo({ url: '/pages/client/messages/thread/index?id=' + threadId })
  },
  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  }
})
