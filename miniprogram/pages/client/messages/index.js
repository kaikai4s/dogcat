const { callFunction, showError, ensureLogin } = require('../../../utils/cloud')
const { formatDateTime } = require('../../../utils/format')
const { loadMessageUnread, refreshUnread } = require('../../../utils/client-nav')
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
    wx.navigateTo({ url: '/pages/client/messages/thread/index?id=' + threadId })
  },
  deleteThread(e) {
    const threadId = e.currentTarget.dataset.id || (e.detail && e.detail.id)
    if (!threadId) return
    wx.showModal({
      title: '删除订单消息',
      content: '确定从消息列表中移除该订单消息吗？\n（仅从消息列表隐藏，对应订单详情中仍可随时查看完整记录）',
      confirmText: '删除',
      confirmColor: '#e03131',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '正在移除...' })
          callFunction('message', 'deleteThread', { threadId })
            .then(() => {
              wx.hideLoading()
              const updatedThreads = this.data.threads.filter((item) => item._id !== threadId)
              this.setData({
                threads: updatedThreads,
                total: Math.max(0, this.data.total - 1)
              })
              wx.showToast({ title: '已从列表移除', icon: 'success' })
              refreshUnread('client').catch(() => {})
              loadMessageUnread(this)
            })
            .catch((err) => {
              wx.hideLoading()
              showError(err)
            })
        }
      }
    })
  },
  onThreadLongPress(e) {
    const threadId = e.currentTarget.dataset.id
    if (!threadId) return
    this.deleteThread({ currentTarget: { dataset: { id: threadId } } })
  },
  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  }
})
