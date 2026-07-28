const { callFunction, showError } = require('../../../../utils/cloud')
Page({
  data: { orders: [] },
  onShow() { callFunction('staff', 'listStaffOrders').then((orders) => this.setData({ orders })).catch(showError) },
  detail(e) { wx.navigateTo({ url: '/pages/staff/orders/detail/index?id=' + e.currentTarget.dataset.id }) }
})
