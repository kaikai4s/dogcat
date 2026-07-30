const { callFunction, showError } = require('../../../utils/cloud')

Page({
  data: {
    directOrders: [],
    nearbyOrders: [],
    locationReady: false,
    locationText: '尚未获取当前位置',
    loadingNearby: false
  },

  onShow() {
    this.refreshNearby()
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  },

  detail(e) { wx.navigateTo({ url: '/pages/staff/orders/detail/index?id=' + e.currentTarget.dataset.id }) },

  backProfile() { wx.redirectTo({ url: '/pages/staff/profile/index' }) },

  refreshNearby() {
    if (this.data.loadingNearby) return
    this.setData({ loadingNearby: true })
    wx.getLocation({
      type: 'gcj02',
      success: (loc) => {
        const data = { latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.accuracy }
        callFunction('staff', 'updateCurrentLocation', data)
          .then(() => Promise.all([
            callFunction('staff', 'listDirectOrders'),
            callFunction('staff', 'listNearbyOrders', data)
          ]))
          .then(([directOrders, nearbyOrders]) => {
            this.setData({
              directOrders,
              nearbyOrders,
              locationReady: true,
              locationText: '位置已更新，已按附近距离推荐订单',
              loadingNearby: false
            })
          })
          .catch((error) => {
            this.setData({ loadingNearby: false })
            showError(error)
          })
      },
      fail: (error) => {
        this.setData({ loadingNearby: false })
        showError(error)
      }
    })
  },

  openNavigation(e) {
    const { latitude, longitude, name, address } = e.currentTarget.dataset
    const lat = Number(latitude)
    const lng = Number(longitude)
    if (!lat || !lng) {
      wx.showToast({ title: '订单缺少定位，无法导航', icon: 'none' })
      return
    }
    wx.openLocation({
      latitude: lat,
      longitude: lng,
      name: name || '服务地址',
      address: address || name || '服务地址',
      scale: 16
    })
  },

  accept(e) {
    const orderId = e.currentTarget.dataset.id
    callFunction('staff', 'acceptOrder', { orderId })
      .then(() => {
        wx.showToast({ title: '接单成功' })
        this.refreshNearby()
      })
      .catch(showError)
  }
})
