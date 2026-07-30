const { callFunction, showError } = require('../../../../utils/cloud')
const { withOrderText } = require('../../../../utils/format')
Page({
  data: { orders: [] },
  onShow() { callFunction('staff', 'listStaffOrders').then((orders) => this.setData({ orders: orders.map(withOrderText) })).catch(showError) },
  detail(e) { wx.navigateTo({ url: '/pages/staff/orders/detail/index?id=' + e.currentTarget.dataset.id }) },
  openNavigation(e) {
    const { latitude, longitude, name, address } = e.currentTarget.dataset
    const lat = Number(latitude)
    const lng = Number(longitude)
    if (!lat || !lng) {
      wx.showToast({ title: '订单缺少定位，无法导航', icon: 'none' })
      return
    }
    wx.openLocation({ latitude: lat, longitude: lng, name: name || '服务地址', address: address || name || '服务地址', scale: 16 })
  },
  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  },
  backProfile() { wx.redirectTo({ url: '/pages/staff/profile/index' }) }
})
