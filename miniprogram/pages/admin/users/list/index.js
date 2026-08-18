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

  editUser(e) {
    const openid = e.currentTarget.dataset.openid
    if (!openid) return
    wx.navigateTo({ url: `/pages/admin/users/edit/index?openid=${encodeURIComponent(openid)}` })
  },

  toggleUserStatus(e) {
    const item = this.data.users.find((user) => user.openid === e.currentTarget.dataset.openid)
    if (!item || item.status === 'deleted') return
    const status = item.status === 'disabled' ? 'active' : 'disabled'
    wx.showModal({
      title: status === 'disabled' ? '禁用用户' : '启用用户',
      content: status === 'disabled' ? '禁用后该用户将无法继续登录和使用功能。确认禁用？' : '确认恢复该用户使用？',
      success: (res) => {
        if (!res.confirm) return
        callFunction('admin', 'updateUserProfile', { ...item, status })
          .then(() => {
            wx.showToast({ title: status === 'disabled' ? '已禁用' : '已启用', icon: 'none' })
            this.load({ reset: true })
          })
          .catch(showError)
      }
    })
  },

  deleteUser(e) {
    const openid = e.currentTarget.dataset.openid
    if (!openid) return
    wx.showModal({
      title: '删除用户',
      content: '删除后将清理用户宠物、地址、签到、优惠券、积分流水等个人数据；订单记录会保留。确认删除？',
      confirmText: '删除',
      confirmColor: '#f4436b',
      success: (res) => {
        if (!res.confirm) return
        callFunction('admin', 'deleteUser', { openid })
          .then(() => {
            wx.showToast({ title: '已删除', icon: 'none' })
            this.load({ reset: true })
          })
          .catch(showError)
      }
    })
  },

  hardDeleteUser(e) {
    const openid = e.currentTarget.dataset.openid
    if (!openid) return
    wx.showModal({
      title: '彻底删除用户',
      content: '彻底删除会移除账号记录，并让该微信下次登录成为全新用户；旧订单会保留在后台，但会与该 openid 脱钩。该操作不可恢复，是否继续？',
      confirmText: '继续',
      confirmColor: '#f4436b',
      success: (first) => {
        if (!first.confirm) return
        wx.showModal({
          title: '最终确认',
          content: '彻底删除后可重新触发新人邀请奖励，历史订单不再属于新账号。确认彻底删除？',
          confirmText: '彻底删除',
          confirmColor: '#f4436b',
          success: (second) => {
            if (!second.confirm) return
            callFunction('admin', 'hardDeleteUser', { openid })
              .then(() => {
                wx.showToast({ title: '已彻底删除', icon: 'none' })
                this.load({ reset: true })
              })
              .catch(showError)
          }
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
