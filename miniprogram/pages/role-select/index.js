const { callFunction, showError } = require('../../utils/cloud')

const roleHome = {
  client: '/pages/client/home/index',
  staff: '/pages/staff/home/index'
}
const publicRoles = Object.keys(roleHome)

function visibleRoles(user) {
  return (user.roles || ['client']).filter((role) => publicRoles.includes(role))
}

Page({
  data: {
    user: null,
    roles: []
  },

  onShow() {
    const cached = getApp().globalData.user
    if (cached) {
      this.applyUser(cached)
      return
    }

    callFunction('auth', 'me')
      .then((user) => {
        getApp().globalData.user = user
        this.applyUser(user)
      })
      .catch(() => wx.redirectTo({ url: '/pages/login/index' }))
  },

  applyUser(user) {
    const roles = visibleRoles(user)
    if (roles.length <= 1) {
      wx.redirectTo({ url: '/pages/client/home/index' })
      return
    }
    this.setData({ user, roles })
  },

  chooseRole(e) {
    const role = e.currentTarget.dataset.role
    if (!publicRoles.includes(role)) {
      wx.showToast({ title: '该入口不可用', icon: 'none' })
      return
    }
    callFunction('auth', 'switchRole', { role })
      .then((user) => {
        getApp().globalData.user = user
        getApp().globalData.activeRole = role
        wx.redirectTo({ url: roleHome[role] })
      })
      .catch(showError)
  }
})
