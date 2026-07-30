const { callFunction, showError } = require('../../../utils/cloud')
Page({
  data: { dashboard: null },
  onShow() { callFunction('admin', 'dashboard').then((dashboard) => this.setData({ dashboard })).catch(showError) },
  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  }
})
