const { callFunction, showError } = require('../../../../utils/cloud')
Page({
  data: { id: '', unlock: null, pointCount: 0 },
  onLoad(q) { this.setData({ id: q.id }) },
  start() { callFunction('order', 'startService', { id: this.data.id }).then(() => wx.showToast({ title: '已开始' })).catch(showError) },
  unlock() { callFunction('homeSecurity', 'getUnlockCode', { orderId: this.data.id }).then((unlock) => this.setData({ unlock })).catch(showError) },
  uploadPoint() { wx.getLocation({ type: 'gcj02', success: (loc) => { callFunction('track', 'batchUploadTrack', { orderId: this.data.id, points: [{ latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.accuracy, speed: loc.speed, recordedAt: new Date() }] }).then((res) => this.setData({ pointCount: this.data.pointCount + res.count })).catch(showError) }, fail: showError }) },
  checkin(e) { wx.navigateTo({ url: '/pages/staff/checkin/camera/index?id=' + this.data.id + '&eventType=' + e.currentTarget.dataset.type }) },
  finish() { callFunction('order', 'finishService', { id: this.data.id }).then(() => wx.showToast({ title: '已完成' })).catch(showError) }
})
