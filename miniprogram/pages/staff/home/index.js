const { callFunction, showError } = require('../../../utils/cloud')
const { getSelectedLocation, chooseSelectedLocation } = require('../../../utils/cloud')

Page({
  data: {
    directOrders: [],
    nearbyOrders: [],
    locationReady: false,
    locationText: '尚未获取当前位置',
    loadingNearby: false
  },

  onShow() {
    this.loadNearbyWithSavedLocation()
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  },

  detail(e) { wx.navigateTo({ url: '/pages/staff/orders/detail/index?id=' + e.currentTarget.dataset.id }) },

  backProfile() { wx.redirectTo({ url: '/pages/staff/profile/index' }) },

  loadNearbyWithSavedLocation() {
    const location = getSelectedLocation()
    if (!location) {
      this.setData({ directOrders: [], nearbyOrders: [], locationReady: false, locationText: '请先在首页左上角选择服务位置' })
      return
    }
    this.loadNearby(location, '已按首页选择的位置推荐订单')
  },

  refreshNearby() {
    if (this.data.loadingNearby) return
    chooseSelectedLocation()
      .then((location) => this.loadNearby(location, '位置已更新，已按新位置推荐订单'))
      .catch(showError)
  },

  loadNearby(location, locationText) {
    if (this.data.loadingNearby) return
    this.setData({ loadingNearby: true })
    const data = { latitude: location.latitude, longitude: location.longitude, accuracy: location.accuracy }
    callFunction('staff', 'updateCurrentLocation', data)
      .then(() => Promise.all([
        callFunction('staff', 'listDirectOrders', data),
        callFunction('staff', 'listNearbyOrders', data)
      ]))
      .then(([directOrders, nearbyOrders]) => {
        this.setData({
          directOrders,
          nearbyOrders,
          locationReady: true,
          locationText: `${locationText}：${location.name}`,
          loadingNearby: false
        })
      })
      .catch((error) => {
        this.setData({ loadingNearby: false })
        showError(error)
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
        const location = getSelectedLocation()
        if (location) this.loadNearby(location, '已按当前位置推荐订单')
        else this.loadNearbyWithSavedLocation()
      })
      .catch(showError)
  }
})
