const { callFunction, showError } = require('../../../../utils/cloud')
Page({
  data: { id: '', order: null },
  onLoad(q) { this.setData({ id: q.id }) },
  onShow() { this.load() },
  load() { callFunction('order', 'getOrderDetail', { id: this.data.id }).then((order) => this.setData({ order })).catch(showError) },
  pay() { callFunction('payment', 'mockPayOrder', { orderId: this.data.id }).then(() => { wx.showToast({ title: '已支付' }); this.load() }).catch(showError) },
  tracking() { wx.navigateTo({ url: '/pages/client/orders/tracking/index?id=' + this.data.id }) },
  report() { wx.navigateTo({ url: '/pages/client/orders/report/index?id=' + this.data.id }) }
})
