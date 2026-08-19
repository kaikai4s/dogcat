const { callFunction, showError, getServiceLocation } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { createClientRequestId, enqueueOfflineTask } = require('../../../../utils/offlineQueue')
const { formatCheckinEvent } = require('../../../../utils/format')
const { applyTheme, getThemeState } = require('../../../../utils/theme')

Page({
  data: { themeClass: 'theme-day', orderId: '', eventType: '', eventTypeText: '', remark: '', mediaFileId: '', tempFilePath: '', submitting: false, sectionHomeUrl: '', canGoBack: false },
  onLoad(q) {
    this.applyCurrentTheme()
    this.setData({ ...createPageNav(q), orderId: q.id, eventType: q.eventType, eventTypeText: formatCheckinEvent(q.eventType) })
  },
  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },
  input(e) { this.setData({ remark: e.detail.value }) },
  takePhoto() { const ctx = wx.createCameraContext(); ctx.takePhoto({ quality: 'high', success: (res) => { this.setData({ tempFilePath: res.tempImagePath }); this.upload(res.tempImagePath) }, fail: showError }) },
  upload(tempFilePath) { const cloudPath = 'checkins/' + this.data.orderId + '/' + Date.now() + '.jpg'; wx.cloud.uploadFile({ cloudPath, filePath: tempFilePath, success: (res) => this.setData({ mediaFileId: res.fileID }), fail: (error) => { this.setData({ tempFilePath }); showError(error) } }) },
  enqueueCheckin(payload) {
    enqueueOfflineTask('checkin', payload)
    wx.showToast({ title: '网络异常，已加入待补传', icon: 'none' })
    wx.navigateBack()
  },
  submit() {
    if (this.data.submitting) return
    if (!this.data.mediaFileId) {
      wx.showToast({ title: '请先拍照并上传成功', icon: 'none' })
      return
    }
    const clientRequestId = createClientRequestId('checkin')
    this.setData({ submitting: true })
    getServiceLocation()
      .then((loc) => {
        const payload = { orderId: this.data.orderId, eventType: this.data.eventType, mediaFileId: this.data.mediaFileId, remark: this.data.remark, latitude: loc.latitude, longitude: loc.longitude, clientRequestId, recordedAt: Date.now() }
        return callFunction('checkin', 'createCheckin', payload)
          .then(() => { wx.showToast({ title: '已打卡' }); wx.navigateBack() })
          .catch(() => this.enqueueCheckin(payload))
      })
      .catch((error) => {
        this.setData({ submitting: false })
        showError(error)
      })
  },
  ...navMethods()
})
