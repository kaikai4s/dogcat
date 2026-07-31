const { loginWithWechat } = require('../../utils/cloud')
const { envList } = require('../../envList')

Page({
  data: {
    loading: false,
    envReady: Boolean(envList[0] && envList[0].envId),
    errorText: ''
  },

  login() {
    this.setData({ loading: true, errorText: '' })
    loginWithWechat()
      .then(() => {
        getApp().globalData.activeRole = 'client'
        wx.redirectTo({ url: '/pages/client/home/index' })
      })
      .catch((error) => {
        const message = error.message || '登录失败'
        this.setData({ errorText: message })
        wx.showModal({ title: '登录失败', content: message, showCancel: false })
      })
      .finally(() => this.setData({ loading: false }))
  },

  openInit() {
    wx.navigateTo({ url: '/pages/dev/init/index' })
  }
})
