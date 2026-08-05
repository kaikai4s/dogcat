const { callFunction, showError, getServiceLocation } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')

Page({
  data: { id: '', order: null, unlock: null, pointCount: 0, sectionHomeUrl: '', canGoBack: false },
  onLoad(q) {
    this.setData({ ...createPageNav(q), id: q.id })
    this.loadOrder()
  },
  loadOrder() {
    callFunction('order', 'getOrderDetail', { id: this.data.id })
      .then((order) => this.setData({ order }))
      .catch(() => {})
  },
  previewPetPhoto() {
    const photo = this.data.order && this.data.order.petSnapshot && this.data.order.petSnapshot.avatarFileId
    if (photo) wx.previewImage({ urls: [photo] })
  },
  start() { callFunction('order', 'startService', { id: this.data.id }).then(() => wx.showToast({ title: '已开始' })).catch(showError) },
  unlock() { callFunction('homeSecurity', 'getUnlockCode', { orderId: this.data.id }).then((unlock) => this.setData({ unlock })).catch(showError) },
  uploadPoint() { getServiceLocation().then((loc) => { callFunction('track', 'batchUploadTrack', { orderId: this.data.id, points: [{ latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.accuracy, speed: 0, recordedAt: Date.now() }] }).then((res) => this.setData({ pointCount: this.data.pointCount + res.count })).catch(showError) }).catch(showError) },
  checkin(e) { wx.navigateTo({ url: '/pages/staff/checkin/camera/index?id=' + this.data.id + '&eventType=' + e.currentTarget.dataset.type }) },
  finish() { callFunction('order', 'finishService', { id: this.data.id }).then(() => wx.showToast({ title: '已完成' })).catch(showError) },
  ...navMethods()
})
