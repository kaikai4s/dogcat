const { callFunction, showError } = require('../../../utils/cloud')

Page({
  data: {
    prices: []
  },

  onShow() {
    this.load()
  },

  load() {
    callFunction('admin', 'listServicePrices')
      .then((prices) => this.setData({ prices }))
      .catch(showError)
  },

  input(e) {
    const index = e.currentTarget.dataset.index
    const field = e.currentTarget.dataset.field
    this.setData({ [`prices[${index}].${field}`]: e.detail.value })
  },

  toggleEnabled(e) {
    const index = e.currentTarget.dataset.index
    this.setData({ [`prices[${index}].enabled`]: e.detail.value })
  },

  save(e) {
    const item = this.data.prices[e.currentTarget.dataset.index]
    callFunction('admin', 'saveServicePrice', item)
      .then(() => {
        wx.showToast({ title: '已保存' })
        this.load()
      })
      .catch(showError)
  },

  resetDefaults() {
    wx.showModal({
      title: '恢复默认价格',
      content: '将把所有服务价格恢复为默认配置，是否继续？',
      success: (res) => {
        if (!res.confirm) return
        callFunction('admin', 'resetDefaultServicePrices')
          .then((prices) => {
            this.setData({ prices })
            wx.showToast({ title: '已恢复' })
          })
          .catch(showError)
      }
    })
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  }
})
