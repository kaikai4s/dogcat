const { callFunction, showError, ensureLogin } = require('../../../utils/cloud')
const { formatDateTime } = require('../../../utils/format')
const clientNav = require('../../../utils/client-nav')
const loadMessageUnread = clientNav.loadMessageUnread || (() => Promise.resolve())
const refreshUnread = clientNav.refreshUnread || (() => Promise.resolve())
const setCachedUnread = clientNav.setCachedUnread || (() => {})
const applyUnreadState = clientNav.applyUnreadState || (() => {})
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
    activeTab: 'order', // 'order' | 'system'
    // 订单消息
    threads: [],
    page: 1,
    pageSize: 20,
    hasMore: true,
    loading: false,
    total: 0,
    // 系统通知
    systemNotices: [],
    systemPage: 1,
    systemPageSize: 20,
    systemHasMore: true,
    systemLoading: false,
    systemTotal: 0,
    // 全局与分类未读数
    messageUnreadCount: 0,
    messageHasUnread: false,
    messageShowUnreadDot: false,
    messageUnreadCountText: '0',
    orderUnreadCount: 0,
    orderHasUnread: false,
    orderUnreadCountText: '0',
    systemUnreadCount: 0,
    systemHasUnread: false,
    systemUnreadCountText: '0',
    // 弹窗查看通知详情
    selectedNotice: null,
    showNoticeModal: false
  },
  onShow() {
    this.applyCurrentTheme()
    ensureLogin({ content: '登录后可查看消息。' })
      .then(() => {
        if (this.data.activeTab === 'order') {
          this.load({ reset: true })
        } else {
          this.loadSystemNotices({ reset: true })
        }
        loadMessageUnread(this)
      })
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },
  onReachBottom() {
    if (this.data.activeTab === 'order') {
      this.loadMore()
    } else {
      this.loadMoreSystemNotices()
    }
  },
  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },
  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (!tab || tab === this.data.activeTab) return
    this.setData({ activeTab: tab })
    if (tab === 'system' && (!this.data.systemNotices.length || this.data.systemHasUnread)) {
      this.loadSystemNotices({ reset: true })
    } else if (tab === 'order' && (!this.data.threads.length || this.data.orderHasUnread)) {
      this.load({ reset: true })
    }
    loadMessageUnread(this)
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
  loadSystemNotices(options = {}) {
    if (this.data.systemLoading) return
    const reset = options.reset === true
    const page = reset ? 1 : this.data.systemPage
    this.setData({ systemLoading: true })
    callFunction('message', 'listSystemNotifications', { page, pageSize: this.data.systemPageSize })
      .then((result) => {
        const pageData = pageList(result)
        const unreadCount = Number(result && result.unreadCount || 0)
        const orderUnread = Number(this.data.orderUnreadCount || 0)
        const total = orderUnread + unreadCount
        this.setData({
          systemNotices: reset ? pageData.list : this.data.systemNotices.concat(pageData.list),
          systemPage: pageData.page,
          systemHasMore: pageData.hasMore,
          systemTotal: pageData.total,
          systemUnreadCount: unreadCount,
          systemHasUnread: unreadCount > 0,
          systemUnreadCountText: unreadCount > 99 ? '99+' : String(unreadCount),
          messageUnreadCount: total,
          messageHasUnread: total > 0,
          messageUnreadCountText: total > 99 ? '99+' : String(total),
          systemLoading: false
        })
        setCachedUnread('client', {
          totalUnread: total,
          orderUnread,
          systemUnread: unreadCount,
          hasUnread: total > 0
        })
      })
      .catch((error) => {
        this.setData({ systemLoading: false })
        showError(error)
      })
  },
  loadMoreSystemNotices() {
    if (!this.data.systemHasMore || this.data.systemLoading) return
    this.setData({ systemPage: this.data.systemPage + 1 }, () => this.loadSystemNotices())
  },
  tapNotice(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    const notice = this.data.systemNotices.find((n) => n._id === id)
    if (!notice) return

    this.setData({
      selectedNotice: notice,
      showNoticeModal: true
    })

    if (!notice.isRead) {
      callFunction('message', 'markSystemNotificationRead', { id })
        .then(() => {
          const updated = this.data.systemNotices.map((n) => {
            if (n._id === id) return { ...n, isRead: true }
            return n
          })
          const unreadCount = Math.max(0, this.data.systemUnreadCount - 1)
          const orderUnread = Number(this.data.orderUnreadCount || 0)
          const total = orderUnread + unreadCount
          this.setData({
            systemNotices: updated,
            systemUnreadCount: unreadCount,
            systemHasUnread: unreadCount > 0,
            systemUnreadCountText: unreadCount > 99 ? '99+' : String(unreadCount),
            messageUnreadCount: total,
            messageHasUnread: total > 0,
            messageUnreadCountText: total > 99 ? '99+' : String(total),
            selectedNotice: { ...notice, isRead: true }
          })
          setCachedUnread('client', {
            totalUnread: total,
            orderUnread,
            systemUnread: unreadCount,
            hasUnread: total > 0
          })
          refreshUnread('client').then((summary) => applyUnreadState(this, summary)).catch(() => {})
        })
        .catch(() => {})
    }
  },
  closeNoticeModal() {
    this.setData({
      showNoticeModal: false,
      selectedNotice: null
    })
  },
  handleNoticeAction() {
    const notice = this.data.selectedNotice
    this.closeNoticeModal()
    if (notice && notice.targetUrl) {
      this.go({ currentTarget: { dataset: { url: notice.targetUrl } } })
    }
  },
  markAllSystemRead() {
    if (!this.data.systemHasUnread && this.data.systemUnreadCount === 0) {
      wx.showToast({ title: '没有未读通知', icon: 'none' })
      return
    }
    wx.showModal({
      title: '全部已读',
      content: '确定将所有系统通知标为已读吗？',
      confirmText: '标为已读',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '正在处理...' })
          callFunction('message', 'markSystemNotificationRead', { all: true })
            .then(() => {
              wx.hideLoading()
              const updated = this.data.systemNotices.map((n) => ({ ...n, isRead: true }))
              const orderUnread = Number(this.data.orderUnreadCount || 0)
              this.setData({
                systemNotices: updated,
                systemUnreadCount: 0,
                systemHasUnread: false,
                systemUnreadCountText: '0',
                messageUnreadCount: orderUnread,
                messageHasUnread: orderUnread > 0,
                messageUnreadCountText: orderUnread > 99 ? '99+' : String(orderUnread)
              })
              setCachedUnread('client', {
                totalUnread: orderUnread,
                orderUnread,
                systemUnread: 0,
                hasUnread: orderUnread > 0
              })
              wx.showToast({ title: '已全部标为已读', icon: 'success' })
              refreshUnread('client').then((summary) => applyUnreadState(this, summary)).catch(() => {})
            })
            .catch((err) => {
              wx.hideLoading()
              showError(err)
            })
        }
      }
    })
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
    const pages = getCurrentPages()
    const current = pages[pages.length - 1]
    const currentRoute = current && current.route ? '/' + current.route : ''
    if (currentRoute === url) return
    const mainNavUrls = ['/pages/client/home/index', '/pages/client/sitters/list/index', '/pages/client/orders/list/index', '/pages/client/messages/index', '/pages/client/profile/index']
    const method = mainNavUrls.includes(url) ? 'redirectTo' : 'navigateTo'
    wx[method]({ url })
  }
})
