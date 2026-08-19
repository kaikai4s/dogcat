const { getCurrentUser, logoutCurrentUser, ensureLogin, showError, callFunction, setCachedUser } = require('../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../utils/nav')
const { themeOptions, applyTheme, saveTheme, getThemeState } = require('../../../utils/theme')
const { fontOptions, applyFont, saveFont, getFontState } = require('../../../utils/font')

Page({
  data: {
    canGoBack: false,
    isGuest: true,
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
    fontName: '系统默认',
    savingFont: false,
    userName: '游客',
    userMeta: '登录后可使用完整账号功能'
  },

  onLoad(query) {
    this.setData(createPageNav(query))
  },

  onShow() {
    this.applyCurrentTheme()
    this.applyCurrentFont()
    getCurrentUser({ silent: true })
      .then((user) => {
        if (!user) {
          this.setData({
            isGuest: true,
            userName: '游客',
            userMeta: '当前以游客身份浏览'
          })
          return
        }
        this.syncUserTheme(user)
        this.syncUserFont(user)
        const rawPhone = String(user.phone || '')
        const phone = rawPhone ? `${rawPhone.slice(0, 3)}****${rawPhone.slice(-4)}` : ''
        this.setData({
          isGuest: false,
          userName: user.nickname || phone || '微信用户',
          userMeta: phone ? `已绑定手机 ${phone}` : '已通过微信 openid 登录'
        })
      })
      .catch(showError)
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

  changeTheme(e) {
    const option = themeOptions[Number(e.detail.value || 0)] || themeOptions[0]
    const theme = saveTheme(option.value)
    this.setData({ ...getThemeState(theme.value), savingTheme: true })
    if (this.data.isGuest) {
      this.setData({ savingTheme: false })
      return
    }
    callFunction('auth', 'updateTheme', { themeKey: theme.value })
      .then(setCachedUser)
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
      .then(setCachedUser)
      .catch(showError)
      .finally(() => this.setData({ savingFont: false }))
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
    wx.showModal({
      title: '关于我们',
      content: 'VIP 宠护提供上门喂养、遛狗、宠托师预约、订单跟踪与服务报告等宠物照护服务。',
      showCancel: false
    })
  },

  openInfoCollection() {
    wx.showModal({
      title: '个人信息收集清单',
      content: '为提供服务，我们可能收集微信 openid、昵称头像、联系方式、宠物资料、服务地址、订单信息、服务打卡和评价内容。',
      showCancel: false
    })
  },

  openThirdPartySharing() {
    wx.showModal({
      title: '第三方信息数据共享',
      content: '当前 MVP 版本不主动向第三方共享个人信息。后续如接入支付、地图、消息通知等能力，将在隐私政策中说明共享目的、范围和方式。',
      showCancel: false
    })
  },

  openPrivacySummary() {
    wx.showModal({
      title: '隐私政策概要',
      content: '我们仅在完成预约、服务履约、安全验证和客服支持所需范围内处理信息。你可以在个人资料、地址、宠物档案等页面查看、修改或删除相关信息。',
      showCancel: false
    })
  },

  logout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后将以游客身份使用，需要登录的操作会再次提示微信登录。',
      confirmText: '退出',
      success: (res) => {
        if (!res.confirm) return
        logoutCurrentUser()
        wx.showToast({ title: '已退出登录' })
        wx.redirectTo({ url: '/pages/client/profile/index' })
      }
    })
  },

  ...navMethods()
})
