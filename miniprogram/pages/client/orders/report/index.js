const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { ensureLogin } = require('../../../../utils/cloud')
const { withOrderText, withCheckinText } = require('../../../../utils/format')
const { applyTheme, getThemeState } = require('../../../../utils/theme')

function groupCheckinPhotos(checkins = []) {
  const map = {}
  checkins.filter((item) => item.mediaFileId).forEach((item) => {
    const eventType = item.eventType || ''
    if (!map[eventType]) map[eventType] = { eventType, eventTypeText: item.eventTypeText || eventType, count: 0, photos: [], remarks: [], remarkText: '' }
    map[eventType].count += 1
    map[eventType].photos.push(item)
    if (item.remark && !map[eventType].remarks.includes(item.remark)) map[eventType].remarks.push(item.remark)
    map[eventType].remarkText = map[eventType].remarks.join('；')
  })
  return Object.values(map)
}

Page({
  data: { themeClass: 'theme-day', id: '', report: null, sectionHomeUrl: '', canGoBack: false, importingBeauty: false },
  onLoad(q) {
    this.setData({ ...createPageNav(q), id: q.id })
  },
  onShow() {
    this.applyCurrentTheme()
    ensureLogin({ content: '登录后可查看服务报告。' })
      .then(() => this.load())
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },
  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },
  load() {
    callFunction('order', 'getServiceReport', { id: this.data.id })
      .then((report) => {
        const checkins = (report.checkins || []).map(withCheckinText)
        this.setData({ report: { ...report, order: withOrderText(report.order), checkins, checkinGroups: groupCheckinPhotos(checkins) } })
      })
      .catch(showError)
  },
  previewPhoto(e) {
    const current = e.currentTarget.dataset.url
    const urls = (this.data.report && this.data.report.checkins || []).map((item) => item.mediaFileId).filter(Boolean)
    if (current && urls.length) wx.previewImage({ current, urls })
  },
  savePhoto(e) {
    const fileId = e.currentTarget.dataset.url
    if (!fileId) return
    wx.showLoading({ title: '保存中...' })
    wx.cloud.getTempFileURL({
      fileList: [fileId],
      success: (res) => {
        const url = res.fileList && res.fileList[0] && res.fileList[0].tempFileURL
        if (!url) {
          wx.hideLoading()
          wx.showToast({ title: '图片链接获取失败', icon: 'none' })
          return
        }
        wx.downloadFile({
          url,
          success: (download) => {
            wx.saveImageToPhotosAlbum({
              filePath: download.tempFilePath,
              success: () => {
                wx.hideLoading()
                wx.showToast({ title: '已保存到相册' })
              },
              fail: (err) => {
                wx.hideLoading()
                if ((err.errMsg || '').includes('auth')) wx.showToast({ title: '请开启相册保存权限', icon: 'none' })
                else showError(err)
              }
            })
          },
          fail: (err) => {
            wx.hideLoading()
            showError(err)
          }
        })
      },
      fail: (err) => {
        wx.hideLoading()
        showError(err)
      }
    })
  },

  importBeautyPhotos(e) {
    if (this.data.importingBeauty) return
    const groupIndex = Number(e.currentTarget.dataset.index)
    const group = this.data.report && this.data.report.checkinGroups[groupIndex]
    const order = this.data.report && this.data.report.order
    if (!group || !order) return
    const petIds = Array.isArray(order.petIds) && order.petIds.length ? order.petIds : [order.petId].filter(Boolean)
    if (!petIds.length) {
      wx.showToast({ title: '未找到订单宠物', icon: 'none' })
      return
    }
    const runImport = (petId) => {
      this.setData({ importingBeauty: true })
      callFunction('petBeauty', 'importFromServiceCheckins', { orderId: order._id || this.data.id, petId, checkinIds: group.photos.map((photo) => photo._id) })
        .then((res) => {
          this.setData({ importingBeauty: false })
          wx.showToast({ title: `已加入${res.importedCount || 0}张美照`, icon: 'none' })
        })
        .catch((err) => {
          this.setData({ importingBeauty: false })
          showError(err)
        })
    }
    if (petIds.length === 1) {
      runImport(petIds[0])
      return
    }
    wx.showActionSheet({
      itemList: petIds.map((id, index) => `宠物 ${index + 1}`),
      success: (res) => runImport(petIds[res.tapIndex])
    })
  },

  goTracking() {
    wx.navigateTo({ url: `/pages/client/orders/tracking/index?id=${this.data.id}` })
  },

  generateAiReport() {
    if (!this.data.id || this.data.loadingAi) return
    this.setData({ loadingAi: true })
    callFunction('ai', 'aiGenerateReport', { orderId: this.data.id })
      .then((res) => {
        this.setData({ aiSummary: res.reportSummary, loadingAi: false })
      })
      .catch((err) => {
        this.setData({ loadingAi: false })
        showError(err)
      })
  },
  ...navMethods()
})
