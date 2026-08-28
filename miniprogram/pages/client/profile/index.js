const { callFunction, showError } = require('../../../utils/cloud')
const { getCurrentUser, loginWithWechat, ensureLogin, setCachedUser, logoutCurrentUser } = require('../../../utils/cloud')
const { themeOptions, applyTheme, saveTheme, getThemeState } = require('../../../utils/theme')
const { fontOptions, applyFont, saveFont, getFontState } = require('../../../utils/font')
const { loadMessageUnread } = require('../../../utils/client-nav')

const staffEntryMap = {
  none: { title: '申请成为宠护师', tip: '提交资料后等待平台审核' },
  pending: { title: '宠护师认证审核中', tip: '资料已提交，请等待平台审核' },
  rejected: { title: '审核未通过，重新提交', tip: '修改资料后再次提交审核' },
  approved: { title: '进入安心宠护端', tip: '查看任务并开始接单' }
}

Page({
  data: {
    isGuest: true,
    isAdmin: false,
    showSettings: false,
    themeOptions,
    themeKey: 'day',
    themeClass: 'theme-day',
    themeIndex: 0,
    themeName: '白天',
    savingTheme: false,
    fontOptions,
    fontKey: 'system',
    fontClass: 'font-system',
    fontIndex: 0,
    fontName: '默认清爽',
    fontPreviewText: '默认清爽',
    savingFont: false,
    loadingLogin: false,
    staffProfile: null,
    staffEntryReady: false,
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
    rewardMailUnclaimedCount: 0,
    messageUnreadCount: 0,
    messageHasUnread: false,
    hidePublicCheckinPhotos: false,
    savingPrivacy: false,
    showCustomerServiceModal: false,
    showFeedbackModal: false,
    showOfficialAccountModal: false,
    feedbackText: '',
    feedbackContact: '',
    submittingFeedback: false,
    csInfo: {
      phone: '',
      wechatId: '',
      workHours: '每天 9:00 - 21:00',
      officialAccountName: 'VIP宠护'
    }
  },

  onLoad(query = {}) {
    this.setData({ showSettings: query.settings === '1' })
  },

  onShow() {
    wx.setNavigationBarTitle({ title: this.data.showSettings ? '设置' : '我的' })
    this.setData({ staffEntryReady: false })
    this.applyCurrentTheme()
    this.applyCurrentFont()
    getCurrentUser({ silent: true })
      .then((user) => {
        if (!user) {
          this.applyGuest()
          return
        }
        this.syncUserTheme(user)
        this.syncUserFont(user)
        this.applyUser(user)
        this.loadStaffProfile()
        this.loadPoints()
        this.loadRewardMailUnread()
        loadMessageUnread(this)
      })
      .catch(() => this.applyGuest())
  },

  applyCurrentTheme(themeKey) {
    const theme = applyTheme(themeKey)
    this.setData(getThemeState(theme.value))
  },

  syncUserTheme(user) {
    const themeKey = user && (user.themeKey || (user.preferences && user.preferences.themeKey))
    if (themeKey) saveTheme(themeKey)
    this.applyCurrentTheme(themeKey)
  },

  applyCurrentFont(fontKey) {
    const font = applyFont(fontKey)
    this.setData(getFontState(font.value))
  },

  syncUserFont(user) {
    const fontKey = user && (user.fontKey || (user.preferences && user.preferences.fontKey))
    if (fontKey) saveFont(fontKey)
    this.applyCurrentFont(fontKey)
  },

  applyGuest() {
    setCachedUser(null)
    this.setData({
      isGuest: true,
      isAdmin: false,
      staffProfile: null,
      staffEntryReady: true,
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
      rewardMailUnclaimedCount: 0,
      messageUnreadCount: 0,
      messageHasUnread: false,
      hidePublicCheckinPhotos: false,
      savingPrivacy: false
    })
  },

  applyUser(user) {
    const rawPhone = String(user.phone || '')
    const phone = rawPhone ? `${rawPhone.slice(0, 3)}****${rawPhone.slice(-4)}` : ''
    const roles = Array.isArray(user.roles) ? user.roles : []
    this.setData({
      isGuest: false,
      isAdmin: roles.includes('admin'),
      userName: user.nickname || phone || '宠物主',
      userMeta: phone ? `已绑定手机 ${phone}` : '欢迎回来，今天也要安心宠护',
      avatarUrl: user.avatarUrl || '',
      hidePublicCheckinPhotos: user.hidePublicCheckinPhotos === true || (user.privacySettings && user.privacySettings.hidePublicCheckinPhotos === true)
    })
  },

  login() {
    this.setData({ loadingLogin: true })
    loginWithWechat()
      .then((user) => {
        this.syncUserTheme(user)
        this.syncUserFont(user)
        this.applyUser(user)
        this.loadStaffProfile()
        this.loadPoints()
        this.loadRewardMailUnread()
        loadMessageUnread(this)
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
          staffEntryReady: true,
          staffEntryTitle: entry.title,
          staffEntryTip: status === 'rejected' && profile.auditRemark ? profile.auditRemark : entry.tip
        })
      })
      .catch(showError)
  },

  loadPoints() {
    callFunction('memberLevel', 'myInfo')
      .then((info) => {
        const curLevel = info.currentLevel || {}
        this.setData({
          points: info.points,
          memberLevelName: info.memberLevelName || '普通会员',
          badgeTag: curLevel.badgeTag || info.badgeTag || 'V1',
          nameColor: curLevel.nameColor || info.nameColor || '',
          nameEffect: curLevel.nameEffect || info.nameEffect || '',
          badgeStyle: curLevel.badgeStyle || info.badgeStyle || 'gold',
          pointMultiplier: Number(info.pointMultiplier || 1),
          retroCardCount: Number(info.retroCardCount || 0),
          levelDescription: curLevel && curLevel.description ? curLevel.description : ''
        })
      })
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
    ensureLogin({ content: '登录后可查看订单和消息。' })
      .then(() => wx.redirectTo({ url }))
      .catch(() => {})
  },

  openStaffEntry() {
    ensureLogin({ content: '登录后可申请或进入安心宠护端。' })
      .then(() => callFunction('staff', 'getStaffProfile'))
      .then((profile) => {
        this.setData({ staffProfile: profile })
        if (!profile || profile.auditStatus === 'rejected') {
          wx.navigateTo({ url: '/pages/staff/certification/index' })
          return
        }
        if (profile.auditStatus === 'approved') {
          const app = getApp()
          if (app && app.globalData) app.globalData.activeRole = 'staff'
          wx.showToast({ title: '你已是安心宠护师', icon: 'none' })
          wx.reLaunch({ url: '/pages/staff/home/index' })
          return
        }
        wx.showToast({ title: '资料审核中', icon: 'none' })
      })
      .catch(() => {})
  },

  openAdmin() {
    ensureLogin({ content: '登录后可进入管理端。' })
      .then(() => callFunction('auth', 'me'))
      .then((user) => {
        const roles = Array.isArray(user.roles) ? user.roles : []
        if (!roles.includes('admin')) throw new Error('仅管理员可进入')
        setCachedUser(user)
        const app = getApp()
        if (app && app.globalData) app.globalData.activeRole = 'admin'
        wx.reLaunch({ url: '/pages/admin/home/index' })
      })
      .catch(showError)
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

  openIncidents() {
    ensureLogin({ content: '登录后可查看投诉和售后进度。' })
      .then(() => wx.navigateTo({ url: '/pages/client/incidents/list/index' }))
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

  changeTheme(e) {
    const option = themeOptions[Number(e.detail.value || 0)] || themeOptions[0]
    const theme = saveTheme(option.value)
    this.setData({ ...getThemeState(theme.value), savingTheme: true })
    if (this.data.isGuest) {
      this.setData({ savingTheme: false })
      return
    }
    callFunction('auth', 'updateTheme', { themeKey: theme.value })
      .then((user) => {
        setCachedUser(user)
        this.applyUser(user)
      })
      .catch(showError)
      .finally(() => this.setData({ savingTheme: false }))
  },

  changeFont(e) {
    const option = fontOptions[Number(e.detail.value || 0)] || fontOptions[0]
    const font = saveFont(option.value)
    this.setData({ ...getFontState(font.value), savingFont: true })
    if (this.data.isGuest) {
      this.setData({ savingFont: false })
      return
    }
    callFunction('auth', 'updateFont', { fontKey: font.value })
      .then((user) => {
        setCachedUser(user)
        this.applyUser(user)
      })
      .catch(showError)
      .finally(() => this.setData({ savingFont: false }))
  },

  togglePublicCheckinPhotos(e) {
    if (this.data.isGuest) return
    const hidePublicCheckinPhotos = e.detail.value === true
    this.setData({ savingPrivacy: true, hidePublicCheckinPhotos })
    callFunction('auth', 'updatePrivacySettings', { hidePublicCheckinPhotos })
      .then((user) => {
        setCachedUser(user)
        this.applyUser(user)
        wx.showToast({ title: '已保存', icon: 'none' })
      })
      .catch((err) => {
        this.setData({ hidePublicCheckinPhotos: !hidePublicCheckinPhotos })
        showError(err)
      })
      .finally(() => this.setData({ savingPrivacy: false }))
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

  loadCsInfo() {
    callFunction('system', 'getCustomerServiceInfo')
      .then((csInfo) => {
        if (csInfo) {
          this.setData({
            csInfo: {
              phone: csInfo.phone || '',
              wechatId: csInfo.wechatId || '',
              workHours: csInfo.workHours || '每天 9:00 - 21:00',
              officialAccountName: csInfo.officialAccountName || 'VIP宠护'
            }
          })
        }
      })
      .catch(() => {})
  },

  openCustomerService() {
    this.loadCsInfo()
    this.setData({ showCustomerServiceModal: true })
  },

  closeCustomerServiceModal() {
    this.setData({ showCustomerServiceModal: false })
  },

  callCsPhone() {
    if (!this.data.csInfo.phone) return
    wx.makePhoneCall({ phoneNumber: this.data.csInfo.phone }).catch(() => {})
  },

  copyCsWechat() {
    if (!this.data.csInfo.wechatId) return
    wx.setClipboardData({
      data: this.data.csInfo.wechatId,
      success: () => wx.showToast({ title: '已复制微信号' })
    })
  },

  openFeedbackModal() {
    this.setData({ showFeedbackModal: true, feedbackText: '', feedbackContact: '' })
  },

  closeFeedbackModal() {
    this.setData({ showFeedbackModal: false })
  },

  inputFeedbackText(e) {
    this.setData({ feedbackText: e.detail.value })
  },

  inputFeedbackContact(e) {
    this.setData({ feedbackContact: e.detail.value })
  },

  submitFeedback() {
    const content = String(this.data.feedbackText || '').trim()
    if (!content) {
      wx.showToast({ title: '请输入反馈内容', icon: 'none' })
      return
    }
    this.setData({ submittingFeedback: true })
    callFunction('system', 'submitFeedback', {
      content,
      contactInfo: this.data.feedbackContact
    })
      .then(() => {
        wx.showToast({ title: '感谢你的反馈！' })
        this.setData({ showFeedbackModal: false, feedbackText: '', feedbackContact: '' })
      })
      .catch(showError)
      .finally(() => this.setData({ submittingFeedback: false }))
  },

  openOfficialAccountModal() {
    this.loadCsInfo()
    this.setData({ showOfficialAccountModal: true })
  },

  closeOfficialAccountModal() {
    this.setData({ showOfficialAccountModal: false })
  },

  copyOfficialAccountName() {
    const name = this.data.csInfo.officialAccountName || 'VIP宠护'
    wx.setClipboardData({
      data: name,
      success: () => wx.showToast({ title: '已复制公众号名称' })
    })
  },

  subscribe() {
    this.openOfficialAccountModal()
  }
})
