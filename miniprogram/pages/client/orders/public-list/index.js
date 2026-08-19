const { callFunction, showError } = require('../../../../utils/cloud')
const { applyTheme, getThemeState } = require('../../../../utils/theme')

Page({
  data: {
    themeClass: 'theme-day',
    loading: false,
    orders: []
  },

  onShow() {
    this.applyCurrentTheme()
    this.load()
  },

  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },

  load() {
    this.setData({ loading: true })
    callFunction('order', 'listPublicCompletedOrders', { pageSize: 30 })
      .then((orders) => this.setData({ orders: orders || [], loading: false }))
      .catch((err) => {
        this.setData({ loading: false })
        showError(err)
      })
  },

  detail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/client/orders/public-detail/index?id=${id}` })
  },

  previewPhoto(e) {
    const url = e.currentTarget.dataset.url
    const orderId = e.currentTarget.dataset.orderId
    const order = this.data.orders.find((item) => item._id === orderId)
    const urls = (order && order.checkinPhotos || []).map((item) => item.mediaFileId).filter(Boolean)
    if (!url) return
    wx.previewImage({ current: url, urls: urls.length ? urls : [url] })
  }
})
