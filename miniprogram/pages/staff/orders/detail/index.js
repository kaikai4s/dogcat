const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { withOrderText } = require('../../../../utils/format')

Page({
  data: { id: '', order: null, sectionHomeUrl: '', canGoBack: false },
  onLoad(q) { this.setData({ ...createPageNav(q), id: q.id }) },
  onShow() { this.load() },
  load() { callFunction('order', 'getOrderDetail', { id: this.data.id }).then((order) => this.setData({ order: withOrderText(order) })).catch(showError) },
  openNavigation() {
    const order = this.data.order || {}
    const latitude = Number(order.addressLatitude)
    const longitude = Number(order.addressLongitude)
    if (!latitude || !longitude) {
      wx.showToast({ title: '订单缺少定位，无法导航', icon: 'none' })
      return
    }
    wx.openLocation({ latitude, longitude, name: order.serviceAddress || '服务地址', address: `${order.addressDetail || ''} ${order.doorplate || ''}`, scale: 16 })
  },
  accept() {
    callFunction('staff', 'acceptOrder', { orderId: this.data.id })
      .then(() => {
        wx.showToast({ title: '接单成功' })
        this.load()
      })
      .catch(showError)
  },
  service() { wx.navigateTo({ url: '/pages/staff/orders/service/index?id=' + this.data.id }) },
  sos() { wx.navigateTo({ url: '/pages/staff/sos/index?id=' + this.data.id }) },
  ...navMethods()
})
