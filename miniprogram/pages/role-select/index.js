const { callFunction, showError } = require('../../utils/cloud')
const { getCachedUser, ensureLogin, setCachedUser } = require('../../utils/cloud')
const { publicRoles, getRoleHome, decorateRoles } = require('../../utils/roles')

function visibleRoles(user) {
  return decorateRoles((user.roles || ['client']).filter((role) => publicRoles.includes(role)))
}

Page({
  data: {
    user: null,
    roles: []
  },

  onShow() {
    const cached = getCachedUser()
    if (cached) {
      this.applyUser(cached)
      return
    }

    ensureLogin({ content: '登录后可切换身份。' })
      .then((user) => this.applyUser(user))
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
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
        setCachedUser(user)
        getApp().globalData.activeRole = role
        wx.redirectTo({ url: getRoleHome(role) })
      })
      .catch(showError)
  }
})
