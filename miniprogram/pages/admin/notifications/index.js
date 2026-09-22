const { callFunction, showError } = require('../../../utils/cloud')
const { applyTheme, getThemeState } = require('../../../utils/theme')

Page({
  data: {
    themeClass: 'theme-day',
    activeTab: 'all', // all | unread | urgent
    loading: false,
    list: [],
    page: 1,
    pageSize: 15,
    hasMore: true,
    total: 0,
    unreadCount: 0
  },

  onShow() {
    this.applyCurrentTheme()
    this.load({ reset: true })
  },

  onPullDownRefresh() {
    this.load({ reset: true }).then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    this.loadMore()
  },

  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab || 'all'
    this.setData({ activeTab: tab }, () => this.load({ reset: true }))
  },

  load(options = {}) {
    const reset = options.reset === true
    if (!reset && this.data.loading) return Promise.resolve()
    const page = reset ? 1 : this.data.page
    const params = {
      page,
      pageSize: this.data.pageSize
    }
    if (this.data.activeTab === 'unread') {
      params.status = 'unread'
    } else if (this.data.activeTab === 'urgent') {
      params.level = 'urgent'
    }

    this.setData({ loading: true })
    return callFunction('admin', 'listAdminNotifications', params)
      .then((res) => {
        const list = Array.isArray(res.list) ? res.list : []
        this.setData({
          list: reset ? list : this.data.list.concat(list),
          page: res.page || page,
          hasMore: res.hasMore !== false && list.length >= this.data.pageSize,
          total: res.total || 0,
          unreadCount: res.unreadCount || 0,
          loading: false
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        showError(err)
      })
  },

  loadMore() {
    if (!this.data.hasMore || this.data.loading) return
    this.setData({ page: this.data.page + 1 }, () => this.load())
  },

  markAllRead() {
    if (this.data.unreadCount === 0) {
      wx.showToast({ title: '暂无未读消息', icon: 'none' })
      return
    }
    wx.showLoading({ title: '处理中...' })
    callFunction('admin', 'markAdminNotificationRead', { all: true })
      .then(() => {
        wx.hideLoading()
        wx.showToast({ title: '已全部标为已读' })
        this.setData({ unreadCount: 0 })
        this.load({ reset: true })

        // 同步清除管理首页右上角小红点角标，保持数字一致性
        const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
        const adminHome = pages.find((p) => p && p.route && p.route.includes('pages/admin/home/index'))
        if (adminHome && typeof adminHome.setData === 'function') {
          adminHome.setData({ unreadNotificationCount: 0, urgentNotice: null })
        }
      })
      .catch((err) => {
        wx.hideLoading()
        showError(err)
      })
  },

  tapItem(e) {
    const item = e.currentTarget.dataset.item
    if (!item) return
    if (!item.isRead) {
      callFunction('admin', 'markAdminNotificationRead', { id: item._id }).catch(() => {})
      // 本地乐观更新已读状态
      const list = this.data.list.map((n) => (n._id === item._id ? { ...n, isRead: true } : n))
      const nextUnread = Math.max(0, this.data.unreadCount - 1)
      this.setData({ list, unreadCount: nextUnread })

      // 同步递减管理首页未读角标
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
      const adminHome = pages.find((p) => p && p.route && p.route.includes('pages/admin/home/index'))
      if (adminHome && typeof adminHome.setData === 'function') {
        const currentCount = adminHome.data && adminHome.data.unreadNotificationCount
        adminHome.setData({ unreadNotificationCount: Math.max(0, (currentCount || 1) - 1) })
      }
    }

    const targetUrl = item.actionUrl || (item.orderId ? `/pages/admin/orders/detail/index?id=${item.orderId}` : '')
    if (targetUrl) {
      wx.navigateTo({ url: targetUrl })
    }
  }
})
