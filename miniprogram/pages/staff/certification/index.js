const { callFunction, showError } = require('../../../utils/cloud')
const { withAuditText } = require('../../../utils/format')

const statusText = {
  pending: '资料已提交，等待平台审核',
  approved: '审核已通过，可以进入工作台接单',
  rejected: '审核未通过，请修改资料后重新提交'
}

Page({
  data: {
    form: { realName: '', phone: '', serviceCity: '', serviceAreas: '' },
    profile: null,
    statusTip: ''
  },

  onShow() {
    callFunction('staff', 'getStaffProfile')
      .then((profile) => {
        if (!profile) return
        this.setData({
          profile: withAuditText(profile),
          form: { ...this.data.form, ...profile },
          statusTip: profile.auditRemark || statusText[profile.auditStatus] || ''
        })
      })
      .catch(showError)
  },

  input(e) {
    this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value })
  },

  submit() {
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
