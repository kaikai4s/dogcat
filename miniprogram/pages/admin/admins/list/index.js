const { callFunction, showError } = require('../../../../utils/cloud')

function withDisplay(user) {
  return {
    ...user,
    avatarText: (user.nickname || '管').slice(0, 1)
  }
}

Page({
  data: {
    admins: [],
    openid: '',
    loading: false,
    saving: false,
    removingOpenid: ''
  },

  onShow() {
    this.load()
  },

  load() {
    this.setData({ loading: true })
    callFunction('admin', 'listAdmins')
      .then((admins) => this.setData({ admins: admins.map(withDisplay), loading: false }))
      .catch((err) => {
        this.setData({ loading: false })
        showError(err)
      })
  },

  inputOpenid(e) {
    this.setData({ openid: e.detail.value })
  },

  grantAdmin() {
    const openid = String(this.data.openid || '').trim()
    if (!openid || this.data.saving) return
    this.setData({ saving: true })
    callFunction('admin', 'grantAdmin', { openid })
      .then(() => {
        wx.showToast({ title: '已添加' })
        this.setData({ openid: '', saving: false })
        this.load()
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
            this.load()
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
