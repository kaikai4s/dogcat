const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')

Page({
  data: {
    id: '',
    detail: null,
    sectionHomeUrl: '',
    canGoBack: false
  },

  onLoad(q) {
    this.setData({ ...createPageNav(q), id: q.id || q.orderId || '' })
    this.load()
  },

  load() {
    callFunction('order', 'getPublicCompletedOrderDetail', { id: this.data.id })
      .then((detail) => this.setData({ detail }))
      .catch(showError)
  },

  previewPhoto(e) {
    const url = e.currentTarget.dataset.url
    const urls = (this.data.detail && this.data.detail.checkinPhotos || []).map((item) => item.mediaFileId).filter(Boolean)
    if (!url) return
    wx.previewImage({ current: url, urls: urls.length ? urls : [url] })
  },

  ...navMethods()
})
