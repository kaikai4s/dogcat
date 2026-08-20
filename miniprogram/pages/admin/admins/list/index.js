const { callFunction, showError } = require('../../../../utils/cloud')

function withDisplay(user) {
  return {
    ...user,
    avatarText: (user.nickname || '管').slice(0, 1)
  }
}

function pageList(result) {
  return Array.isArray(result) ? { list: result, hasMore: false, page: 1, total: result.length } : (result || { list: [], hasMore: false, page: 1, total: 0 })
}

Page({
  data: {
    admins: [],
    openid: '',
    keyword: '',
    page: 1,
    pageSize: 10,
    hasMore: true,
    total: 0,
    loading: false,
    saving: false,
    removingOpenid: ''
  },

  onShow() {
    this.load({ reset: true })
  },

  onReachBottom() {
    this.loadMore()
  },

  load(options = {}) {
    if (this.data.loading) return
    const reset = options.reset === true
    const page = reset ? 1 : this.data.page
    this.setData({ loading: true })
    callFunction('admin', 'listAdmins', { keyword: this.data.keyword, page, pageSize: this.data.pageSize })
      .then((result) => {
        const pageData = pageList(result)
        const admins = pageData.list.map(withDisplay)
        this.setData({
          admins: reset ? admins : this.data.admins.concat(admins),
          page: pageData.page,
          hasMore: pageData.hasMore,
          total: pageData.total,
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

  inputOpenid(e) {
    this.setData({ openid: e.detail.value })
  },

  inputKeyword(e) {
    this.setData({ keyword: e.detail.value })
  },

  submitSearch() {
    this.setData({ page: 1, hasMore: true }, () => this.load({ reset: true }))
  },

  clearSearch() {
    this.setData({ keyword: '', page: 1, hasMore: true }, () => this.load({ reset: true }))
  },

  grantAdmin() {
    const openid = String(this.data.openid || '').trim()
    if (!openid || this.data.saving) return
    this.setData({ saving: true })
    callFunction('admin', 'grantAdmin', { openid })
      .then(() => {
        wx.showToast({ title: '已添加' })
        this.setData({ openid: '', saving: false })
        this.load({ reset: true })
      })
      .catch((err) => {
        this.setData({ saving: false })
        showError(err)
      })
  },

  revokeAdmin(e) {
    const openid = e.currentTarget.dataset.openid
    if (!openid || this.data.removingOpenid) return
    wx.showModal({
      title: '移除管理员',
      content: '确认移除此用户的管理员权限？',
      success: (res) => {
        if (!res.confirm) return
        this.setData({ removingOpenid: openid })
        callFunction('admin', 'revokeAdmin', { openid })
          .then(() => {
            wx.showToast({ title: '已移除' })
            this.setData({ removingOpenid: '' })
            this.load({ reset: true })
          })
          .catch((err) => {
            this.setData({ removingOpenid: '' })
            showError(err)
          })
      }
    })
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  }
})
