const { callFunction, showError } = require('../../../../utils/cloud')
Page({
  data: { orders: [] },
  onShow() { callFunction('admin', 'listOrders').then((orders) => this.setData({ orders })).catch(showError) },
  detail(e) { wx.navigateTo({ url: '/pages/admin/orders/detail/index?id=' + e.currentTarget.dataset.id }) },
  assign(e) { wx.navigateTo({ url: '/pages/admin/orders/assign/index?id=' + e.currentTarget.dataset.id }) }
})
