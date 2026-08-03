const { callFunction, showError } = require('../../../utils/cloud')
const { getCurrentUser, loginWithWechat, ensureLogin, setCachedUser, logoutCurrentUser } = require('../../../utils/cloud')

const staffEntryMap = {
  none: { title: '申请成为宠托师', tip: '提交资料后等待平台审核' },
  pending: { title: '宠托师审核中', tip: '资料已提交，请等待平台审核' },
  rejected: { title: '审核未通过，重新提交', tip: '修改资料后再次提交审核' },
  approved: { title: '进入宠托师工作台', tip: '查看附近订单并开始接单' }
}

Page({
  data: {
    isGuest: true,
    showSettings: false,
    loadingLogin: false,
    staffProfile: null,
    staffEntryTitle: staffEntryMap.none.title,
    staffEntryTip: staffEntryMap.none.tip,
    userName: '游客',
    userMeta: '登录后可管理宠物、订单、地址和收藏',
    avatarUrl: '',
    points: 0,
    memberLevelName: '',
    pointMultiplier: 1,
    retroCardCount: 0,
    levelDescription: '',
    rewardMailUnreadCount: 0,
    rewardMailUnclaimedCount: 0
  },

  onLoad(query) {
    this.setData({ showSettings: query.settings === '1' })
  },

  onShow() {
    wx.setNavigationBarTitle({ title: this.data.showSettings ? '设置' : '我的' })
    getCurrentUser({ silent: true })
      .then((user) => {
        if (!user) {
          this.applyGuest()
          return
        }
        this.applyUser(user)
        this.loadStaffProfile()
        this.loadPoints()
        this.loadRewardMailUnread()
      })
      .catch(() => this.applyGuest())
  },

  applyGuest() {
    setCachedUser(null)
    this.setData({
      isGuest: true,
      staffProfile: null,
      staffEntryTitle: staffEntryMap.none.title,
      staffEntryTip: staffEntryMap.none.tip,
      userName: '游客',
      userMeta: '登录后可管理宠物、订单、地址和收藏',
      avatarUrl: '',
      points: 0,
      memberLevelName: '',
      pointMultiplier: 1,
      retroCardCount: 0,
      levelDescription: '',
      rewardMailUnreadCount: 0,
      rewardMailUnclaimedCount: 0
    })
  },

  applyUser(user) {
    const rawPhone = String(user.phone || '')
    const phone = rawPhone ? `${rawPhone.slice(0, 3)}****${rawPhone.slice(-4)}` : ''
    this.setData({
      isGuest: false,
      userName: user.nickname || phone || '宠物主',
      userMeta: phone ? `已绑定手机 ${phone}` : '欢迎回来，今天也要安心宠护',
      avatarUrl: user.avatarUrl || ''
    })
  },

  login() {
    this.setData({ loadingLogin: true })
    loginWithWechat()
      .then((user) => {
        this.applyUser(user)
        this.loadStaffProfile()
        this.loadPoints()
        this.loadRewardMailUnread()
        wx.showToast({ title: '已登录' })
      })
      .catch(showError)
      .finally(() => this.setData({ loadingLogin: false }))
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

  loadPoints() {
    callFunction('memberLevel', 'myInfo')
      .then((info) => this.setData({
        points: info.points,
        memberLevelName: info.memberLevelName || '普通会员',
        pointMultiplier: Number(info.pointMultiplier || 1),
        retroCardCount: Number(info.retroCardCount || 0),
        levelDescription: info.currentLevel && info.currentLevel.description ? info.currentLevel.description : ''
      }))
      .catch(() => {})
  },

  loadRewardMailUnread() {
    callFunction('rewardMail', 'getUnreadCount')
      .then((res) => this.setData({
        rewardMailUnreadCount: Number(res.unreadCount || 0),
        rewardMailUnclaimedCount: Number(res.unclaimedCount || 0)
      }))
      .catch(() => {})
  },

  openCheckin() {
    ensureLogin({ content: '登录后可查看签到奖励和补签卡。' })
      .then(() => wx.navigateTo({ url: '/pages/client/checkin/index' }))
      .catch(() => {})
  },

  openRewardMails() {
    ensureLogin({ content: '登录后可领取会员奖励。' })
      .then(() => wx.navigateTo({ url: '/pages/client/reward-mails/index' }))
      .catch(() => {})
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  },

  goProtected(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    ensureLogin({ content: '登录后可查看订单。' })
      .then(() => wx.redirectTo({ url }))
      .catch(() => {})
  },

  openStaffEntry() {
    ensureLogin({ content: '登录后可申请或进入宠托师工作台。' })
      .then(() => {
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
      })
      .catch(() => {})
  },

  openAdmin() {
    ensureLogin({ content: '登录后可进入管理端。' })
      .then(() => wx.redirectTo({ url: '/pages/admin/home/index' }))
      .catch(() => {})
  },

  openAddresses() {
    ensureLogin({ content: '登录后可管理常用地址。' })
      .then(() => wx.navigateTo({ url: '/pages/client/addresses/list/index' }))
      .catch(() => {})
  },

  openFavorites() {
    ensureLogin({ content: '登录后可查看关注的宠托师。' })
      .then(() => wx.navigateTo({ url: '/pages/client/sitters/favorites/index?from=profile' }))
      .catch(() => {})
  },

  openCoupons() {
    ensureLogin({ content: '登录后可查看优惠券。' })
      .then(() => wx.navigateTo({ url: '/pages/client/coupons/list/index' }))
      .catch(() => {})
  },

  openPoints() {
    ensureLogin({ content: '登录后可查看积分。' })
      .then(() => wx.navigateTo({ url: '/pages/client/points/index' }))
      .catch(() => {})
  },

  editProfile() {
    ensureLogin({ content: '登录后可编辑个人资料。' })
      .then(() => wx.navigateTo({ url: '/pages/client/profile/edit/index?from=client' }))
      .catch(() => {})
  },

  openSettings() {
    wx.navigateTo({ url: '/pages/client/profile/index?settings=1' })
  },

  openAccountSafety() {
    ensureLogin({ content: '登录后可查看账号安全信息。' })
      .then(() => {
        wx.showModal({
          title: '账号安全',
          content: `${this.data.userName}\n${this.data.userMeta}\n\n当前版本使用微信 openid 作为登录凭证，不保存微信密码。`,
          showCancel: false
        })
      })
      .catch(() => {})
  },

  openAbout() {
    wx.showModal({ title: '关于我们', content: 'VIP 宠护提供上门喂养、遛狗、宠托师预约、订单跟踪与服务报告等宠物照护服务。', showCancel: false })
  },

  openInfoCollection() {
    wx.showModal({ title: '个人信息收集清单', content: '为提供服务，我们可能收集微信 openid、昵称头像、联系方式、宠物资料、服务地址、订单信息、服务打卡和评价内容。', showCancel: false })
  },

  openThirdPartySharing() {
    wx.showModal({ title: '第三方信息数据共享', content: '当前 MVP 版本不主动向第三方共享个人信息。后续如接入支付、地图、消息通知等能力，将在隐私政策中说明共享目的、范围和方式。', showCancel: false })
  },

  openPrivacySummary() {
    wx.showModal({ title: '隐私政策概要', content: '我们仅在完成预约、服务履约、安全验证和客服支持所需范围内处理信息。你可以在个人资料、地址、宠物档案等页面查看、修改或删除相关信息。', showCancel: false })
  },

  logout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后将以游客身份使用，需要登录的操作会再次提示微信登录。',
      confirmText: '退出',
      success: (res) => {
        if (!res.confirm) return
        logoutCurrentUser()
        this.applyGuest()
        wx.showToast({ title: '已退出登录' })
      }
    })
  },

  openAiAssistant() {
    wx.navigateTo({ url: '/pages/client/ai-assistant/index' })
  },

  subscribe() {
    wx.showToast({ title: '敬请期待', icon: 'none' })
  }
})
