const { callFunction, showError } = require('../../../../utils/cloud')
Page({
  data: { id: '', order: null },
  onLoad(q) { this.setData({ id: q.id }) },
  onShow() { this.load() },
  load() { callFunction('order', 'getOrderDetail', { id: this.data.id }).then((order) => this.setData({ order })).catch(showError) },
  service() { wx.navigateTo({ url: '/pages/staff/orders/service/index?id=' + this.data.id }) },
  sos() { wx.navigateTo({ url: '/pages/staff/sos/index?id=' + this.data.id }) }
})
