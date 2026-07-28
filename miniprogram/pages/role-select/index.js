const { callFunction, showError } = require('../../utils/cloud')

const roleHome = {
  client: '/pages/client/home/index',
  staff: '/pages/staff/home/index',
  admin: '/pages/admin/home/index'
}

Page({
  data: {
    user: null,
    roles: []
  },

  onShow() {
    const cached = getApp().globalData.user
    if (cached) {
      this.setData({ user: cached, roles: cached.roles || ['client'] })
      return
    }

    callFunction('auth', 'me')
      .then((user) => {
        getApp().globalData.user = user
        this.setData({ user, roles: user.roles || ['client'] })
      })
      .catch(() => wx.redirectTo({ url: '/pages/login/index' }))
  },

  chooseRole(e) {
    const role = e.currentTarget.dataset.role
    callFunction('auth', 'switchRole', { role })
      .then((user) => {
        getApp().globalData.user = user
        getApp().globalData.activeRole = role
        wx.redirectTo({ url: roleHome[role] })
      })
      .catch(showError)
  }
})
