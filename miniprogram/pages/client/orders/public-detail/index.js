const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { applyTheme, getThemeState } = require('../../../../utils/theme')

Page({
  data: {
    themeClass: 'theme-day',
    id: '',
    detail: null,
    sectionHomeUrl: '',
    canGoBack: false
  },

  onLoad(q) {
    this.applyCurrentTheme()
    this.setData({ ...createPageNav(q), id: q.id || q.orderId || '' })
    this.load()
  },

  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },

  load() {
    callFunction('order', 'getPublicCompletedOrderDetail', { id: this.data.id })
      .then((detail) => this.setData({ detail }))
      .catch(showError)
  },

  previewPhoto(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    const detail = this.data.detail || {}
    let urls = []
    if (Array.isArray(detail.allCheckinPhotos) && detail.allCheckinPhotos.length) {
      urls = detail.allCheckinPhotos.map((item) => item.mediaFileId).filter(Boolean)
    } else if (Array.isArray(detail.checkinSections) && detail.checkinSections.length) {
      urls = detail.checkinSections.reduce((acc, sec) => {
        const pList = (sec.photos || []).map((p) => p.mediaFileId).filter(Boolean)
        return acc.concat(pList)
      }, [])
    } else if (Array.isArray(detail.checkinPhotos) && detail.checkinPhotos.length) {
      urls = detail.checkinPhotos.map((item) => item.mediaFileId).filter(Boolean)
    }
    wx.previewImage({ current: url, urls: urls.length ? urls : [url] })
  },

  ...navMethods()
})
