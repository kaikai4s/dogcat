const { callFunction, showError } = require('../../../utils/cloud')
Page({
  data: { form: { doorLockCode: '', keyLocation: '', entryNotes: '', cameraLocations: '', emergencyContactName: '', emergencyContactPhone: '' }, masked: '' },
  onShow() { callFunction('homeSecurity', 'getMaskedHomeSecurity').then((data) => { if (data) this.setData({ form: { ...this.data.form, ...data, doorLockCode: '' }, masked: data.doorLockCodeMasked || '' }) }).catch(showError) },
  input(e) { this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value }) },
  save() { callFunction('homeSecurity', 'saveHomeSecurity', this.data.form).then(() => wx.showToast({ title: '已保存' })).catch(showError) }
})
