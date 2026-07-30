const { callFunction, showError } = require('../../../../utils/cloud')
const { withOrderText } = require('../../../../utils/format')
Page({
  data: { orders: [] },
  onShow() { callFunction('admin', 'listOrders').then((orders) => this.setData({ orders: orders.map(withOrderText) })).catch(showError) },
  detail(e) { wx.navigateTo({ url: '/pages/admin/orders/detail/index?id=' + e.currentTarget.dataset.id }) },
  assign(e) { wx.navigateTo({ url: '/pages/admin/orders/assign/index?id=' + e.currentTarget.dataset.id }) },
  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  }
})
