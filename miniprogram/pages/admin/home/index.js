const { callFunction, showError } = require('../../../utils/cloud')
Page({
  data: { dashboard: null },
  onShow() { callFunction('admin', 'dashboard').then((dashboard) => this.setData({ dashboard })).catch(showError) },
  go(e) { wx.navigateTo({ url: e.currentTarget.dataset.url }) },
  switchRole() { wx.redirectTo({ url: '/pages/role-select/index' }) }
})
