const { callFunction, showError } = require('../../../../utils/cloud')
Page({
  data: { orderId: '', eventType: '', remark: '', mediaFileId: '' },
  onLoad(q) { this.setData({ orderId: q.id, eventType: q.eventType }) },
  input(e) { this.setData({ remark: e.detail.value }) },
  takePhoto() { const ctx = wx.createCameraContext(); ctx.takePhoto({ quality: 'high', success: (res) => this.upload(res.tempImagePath), fail: showError }) },
  upload(tempFilePath) { const cloudPath = 'checkins/' + this.data.orderId + '/' + Date.now() + '.jpg'; wx.cloud.uploadFile({ cloudPath, filePath: tempFilePath, success: (res) => this.setData({ mediaFileId: res.fileID }), fail: showError }) },
  submit() { wx.getLocation({ type: 'gcj02', success: (loc) => { callFunction('checkin', 'createCheckin', { orderId: this.data.orderId, eventType: this.data.eventType, mediaFileId: this.data.mediaFileId, remark: this.data.remark, latitude: loc.latitude, longitude: loc.longitude }).then(() => { wx.showToast({ title: '已打卡' }); wx.navigateBack() }).catch(showError) }, fail: showError }) }
})
