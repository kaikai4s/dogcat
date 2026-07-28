const { callFunction, showError } = require('../../../../utils/cloud')
Page({
  data: { orders: [] },
  onShow() { callFunction('order', 'listOrders', { role: 'client' }).then((orders) => this.setData({ orders })).catch(showError) },
  detail(e) { wx.navigateTo({ url: '/pages/client/orders/detail/index?id=' + e.currentTarget.dataset.id }) }
})
