const { callFunction, showError } = require('../../utils/cloud')

Page({
  data: {
    loading: false,
    envReady: false
  },

  onLoad() {
    this.setData({ envReady: Boolean(getApp().globalData.env) })
  },

  login() {
    this.setData({ loading: true })
    callFunction('auth', 'login')
      .then((user) => {
        getApp().globalData.user = user
        getApp().globalData.activeRole = 'client'
        wx.redirectTo({ url: '/pages/client/home/index' })
      })
      .catch(showError)
      .finally(() => this.setData({ loading: false }))
  },

  openInit() {
    wx.navigateTo({ url: '/pages/dev/init/index' })
  }
})
