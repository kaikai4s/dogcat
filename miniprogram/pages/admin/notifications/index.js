const { callFunction, showError } = require('../../../utils/cloud')
const { applyTheme, getThemeState } = require('../../../utils/theme')

Page({
  data: {
    themeClass: 'theme-day',
    activeTab: 'all', // all | unread | urgent | broadcast
    loading: false,
    list: [],
    page: 1,
    pageSize: 15,
    hasMore: true,
    total: 0,
    unreadCount: 0,

    // 系统通知广播
    broadcastList: [],
    broadcastPage: 1,
    broadcastHasMore: true,
    broadcastTotal: 0,
    broadcastLoading: false,

    // 发送弹窗与表单
    showSendModal: false,
    sending: false,
    sendForm: {
      title: '',
      content: '',
      target: 'all', // all | client | staff
      type: 'system', // system | notice | activity
      level: 'normal', // normal | urgent
      targetUrl: ''
    }
  },

  onShow() {
    this.applyCurrentTheme()
    if (this.data.activeTab === 'broadcast') {
      this.loadBroadcast({ reset: true })
    } else {
      this.load({ reset: true })
    }
  },

  onPullDownRefresh() {
    const p = this.data.activeTab === 'broadcast'
      ? this.loadBroadcast({ reset: true })
      : this.load({ reset: true })
    Promise.resolve(p).finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.activeTab === 'broadcast') {
      this.loadMoreBroadcast()
    } else {
      this.loadMore()
    }
  },

  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab || 'all'
    this.setData({ activeTab: tab }, () => {
      if (tab === 'broadcast') {
        this.loadBroadcast({ reset: true })
      } else {
        this.load({ reset: true })
      }
    })
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
  },

  // ================= 广播系统通知逻辑 =================

  loadBroadcast(options = {}) {
    const reset = options.reset === true
    if (!reset && this.data.broadcastLoading) return Promise.resolve()
    const page = reset ? 1 : this.data.broadcastPage
    this.setData({ broadcastLoading: true })

    return callFunction('admin', 'listSystemNotifications', { page, pageSize: this.data.pageSize })
      .then((res) => {
        const list = Array.isArray(res.list) ? res.list : []
        this.setData({
          broadcastList: reset ? list : this.data.broadcastList.concat(list),
          broadcastPage: res.page || page,
          broadcastHasMore: res.hasMore !== false && list.length >= this.data.pageSize,
          broadcastTotal: res.total || 0,
          broadcastLoading: false
        })
      })
      .catch((err) => {
        this.setData({ broadcastLoading: false })
        showError(err)
      })
  },

  loadMoreBroadcast() {
    if (!this.data.broadcastHasMore || this.data.broadcastLoading) return
    this.setData({ broadcastPage: this.data.broadcastPage + 1 }, () => this.loadBroadcast())
  },

  openSendModal() {
    this.setData({
      showSendModal: true,
      sendForm: {
        title: '',
        content: '',
        target: 'all',
        type: 'system',
        level: 'normal',
        targetUrl: ''
      }
    })
  },

  closeSendModal() {
    if (this.data.sending) return
    this.setData({ showSendModal: false })
  },

  onInputForm(e) {
    const field = e.currentTarget.dataset.field
    const value = e.detail.value
    this.setData({
      [`sendForm.${field}`]: value
    })
  },

  changeTarget(e) {
    const target = e.currentTarget.dataset.target
    this.setData({ 'sendForm.target': target })
  },

  changeType(e) {
    const type = e.currentTarget.dataset.type
    this.setData({ 'sendForm.type': type })
  },

  changeLevel(e) {
    const level = e.currentTarget.dataset.level
    this.setData({ 'sendForm.level': level })
  },

  submitSend() {
    if (this.data.sending) return
    const { title, content, target, type, level, targetUrl } = this.data.sendForm
    if (!title || !title.trim()) {
      wx.showToast({ title: '请输入通知标题', icon: 'none' })
      return
    }
    if (!content || !content.trim()) {
      wx.showToast({ title: '请输入通知内容', icon: 'none' })
      return
    }

    this.setData({ sending: true })
    wx.showLoading({ title: '正在发送通知...', mask: true })

    callFunction('admin', 'sendSystemNotification', {
      title: title.trim(),
      content: content.trim(),
      target,
      type,
      level,
      targetUrl: (targetUrl || '').trim()
    })
      .then(() => {
        wx.hideLoading()
        wx.showToast({ title: '通知已成功发送', icon: 'success' })
        this.setData({ sending: false, showSendModal: false })
        if (this.data.activeTab === 'broadcast') {
          this.loadBroadcast({ reset: true })
        } else {
          this.setData({ activeTab: 'broadcast' }, () => this.loadBroadcast({ reset: true }))
        }
      })
      .catch((err) => {
        wx.hideLoading()
        this.setData({ sending: false })
        showError(err)
      })
  },

  revokeNotification(e) {
    const item = e.currentTarget.dataset.item
    if (!item || !item._id) return

    wx.showModal({
      title: '确认撤回通知',
      content: `确定撤回系统通知《${item.title}》吗？撤回后用户和宠托师将不再可见。`,
      confirmColor: '#ff4d4f',
      success: (res) => {
        if (!res.confirm) return
        wx.showLoading({ title: '正在撤回...' })
        callFunction('admin', 'revokeSystemNotification', { id: item._id })
          .then(() => {
            wx.hideLoading()
            wx.showToast({ title: '已成功撤回' })
            this.loadBroadcast({ reset: true })
          })
          .catch((err) => {
            wx.hideLoading()
            showError(err)
          })
      }
    })
  }
})
