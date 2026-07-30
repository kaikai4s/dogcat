const { callFunction, showError } = require('../../../utils/cloud')

const staffEntryMap = {
  none: { title: '申请成为宠托师', tip: '提交资料后等待平台审核' },
  pending: { title: '宠托师审核中', tip: '资料已提交，请等待平台审核' },
  rejected: { title: '审核未通过，重新提交', tip: '修改资料后再次提交审核' },
  approved: { title: '进入宠托师工作台', tip: '查看附近订单并开始接单' }
}

Page({
  data: {
    staffProfile: null,
    staffEntryTitle: staffEntryMap.none.title,
    staffEntryTip: staffEntryMap.none.tip,
    userName: '宠物主',
    userMeta: '欢迎回来，今天也要安心宠护',
    avatarUrl: ''
  },

  onShow() {
    this.loadUser()
    this.loadStaffProfile()
  },

  loadUser() {
    callFunction('auth', 'me')
      .then((user) => {
        getApp().globalData.user = user
        this.applyUser(user)
      })
      .catch(() => {})
  },

  applyUser(user) {
    const rawPhone = String(user.phone || '')
    const phone = rawPhone ? `${rawPhone.slice(0, 3)}****${rawPhone.slice(-4)}` : ''
    this.setData({
      userName: user.nickname || phone || '宠物主',
      userMeta: phone ? `已绑定手机 ${phone}` : '欢迎回来，今天也要安心宠护',
      avatarUrl: user.avatarUrl || ''
    })
  },

  loadStaffProfile() {
    callFunction('staff', 'getStaffProfile')
      .then((profile) => {
        const status = profile ? profile.auditStatus : 'none'
        const entry = staffEntryMap[status] || staffEntryMap.none
        this.setData({
          staffProfile: profile,
          staffEntryTitle: entry.title,
          staffEntryTip: status === 'rejected' && profile.auditRemark ? profile.auditRemark : entry.tip
        })
      })
      .catch(showError)
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  },

  openStaffEntry() {
    const profile = this.data.staffProfile
    if (!profile || profile.auditStatus === 'rejected') {
      wx.navigateTo({ url: '/pages/staff/certification/index' })
      return
    }
    if (profile.auditStatus === 'approved') {
      wx.redirectTo({ url: '/pages/staff/home/index' })
      return
    }
    wx.showToast({ title: '资料审核中', icon: 'none' })
  },

  openAdmin() {
    wx.redirectTo({ url: '/pages/admin/home/index' })
  },

  openAddresses() {
    wx.navigateTo({ url: '/pages/client/addresses/list/index' })
  },

  openFavorites() {
    wx.navigateTo({ url: '/pages/client/sitters/favorites/index?from=profile' })
  },

  editProfile() {
    wx.navigateTo({ url: '/pages/client/profile/edit/index?from=client' })
  },

  subscribe() {
    wx.showToast({ title: '敬请期待', icon: 'none' })
  }
})
