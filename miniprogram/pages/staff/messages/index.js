const { callFunction, showError } = require('../../../utils/cloud')
const { formatDateTime } = require('../../../utils/format')
const { loadMessageUnread } = require('../../../utils/client-nav')
const { applyTheme, getThemeState } = require('../../../utils/theme')

function pageList(result) {
  return Array.isArray(result) ? { list: result, hasMore: false, page: 1, total: result.length } : (result || { list: [], hasMore: false, page: 1, total: 0 })
}

function messageTimeValue(thread = {}) {
  const source = thread.lastMessageAt || thread.updatedAt || thread.createdAt
  const time = source instanceof Date ? source.getTime() : new Date(source || 0).getTime()
  return Number.isFinite(time) ? time : 0
}

function sortThreads(threads = []) {
  return threads.slice().sort((a, b) => {
    const unreadDiff = (Number(b.unreadCount || 0) > 0) - (Number(a.unreadCount || 0) > 0)
    if (unreadDiff !== 0) return unreadDiff
    return messageTimeValue(b) - messageTimeValue(a)
  })
}

function orderStatusClass(status) {
  return {
    paid: 'warning',
    assigned: 'blue',
    in_service: 'purple',
    completed: 'green',
    canceled: 'gray',
    expired: 'gray',
    refunding: 'red',
    refunded: 'red'
  }[status] || 'default'
}

function withThreadText(thread) {
  if (!thread) return thread
  const unreadCount = Math.max(Number(thread.unreadCount || 0), 0)
  return {
    ...thread,
    titleText: thread.orderTitle || thread.serviceSummary || (thread.petName ? `${thread.petName}的订单` : '订单消息'),
    lastMessageAtText: formatDateTime(thread.lastMessageAt),
    unreadCount,
    hasUnread: unreadCount > 0,
    showUnreadDot: unreadCount === 1,
    unreadCountText: unreadCount > 99 ? '99+' : String(unreadCount),
    orderStatusClass: orderStatusClass(thread.orderStatus)
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
    messageHasUnread: false,
    messageShowUnreadDot: false,
    messageUnreadCountText: '0'
  },
  onShow() {
    this.applyCurrentTheme()
    this.load({ reset: true })
    loadMessageUnread(this, 'staff')
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
    callFunction('staffMessage', 'listThreads', { page, pageSize: this.data.pageSize })
      .then((result) => {
        const pageData = pageList(result)
        const threads = pageData.list.map(withThreadText)
        this.setData({
          threads: sortThreads(reset ? threads : this.data.threads.concat(threads)),
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
    wx.navigateTo({ url: '/pages/staff/messages/thread/index?id=' + threadId })
  },
  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.navigateTo({ url })
  },
  backProfile() {
    wx.redirectTo({ url: '/pages/staff/profile/index' })
  }
})
