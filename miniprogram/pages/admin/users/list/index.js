const { callFunction, showError } = require('../../../../utils/cloud')

const roleTabs = [
  { label: '全部', value: '' },
  { label: '用户', value: 'client' },
  { label: '宠托师', value: 'staff' },
  { label: '管理员', value: 'admin' }
]

function withDisplay(user) {
  return {
    ...user,
    avatarText: (user.nickname || '用').slice(0, 1)
  }
}

function pageList(result) {
  return Array.isArray(result) ? { list: result, hasMore: false, page: 1, total: result.length } : (result || { list: [], hasMore: false, page: 1, total: 0 })
}

Page({
  data: {
    users: [],
    keyword: '',
    role: '',
    roleTabs,
    page: 1,
    pageSize: 20,
    hasMore: true,
    total: 0,
    loading: false
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
    callFunction('admin', 'listUsers', { keyword: this.data.keyword, role: this.data.role, page, pageSize: this.data.pageSize })
      .then((result) => {
        const pageData = pageList(result)
        const users = pageData.list.map(withDisplay)
        this.setData({
          users: reset ? users : this.data.users.concat(users),
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

  inputKeyword(e) {
    this.setData({ keyword: e.detail.value })
  },

  search() {
    this.load({ reset: true })
  },

  switchRole(e) {
    this.setData({ role: e.currentTarget.dataset.value || '' })
    this.load({ reset: true })
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  }
})
