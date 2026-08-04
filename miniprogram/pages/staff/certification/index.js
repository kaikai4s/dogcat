const { callFunction, showError, chooseSelectedLocation } = require('../../../utils/cloud')
const { withAuditText } = require('../../../utils/format')

const statusText = {
  pending: '资料已提交，等待平台审核',
  approved: '审核已通过，可以进入工作台接单',
  rejected: '审核未通过，请修改资料后重新提交'
}

const radiusOptions = [
  { label: '3公里', value: 3 },
  { label: '5公里', value: 5 },
  { label: '10公里', value: 10 },
  { label: '15公里', value: 15 },
  { label: '20公里', value: 20 }
]

Page({
  data: {
    form: {
      realName: '',
      phone: '',
      serviceCity: '',
      serviceAreas: '',
      serviceAddress: '',
      serviceLatitude: 0,
      serviceLongitude: 0,
      serviceRadiusKm: 5
    },
    radiusOptions,
    profile: null,
    statusTip: ''
  },

  onShow() {
    callFunction('staff', 'getStaffProfile')
      .then((profile) => {
        if (!profile) return
        this.setData({
          profile: withAuditText(profile),
          form: {
            ...this.data.form,
            ...profile,
            serviceRadiusKm: Number(profile.serviceRadiusKm || 5),
            serviceLatitude: Number(profile.serviceLatitude || 0),
            serviceLongitude: Number(profile.serviceLongitude || 0)
          },
          statusTip: profile.auditRemark || statusText[profile.auditStatus] || ''
        })
      })
      .catch(showError)
  },

  input(e) {
    this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value })
  },

  chooseAddress() {
    chooseSelectedLocation()
      .then((loc) => {
        this.setData({
          ['form.serviceAddress']: loc.name || loc.address || '',
          ['form.serviceLatitude']: loc.latitude,
          ['form.serviceLongitude']: loc.longitude
        })
      })
      .catch((err) => {
        if (err && err.errMsg && err.errMsg.includes('cancel')) return
        showError(err)
      })
  },

  selectRadius(e) {
    const radius = Number(e.currentTarget.dataset.radius || 5)
    this.setData({ ['form.serviceRadiusKm']: radius })
  },

  submit() {
    const { realName, serviceAddress, serviceLatitude, serviceLongitude } = this.data.form
    if (!realName) {
      wx.showToast({ title: '请填写真实姓名', icon: 'none' })
      return
    }
    if (!serviceAddress || !serviceLatitude || !serviceLongitude) {
      wx.showToast({ title: '请设置固定服务地址及位置', icon: 'none' })
      return
    }

    callFunction('staff', 'submitStaffProfile', this.data.form)
      .then((profile) => {
        this.setData({
          profile: withAuditText(profile),
          statusTip: statusText.pending
        })
        wx.showToast({ title: '已提交审核', icon: 'none' })
      })
      .catch(showError)
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  },

  backProfile() {
    wx.redirectTo({ url: '/pages/staff/profile/index' })
  }
})
