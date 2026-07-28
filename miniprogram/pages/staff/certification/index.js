const { callFunction, showError } = require('../../../utils/cloud')
Page({
  data: { form: { realName: '', phone: '', serviceCity: '', serviceAreas: '' }, profile: null },
  onShow() { callFunction('staff', 'getStaffProfile').then((profile) => { if (profile) this.setData({ profile, form: { ...this.data.form, ...profile } }) }).catch(showError) },
  input(e) { this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value }) },
  submit() { callFunction('staff', 'submitStaffProfile', this.data.form).then((profile) => { this.setData({ profile }); wx.showToast({ title: '已提交' }) }).catch(showError) }
})
