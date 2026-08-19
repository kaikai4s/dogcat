const { callFunction, showError } = require('../../../../utils/cloud')

Page({
  data: {
    loading: false,
    orders: []
  },

  onShow() {
    this.load()
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
