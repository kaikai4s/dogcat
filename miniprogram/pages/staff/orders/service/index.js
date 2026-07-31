const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { requireSelectedLocation } = require('../../../../utils/cloud')

Page({
  data: { id: '', unlock: null, pointCount: 0, sectionHomeUrl: '', canGoBack: false },
  onLoad(q) { this.setData({ ...createPageNav(q), id: q.id }) },
  start() { callFunction('order', 'startService', { id: this.data.id }).then(() => wx.showToast({ title: '已开始' })).catch(showError) },
  unlock() { callFunction('homeSecurity', 'getUnlockCode', { orderId: this.data.id }).then((unlock) => this.setData({ unlock })).catch(showError) },
  uploadPoint() { requireSelectedLocation().then((loc) => { callFunction('track', 'batchUploadTrack', { orderId: this.data.id, points: [{ latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.accuracy, speed: 0, recordedAt: new Date() }] }).then((res) => this.setData({ pointCount: this.data.pointCount + res.count })).catch(showError) }).catch(showError) },
  checkin(e) { wx.navigateTo({ url: '/pages/staff/checkin/camera/index?id=' + this.data.id + '&eventType=' + e.currentTarget.dataset.type }) },
  finish() { callFunction('order', 'finishService', { id: this.data.id }).then(() => wx.showToast({ title: '已完成' })).catch(showError) },
  ...navMethods()
})
