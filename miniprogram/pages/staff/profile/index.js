const { callFunction, showError } = require('../../../utils/cloud')

const statusMap = {
  pending: { title: '审核中', tip: '资料已提交，请等待平台审核' },
  approved: { title: '已认证宠托师', tip: '可以接收指定订单和附近可接订单' },
  rejected: { title: '审核未通过', tip: '请修改资料后重新提交' }
}

Page({
  data: {
    user: null,
    profile: null,
    displayName: '宠托师',
    avatarUrl: '',
    statusTitle: '未入驻',
    statusTip: '完善资料后申请成为宠托师'
  },

  onShow() {
    Promise.all([
      callFunction('auth', 'me'),
      callFunction('staff', 'getStaffProfile')
    ])
      .then(([user, profile]) => {
        const status = profile?.auditStatus
        const info = statusMap[status] || { title: '未入驻', tip: '完善资料后申请成为宠托师' }
        const nickname = String(user.nickname || '').trim()
        this.setData({
          user,
          profile,
          displayName: nickname || profile?.realName || '宠托师',
          avatarUrl: user.avatarUrl || '',
          statusTitle: info.title,
          statusTip: profile?.auditRemark || info.tip
        })
      })
      .catch(showError)
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  },

  openCertification() {
    wx.redirectTo({ url: '/pages/staff/certification/index' })
  },

  editProfile() {
    wx.navigateTo({ url: '/pages/client/profile/edit/index?from=staff' })
  },

  backClientProfile() {
    wx.redirectTo({ url: '/pages/client/profile/index' })
  }
})
