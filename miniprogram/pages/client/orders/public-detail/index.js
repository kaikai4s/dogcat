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
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const url = ds.url
    if (!url) return
    const detail = this.data.detail || {}
    let urls = []

    // 优先：若指定了环节索引，优先取该服务环节的所有打卡照片列表
    if (ds.sectionIndex !== undefined && Array.isArray(detail.checkinSections) && detail.checkinSections[ds.sectionIndex]) {
      urls = (detail.checkinSections[ds.sectionIndex].photos || []).map((p) => p.mediaFileId).filter(Boolean)
    }

    // 若当前环节未取到或单张，则取整个订单的所有打卡照片列表作为全局滑动序列
    if (!urls.length) {
      if (Array.isArray(detail.checkinSections) && detail.checkinSections.length) {
        urls = detail.checkinSections.reduce((acc, sec) => {
          const pList = (sec.photos || []).map((p) => p.mediaFileId).filter(Boolean)
          return acc.concat(pList)
        }, [])
      } else if (Array.isArray(detail.allCheckinPhotos) && detail.allCheckinPhotos.length) {
        urls = detail.allCheckinPhotos.map((item) => item.mediaFileId).filter(Boolean)
      } else if (Array.isArray(detail.checkinPhotos) && detail.checkinPhotos.length) {
        urls = detail.checkinPhotos.map((item) => item.mediaFileId).filter(Boolean)
      }
    }

    // 确保当前点击的图片包含在 urls 中
    if (!urls.includes(url)) {
      urls.unshift(url)
    }

    wx.previewImage({ current: url, urls: urls.length ? urls : [url] })
  },

  ...navMethods()
})
