const { uploadImage } = require('../../../../utils/image-upload')
const { callFunction, showError, getServiceLocation } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { createClientRequestId, enqueueOfflineTask } = require('../../../../utils/offlineQueue')
const { formatCheckinEvent, withCheckinText } = require('../../../../utils/format')
const { applyTheme, getThemeState } = require('../../../../utils/theme')

function fileExt(path = '') {
  const index = path.lastIndexOf('.')
  return index >= 0 ? path.slice(index) : '.jpg'
}

Page({
  data: {
    themeClass: 'theme-day',
    orderId: '',
    eventType: '',
    eventTypeText: '',
    isBeautyCheckin: false,
    isSanitization: false,
    isReadOnly: false,
    remark: '',
    photos: [],
    uploading: false,
    deletingId: '',
    sectionHomeUrl: '',
    canGoBack: false
  },
  onLoad(q) {
    this.applyCurrentTheme()
    const isSanitization = q.eventType === 'sanitization'
    const isReadOnly = q.readOnly === '1' || (isSanitization && q.orderStatus === 'in_service')
    this.setData({
      ...createPageNav(q),
      orderId: q.id,
      eventType: q.eventType,
      eventTypeText: formatCheckinEvent(q.eventType),
      isBeautyCheckin: q.eventType === 'pet_beauty_photo',
      isSanitization,
      isReadOnly
    })
    this.loadPhotos()
  },
  onShow() {
    this.applyCurrentTheme()
    if (this.data.orderId) this.loadPhotos()
  },
  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },
  input(e) { this.setData({ remark: e.detail.value }) },
  loadPhotos() {
    callFunction('checkin', 'listOrderCheckins', { orderId: this.data.orderId })
      .then((checkins) => {
        const photos = (checkins || [])
          .filter((item) => item.eventType === this.data.eventType && item.mediaFileId)
          .map(withCheckinText)
        this.setData({ photos })
      })
      .catch(() => {})
  },
  chooseAndCreateCheckins() {
    if (this.data.uploading) return
    const isSanitization = this.data.eventType === 'sanitization'
    if (this.data.isReadOnly) {
      wx.showToast({ title: '服务已开始，仅可查看服务前消毒凭证', icon: 'none' })
      return
    }
    const chooseMedia = () => wx.chooseMedia({
      count: isSanitization ? 1 : 9,
      mediaType: ['image'],
      sourceType: isSanitization ? ['camera'] : ['camera', 'album'],
      success: (res) => {
        const files = res.tempFiles || []
        if (!files.length) return
        this.setData({ uploading: true })
        getServiceLocation()
          .then((loc) => files.reduce(
            (chain, file) => chain.then((summary) => this.uploadAndCreate(file.tempFilePath, loc).then((itemResult) => ({
              syncedCount: summary.syncedCount + (itemResult && itemResult.queued ? 0 : 1),
              queuedCount: summary.queuedCount + (itemResult && itemResult.queued ? 1 : 0)
            }))),
            Promise.resolve({ syncedCount: 0, queuedCount: 0 })
          ))
          .then((summary) => {
            this.setData({ uploading: false })
            if (summary.queuedCount > 0 && summary.syncedCount === 0) {
              wx.showToast({ title: '网络异常，已加入待补传', icon: 'none' })
              return
            }
            if (summary.queuedCount > 0) {
              wx.showToast({ title: '部分已加入待补传', icon: 'none' })
              return
            }
            wx.showToast({ title: '已打卡' })
            if (isSanitization) {
              setTimeout(() => wx.navigateBack(), 800)
            }
          })
          .catch((error) => {
            this.setData({ uploading: false })
            showError(error)
          })
      },
      fail: showError
    })
    if (!isSanitization) {
      chooseMedia()
      return
    }
    callFunction('order', 'checkServiceTimeReadyForCheckin', { id: this.data.orderId })
      .then(chooseMedia)
      .catch(showError)
  },
  uploadAndCreate(tempFilePath, loc) {
    const isSanitization = this.data.eventType === 'sanitization'
    const cloudPath = isSanitization
      ? `checkins/${this.data.orderId}/sanitization/${Date.now()}_${Math.random().toString(16).slice(2)}${fileExt(tempFilePath)}`
      : `checkins/${this.data.orderId}/${Date.now()}_${Math.random().toString(16).slice(2)}${fileExt(tempFilePath)}`
    return new Promise((resolve, reject) => {
      uploadImage({ cloudPath, filePath: tempFilePath, success: resolve, fail: reject })
    }).then((upload) => {
      const payload = {
        orderId: this.data.orderId,
        eventType: this.data.eventType,
        mediaFileId: upload.fileID,
        remark: this.data.remark || (isSanitization ? '服务前隔离病菌消毒打卡' : ''),
        latitude: loc.latitude,
        longitude: loc.longitude,
        accuracy: Number(loc.accuracy || 0),
        coordinateType: loc.coordinateType || 'gcj02',
        locationSource: loc.locationSource || 'unknown',
        clientRequestId: createClientRequestId('checkin'),
        recordedAt: new Date(loc.updatedAt || Date.now()).toISOString()
      }
      return callFunction('checkin', 'createCheckin', payload)
        .then((checkin) => {
          this.setData({ photos: [...this.data.photos, withCheckinText(checkin)] })
          return { synced: true, queued: false }
        })
        .catch((error) => {
          const message = (error && (error.message || error.errMsg)) || ''
          // 消毒打卡仅允许服务开始前现场上传，不支持离线补传
          if (!isSanitization && (message.includes('network') || message.includes('timeout') || message.includes('fail'))) {
            enqueueOfflineTask('checkin', payload)
            return { synced: false, queued: true }
          }
          throw error
        })
    })
  },
  previewPhoto(e) {
    const current = e.currentTarget.dataset.url
    const urls = this.data.photos.map((item) => item.mediaFileId).filter(Boolean)
    if (current && urls.length) wx.previewImage({ current, urls })
  },
  deletePhoto(e) {
    const checkinId = e.currentTarget.dataset.id
    if (!checkinId || this.data.deletingId) return
    wx.showModal({
      title: '删除照片',
      content: '删除后该照片不再计入必打卡，确认删除？',
      success: (res) => {
        if (!res.confirm) return
        this.setData({ deletingId: checkinId })
        callFunction('checkin', 'deleteCheckin', { orderId: this.data.orderId, checkinId })
          .then(() => {
            this.setData({ photos: this.data.photos.filter((item) => item._id !== checkinId), deletingId: '' })
            wx.showToast({ title: '已删除', icon: 'none' })
          })
          .catch((error) => {
            this.setData({ deletingId: '' })
            showError(error)
          })
      }
    })
  },
  goBack() { wx.navigateBack() },
  ...navMethods()
})
