const { callFunction, showError } = require('../../../utils/cloud')
const { getCurrentUser, getCachedUser, getCloudEnv, subscribeIdentityChange, loginWithWechat, ensureLogin, setCachedUser, logoutCurrentUser } = require('../../../utils/cloud')
const displayCache = require('./display-cache')
const { themeOptions, applyTheme, saveTheme, getThemeState } = require('../../../utils/theme')
const { fontOptions, applyFont, saveFont, getFontState } = require('../../../utils/font')
// Unread data here is fetched under this page's identity/request guards, not the shared role-only cache.
const { copyText } = require('../../../utils/clipboard')

const staffEntryMap = {
  none: { title: '申请成为宠护师', tip: '提交资料后等待平台审核' },
  pending: { title: '宠护师认证审核中', tip: '资料已提交，请等待平台审核' },
  rejected: { title: '审核未通过，重新提交', tip: '修改资料后再次提交审核' },
  approved: { title: '进入多芙琳宠护端', tip: '查看任务并开始接单' }
}

function getCachedStaffState() {
  return {
    staffProfile: null,
    staffEntryReady: true,
    staffEntryTitle: staffEntryMap.none.title,
    staffEntryTip: staffEntryMap.none.tip
  }
}
const emptySummary = {
  points: null, memberLevelName: '', pointMultiplier: null, retroCardCount: null,
  levelDescription: '', badgeTag: '', badgeStyle: '', nameColor: '', nameEffect: ''
}

function getInitialProfileData() {
  let user = null
  try {
    user = getCachedUser()
  } catch (_) {}

  const isGuest = !user
  const roles = Array.isArray(user?.roles) ? user.roles : []
  const rawPhone = String(user?.phone || '')
  const phone = rawPhone ? `${rawPhone.slice(0, 3)}****${rawPhone.slice(-4)}` : ''

  const base = {
    loginAgreed: false,
    isGuest,
    isAdmin: roles.includes('admin'),
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
    ...getCachedStaffState(),
    identityReady: !isGuest,
    userName: isGuest ? '个人中心' : (user.nickname || phone || '宠物主'),
    userMeta: isGuest ? '正在确认登录状态' : (phone ? `已绑定手机 ${phone}` : '欢迎回来，Dovelin 多芙琳陪你安心照护'),
    avatarUrl: isGuest ? '' : (user.avatarUrl || ''),
    avatarImages: [],
    ...emptySummary,
    rewardMailUnreadCount: 0,
    rewardMailUnclaimedCount: 0,
    staffUnreadCount: 0,
    staffUnreadCountText: '0',
    messageUnreadCount: 0,
    messageHasUnread: false,
    hidePublicCheckinPhotos: isGuest ? false : (user.hidePublicCheckinPhotos === true || (user.privacySettings && user.privacySettings.hidePublicCheckinPhotos === true)),
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
      officialAccountName: 'Dovelin 多芙琳宠物上门服务'
    },
    officialAccount: {
      enabled: true,
      name: 'Dovelin 多芙琳宠物上门服务',
      appId: '',
      originalId: '',
      qrCodeUrl: '',
      qrCodeTempUrl: '',
      followGuideText: '关注官方微信服务号，第一时间接收订单进展、履约打卡提醒与专属福利推送。',
      enableFollowBar: false
    },
    officialAccountFollowBarLoaded: false
  }

  if (user) {
    try {
      const env = typeof getCloudEnv === 'function' ? getCloudEnv() : ''
      const scope = typeof displayCache?.scopeKey === 'function'
        ? displayCache.scopeKey(env, user)
        : (user._id || user.openid ? JSON.stringify([String(env), String(user._id || user.openid)]) : '')
      if (scope && typeof displayCache?.readDisplay === 'function') {
        const cached = displayCache.readDisplay(scope)
        if (cached && cached.summary) {
          Object.assign(base, cached.summary)
        }
        if (cached && cached.staff) {
          const status = cached.staff.auditStatus || 'none'
          const entry = staffEntryMap[status] || staffEntryMap.none
          base.staffProfile = cached.staff
          base.staffEntryTitle = entry.title
          base.staffEntryTip = status === 'rejected' && cached.staff.auditRemark ? cached.staff.auditRemark : entry.tip
        }
      }
    } catch (_) {}
  }

  return base
}

Page({
  data: getInitialProfileData(),

  onLoad(query = {}) {
    this._visible = true
    this._unloaded = false
    this._life = 0
    this._identity = 0
    this._requests = {}
    const cachedUser = getCachedUser()
    if (cachedUser) {
      this._scope = this.currentScope(cachedUser)
    }
    this.setData({ showSettings: query.settings === '1' })
    this.restoreIdentity()
    this._unsubscribeIdentity = subscribeIdentityChange(user => {
      if (this._unloaded) return
      if (!user) this.applyGuest()
      else this.applyUser(user)
      if (this._visible && user) this.refreshDetails()
    })
  },

  currentScope(user = getCachedUser()) {
    if (typeof displayCache?.scopeKey === 'function') {
      return displayCache.scopeKey(getCloudEnv(), user)
    }
    const env = typeof getCloudEnv === 'function' ? getCloudEnv() : 'default'
    const id = user && (user._id || user.openid || user._openid)
    return id ? JSON.stringify([String(env), String(id)]) : ''
  },

  restoreIdentity() {
    const user = getCachedUser()
    if (user) this.applyUser(user)
    else if (this._scope || !this.data.isGuest) this.applyGuest()
  },

  ticket(kind) {
    this._requests = this._requests || {}
    const seq = (this._requests[kind] || 0) + 1
    this._requests[kind] = seq
    return { kind, seq, life: this._life || 0, identity: this._identity || 0, scope: this._scope || '', env: getCloudEnv() }
  },

  active(ticket, allowLogin = false, user) {
    if (this._unloaded || this._visible === false || ticket.life !== (this._life || 0) || ticket.env !== getCloudEnv() || this._requests[ticket.kind] !== ticket.seq) return false
    const scope = this.currentScope()
    if (allowLogin && !ticket.scope && user && scope === this.currentScope(user)) {
      return (this._identity || 0) <= ticket.identity + 1
    }
    return ticket.identity === (this._identity || 0) && ticket.scope === (this._scope || '') && ticket.scope === scope
  },

  ensurePageLogin(options) {
    const ticket = this.ticket('entry')
    this._entryTicket = ticket
    return ensureLogin({ ...options, isActive: () => this.active(ticket) }).then(user => {
      if (!user || !this.active(ticket, true, user)) throw { code: 'LOGIN_CANCELLED' }
      if (!this._scope) this.applyUser(user)
      return user
    })
  },

  refreshDetails() {
    return Promise.all([this.loadStaffProfile(), this.loadPoints(), this.loadRewardMailUnread(), this.loadUnread()])
  },

  refreshProfile(force = false) {
    this.restoreIdentity()
    const ticket = this.ticket('auth')
    return getCurrentUser(force ? { force: true } : { silent: true }).then(user => {
      if (!this.active(ticket, true, user)) return
      if (!user) { this.applyGuest(); return }
      this.syncUserTheme(user)
      this.syncUserFont(user)
      this.applyUser(user)
      return this.refreshDetails()
    }).catch(() => {}) // A transport failure is not a logout.
  },

  onCustomRefresh() {
    return Promise.resolve(this.onPullDownRefresh()).finally(() => {
      const refreshComp = this.selectComponent('#dovlinRefresh')
      if (refreshComp) {
        refreshComp.finishRefresh('更新完毕 ✨')
      }
    })
  },

  onPullDownRefresh() {
    return this.refreshProfile(true).finally(() => wx.stopPullDownRefresh())
  },

  onShow() {
    this._visible = true
    this.restoreIdentity()
    wx.setNavigationBarTitle({ title: this.data.showSettings ? '设置' : '我的' })
    this.applyCurrentTheme()
    this.applyCurrentFont()
    return this.refreshProfile()
  },

  onHide() {
    this._visible = false
    this._life = (this._life || 0) + 1
    clearTimeout(this._staffUnreadTimer)
    // Restart an unresolved candidate when shown again; retain a loaded same-account image.
    this._avatarSource = undefined
    this.setData({ avatarImages: this.data.avatarImages.filter(item => item.loaded), loadingLogin: false, savingTheme: false, savingFont: false, savingPrivacy: false })
  },

  onUnload() {
    this.onHide()
    this._unloaded = true
    if (this._unsubscribeIdentity) this._unsubscribeIdentity()
  },

  applyCurrentTheme(themeKey) {
    const theme = applyTheme(themeKey)
    this.setData({ themeOptions, ...getThemeState(theme.value) })
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
    this._identity = (this._identity || 0) + 1
    this._scope = ''
    this._hasSummary = false
    this._avatarSource = undefined
    clearTimeout(this._staffUnreadTimer)
    this.setData({
      isGuest: true,
      loginAgreed: false,
      isAdmin: false,
      staffProfile: null,
      staffEntryReady: true,
      staffEntryTitle: staffEntryMap.none.title,
      staffEntryTip: staffEntryMap.none.tip,
      userName: '游客',
      userMeta: '登录后可管理宠物、订单、地址和收藏',
      identityReady: true,
      avatarUrl: '',
      avatarImages: [],
      ...emptySummary,
      rewardMailUnreadCount: 0,
      rewardMailUnclaimedCount: 0,
      staffUnreadCount: 0,
      staffUnreadCountText: '0',
      messageUnreadCount: 0,
      messageUnreadCountText: '0',
      messageHasUnread: false,
      messageShowUnreadDot: false,
      hidePublicCheckinPhotos: false,
      savingPrivacy: false
    })
  },

  applyUser(user) {
    const scope = this.currentScope(user)
    if (!scope) return
    const isNewScope = !this._scope || this._scope !== scope
    this._scope = scope
    if (isNewScope) {
      const cached = typeof displayCache?.readDisplay === 'function' ? displayCache.readDisplay(scope) : {}
      this._hasSummary = !!cached.summary
      if (cached.summary) this.setData(cached.summary)
      if (cached.staff) this.applyStaffProfile(cached.staff)
    }
    const rawPhone = String(user.phone || '')
    const phone = rawPhone ? `${rawPhone.slice(0, 3)}****${rawPhone.slice(-4)}` : ''
    const roles = Array.isArray(user.roles) ? user.roles : []
    const patch = {
      isGuest: false,
      identityReady: true,
      isAdmin: roles.includes('admin'),
      userName: user.nickname || phone || '宠物主',
      userMeta: phone ? `已绑定手机 ${phone}` : '欢迎回来，Dovelin 多芙琳陪你安心照护',
      hidePublicCheckinPhotos: user.hidePublicCheckinPhotos === true || (user.privacySettings && user.privacySettings.hidePublicCheckinPhotos === true)
    }
    if (user.avatarUrl && this.data.avatarUrl !== user.avatarUrl) {
      patch.avatarUrl = user.avatarUrl
    }
    if (!this._hasSummary) {
      const partial = typeof displayCache?.pickSummary === 'function' ? displayCache.pickSummary(user) : {}
      Object.keys(partial).forEach(key => {
        if (Object.prototype.hasOwnProperty.call(user, key)) patch[key] = partial[key]
      })
    }
    this.setData(patch)
    if (this._visible !== false && user.avatarUrl) this.prepareAvatar(user.avatarUrl)
  },

  prepareAvatar(source, retry = false) {
    if (!retry && this._avatarSource === source) return
    if (!retry) this._avatarRetries = 0
    this._avatarSource = source
    const ticket = this.ticket('avatar')
    this._avatarTicket = ticket
    const images = this.data.avatarImages.filter(item => item.loaded)
    this.setData({ avatarImages: source ? images : [], ...(source ? {} : { avatarUrl: '' }) })
    if (!source) return
    const apply = path => {
      if (!this.active(ticket) || this._avatarSource !== source) return
      const token = `${ticket.life}-${ticket.identity}-${ticket.seq}`
      const nextImages = [...this.data.avatarImages.filter(item => item.loaded), { token, path, source, loaded: true }]
      const updateData = { avatarImages: nextImages }
      if (path && path !== this.data.avatarUrl) {
        updateData.avatarUrl = path
      }
      this.setData(updateData)
    }
    const cached = typeof displayCache?.getAvatar === 'function' ? displayCache.getAvatar(this._scope, source) : ''
    if (cached) { apply(cached); return }
    if (typeof displayCache?.resolveAvatar === 'function') {
      return displayCache.resolveAvatar(this._scope, source, () => this.active(ticket) && this._avatarSource === source)
        .then(apply).catch(() => {
          if (this.active(ticket) && this._avatarRetries < 1) {
            this._avatarRetries += 1
            return this.prepareAvatar(source, true)
          }
        })
    } else {
      apply(source)
    }
  },

  onMainAvatarError() {
    if (this._avatarSource && this._avatarSource.startsWith('cloud://')) {
      if (typeof displayCache?.invalidateAvatar === 'function') {
        displayCache.invalidateAvatar(this._scope, this._avatarSource)
      }
      this.prepareAvatar(this._avatarSource, true)
    } else {
      this.setData({ avatarUrl: '' })
    }
  },

  onAvatarLoad(e) {
    const token = e.currentTarget.dataset.token
    const item = this.data.avatarImages.find(image => image.token === token)
    if (!item || item.loaded || !this._avatarTicket || !this.active(this._avatarTicket) || item.source !== this._avatarSource) return
    this.setData({ avatarUrl: item.path, avatarImages: [{ ...item, loaded: true }] })
  },

  onAvatarError(e) {
    const token = e.currentTarget.dataset.token
    const item = this.data.avatarImages.find(image => image.token === token)
    if (!item || !this._avatarTicket || !this.active(this._avatarTicket)) return
    displayCache.invalidateAvatar(this._scope, item.source, item.path)
    this.setData({ avatarImages: this.data.avatarImages.filter(image => image.token !== token), ...(item.loaded ? { avatarUrl: '' } : {}) })
    if (item.source !== this._avatarSource || this._avatarRetries >= 1) return
    this._avatarRetries += 1
    this.prepareAvatar(item.source, true)
  },

  onLoginConsentChange(e) {
    this.setData({ loginAgreed: e.detail.agreed === true })
  },

  login() {
    if (!this.data.loginAgreed) {
      wx.showToast({ title: '请先阅读并同意用户协议和隐私政策', icon: 'none' })
      return
    }
    if (this.data.loading || this.data.loadingLogin) return
    this.setData({ loadingLogin: true })
    const ticket = this.ticket('login')
    return loginWithWechat({ agreementVersion: '2026-10-23' })
      .then((user) => {
        if (!user || !this.active(ticket, true, user)) return
        this.syncUserTheme(user)
        this.syncUserFont(user)
        this.applyUser(user)
        this.refreshDetails()
        const loggedIn = this.ticket('welcome')
        wx.showToast({ title: '已登录' })
        const isNewUser = !user || user.nickname === '微信用户' || !user.avatarUrl
        if (isNewUser) {
          setTimeout(() => {
            if (!this.active(loggedIn)) return
            wx.showModal({
              title: '欢迎加入多芙琳',
              content: '检测到您尚未完善资料，是否立即一键同步微信头像、昵称与手机号？',
              confirmText: '立即完善',
              cancelText: '暂不完善',
              success: (res) => {
                if (res.confirm && this.active(loggedIn)) {
                  wx.navigateTo({ url: '/pages/client/profile/edit/index' })
                }
              }
            })
          }, 400)
        }
      })
      .catch(err => { if (this.active(ticket)) showError(err) })
      .finally(() => { if (this.active(ticket, true, getCachedUser())) this.setData({ loadingLogin: false }) })
  },

  applyStaffProfile(profile) {
    const status = profile ? profile.auditStatus : 'none'
    const entry = staffEntryMap[status] || staffEntryMap.none
    this.setData({
      staffProfile: profile,
      staffEntryReady: true,
      staffEntryTitle: entry.title,
      staffEntryTip: status === 'rejected' && profile.auditRemark ? profile.auditRemark : entry.tip
    })
  },

  loadStaffProfile() {
    if (!this._scope) return Promise.resolve()
    const ticket = this.ticket('staff')
    return callFunction('staff', 'getStaffProfile')
      .then((profile) => {
        if (!this.active(ticket)) return
        const minimal = { auditStatus: profile && profile.auditStatus || 'none', auditRemark: profile && profile.auditRemark || '' }
        this.applyStaffProfile(minimal)
        displayCache.writeDisplay(ticket.scope, 'staff', minimal)
      }).catch(() => {})
  },

  loadPoints() {
    if (!this._scope) return Promise.resolve()
    const ticket = this.ticket('points')
    return callFunction('memberLevel', 'myInfo')
      .then((info) => {
        if (!info || !this.active(ticket)) return
        const curLevel = info.currentLevel || {}
        const summary = typeof displayCache?.pickSummary === 'function' ? displayCache.pickSummary({
          points: info.points,
          memberLevelName: info.memberLevelName || '',
          badgeTag: curLevel.badgeTag ?? info.badgeTag ?? '',
          nameColor: curLevel.nameColor ?? info.nameColor ?? '',
          nameEffect: curLevel.nameEffect ?? info.nameEffect ?? '',
          badgeStyle: curLevel.badgeStyle ?? info.badgeStyle ?? '',
          pointMultiplier: info.pointMultiplier,
          retroCardCount: info.retroCardCount,
          levelDescription: curLevel.description || ''
        }) : {
          points: info.points,
          memberLevelName: info.memberLevelName || '',
          badgeTag: curLevel.badgeTag ?? info.badgeTag ?? '',
          pointMultiplier: info.pointMultiplier,
          retroCardCount: info.retroCardCount,
          levelDescription: curLevel.description || ''
        }
        this._hasSummary = true
        const diff = {}
        for (const k of Object.keys(summary)) {
          if (this.data[k] !== summary[k]) {
            diff[k] = summary[k]
          }
        }
        if (Object.keys(diff).length > 0) {
          this.setData(diff)
        }
        if (typeof displayCache?.writeDisplay === 'function') {
          displayCache.writeDisplay(ticket.scope, 'summary', summary)
        }
      }).catch(() => {})
  },

  loadRewardMailUnread() {
    if (!this._scope) return Promise.resolve()
    const ticket = this.ticket('reward')
    return callFunction('rewardMail', 'getUnreadCount').then(res => {
      if (this.active(ticket)) this.setData({
        rewardMailUnreadCount: Number(res.unreadCount || 0),
        rewardMailUnclaimedCount: Number(res.unclaimedCount || 0)
      })
    }).catch(() => {})
  },

  loadUnread() {
    if (!this._scope) return Promise.resolve()
    clearTimeout(this._staffUnreadTimer)
    const ticket = this.ticket('unread')
    const client = callFunction('message', 'getUnreadSummary').then(res => {
      if (!this.active(ticket)) return
      const count = Math.max(0, Number(res.totalUnread) || 0)
      this.setData({ messageUnreadCount: count, messageUnreadCountText: count > 99 ? '99+' : String(count), messageHasUnread: count > 0 })
    }).catch(() => {})
    const user = getCachedUser()
    const staff = user && (user.roles || []).includes('staff') ? callFunction('staffMessage', 'getUnreadSummary').then(res => {
      if (!this.active(ticket)) return
      const count = Math.max(0, Number(res.totalUnread) || 0)
      this.setData({ staffUnreadCount: count, staffUnreadCountText: count > 99 ? '99+' : String(count) })
    }).catch(() => {}) : Promise.resolve(this.setData({ staffUnreadCount: 0, staffUnreadCountText: '0' }))
    return Promise.all([client, staff]).finally(() => {
      if (this.active(ticket)) this._staffUnreadTimer = setTimeout(() => this.loadUnread(), 30000)
    })
  },

  openCheckin() {
    return this.ensurePageLogin({ content: '登录后可查看签到奖励和补签卡。' })
      .then(() => this.active(this._entryTicket) && wx.navigateTo({ url: '/pages/client/checkin/index' }))
      .catch(() => {})
  },

  openRewardMails() {
    return this.ensurePageLogin({ content: '登录后可领取会员奖励。' })
      .then(() => this.active(this._entryTicket) && wx.navigateTo({ url: '/pages/client/reward-mails/index' }))
      .catch(() => {})
  },

  openQuestionnaires() {
    return this.ensurePageLogin({ content: '登录后可参与问卷调研。' })
      .then(() => this.active(this._entryTicket) && wx.navigateTo({ url: '/pages/client/questionnaires/list/index' }))
      .catch(() => {})
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    const pages = getCurrentPages()
    const current = pages[pages.length - 1]
    const currentRoute = current && current.route ? '/' + current.route : ''
    if (currentRoute === url) return
    const mainNavUrls = ['/pages/client/home/index', '/pages/client/sitters/list/index', '/pages/client/orders/list/index', '/pages/client/messages/index', '/pages/client/profile/index']
    const method = mainNavUrls.includes(url) ? 'redirectTo' : 'navigateTo'
    wx[method]({ url })
  },

  goProtected(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    return this.ensurePageLogin({ content: '登录后可查看订单和消息。' })
      .then(() => {
        if (!this.active(this._entryTicket)) return
        const pages = getCurrentPages()
        const current = pages[pages.length - 1]
        const currentRoute = current && current.route ? '/' + current.route : ''
        if (currentRoute === url) return
        const mainNavUrls = ['/pages/client/home/index', '/pages/client/sitters/list/index', '/pages/client/orders/list/index', '/pages/client/messages/index', '/pages/client/profile/index']
        const method = mainNavUrls.includes(url) ? 'redirectTo' : 'navigateTo'
        wx[method]({ url })
      })
      .catch(() => {})
  },

  openStaffEntry() {
    let ticket
    return this.ensurePageLogin({ content: '登录后可申请或进入多芙琳宠护端。' })
      .then(() => {
        if (!this.active(this._entryTicket)) return
        ticket = this.ticket('staff')
        return callFunction('staff', 'getStaffProfile')
      })
      .then((profile) => {
        if (!ticket || !this.active(ticket)) return
        const minimal = { auditStatus: profile && profile.auditStatus || 'none', auditRemark: profile && profile.auditRemark || '' }
        this.applyStaffProfile(minimal)
        displayCache.writeDisplay(ticket.scope, 'staff', minimal)
        const status = profile && profile.auditStatus
        if (status === 'approved') {
          const app = getApp()
          if (app && app.globalData) app.globalData.activeRole = 'staff'
          wx.showToast({ title: '你已是多芙琳宠护师', icon: 'none' })
          wx.reLaunch({ url: '/pages/staff/home/index' })
          return
        }
        if (!profile || status === 'rejected' || status === 'revoked' || status === 'none') {
          if (status === 'revoked' || status === 'rejected') {
            try { wx.removeStorageSync('agreed_agreement_staff_application') } catch (e) {}
          }
          const agreed = wx.getStorageSync('agreed_agreement_staff_application')
          if (!agreed) {
            const targetUrl = encodeURIComponent('/pages/staff/certification/index')
            wx.navigateTo({ url: `/pages/common/agreement/index?type=staff_application&targetUrl=${targetUrl}&countdown=30` })
            return
          }
          wx.navigateTo({ url: '/pages/staff/certification/index' })
          return
        }
        if (status === 'pending') {
          wx.showToast({ title: '资料审核中，请等待平台审核', icon: 'none' })
          wx.navigateTo({ url: '/pages/staff/certification/index' })
          return
        }
        wx.navigateTo({ url: '/pages/staff/certification/index' })
      })
      .catch(() => {})
  },

  openAdmin() {
    let ticket
    return this.ensurePageLogin({ content: '登录后可进入管理端。' })
      .then(() => {
        if (!this.active(this._entryTicket)) return
        ticket = this.ticket('admin')
        return callFunction('auth', 'me')
      })
      .then((user) => {
        if (!ticket || !this.active(ticket) || this.currentScope(user) !== ticket.scope) return
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
    return this.ensurePageLogin({ content: '登录后可管理常用地址。' })
      .then(() => this.active(this._entryTicket) && wx.navigateTo({ url: '/pages/client/addresses/list/index' }))
      .catch(() => {})
  },

  openFavorites() {
    return this.ensurePageLogin({ content: '登录后可查看关注的宠托师。' })
      .then(() => this.active(this._entryTicket) && wx.navigateTo({ url: '/pages/client/sitters/favorites/index?from=profile' }))
      .catch(() => {})
  },

  openCoupons() {
    return this.ensurePageLogin({ content: '登录后可查看优惠券。' })
      .then(() => this.active(this._entryTicket) && wx.navigateTo({ url: '/pages/client/coupons/list/index' }))
      .catch(() => {})
  },

  openIncidents() {
    return this.ensurePageLogin({ content: '登录后可查看投诉和售后进度。' })
      .then(() => this.active(this._entryTicket) && wx.navigateTo({ url: '/pages/client/incidents/list/index' }))
      .catch(() => {})
  },

  openPoints() {
    return this.ensurePageLogin({ content: '登录后可查看积分。' })
      .then(() => this.active(this._entryTicket) && wx.navigateTo({ url: '/pages/client/points/index' }))
      .catch(() => {})
  },

  openAssets() {
    return this.ensurePageLogin({ content: '登录后可查看资产和邀请收益。' })
      .then(() => this.active(this._entryTicket) && wx.navigateTo({ url: '/pages/client/profile/assets/index' }))
      .catch(() => {})
  },

  editProfile() {
    return this.ensurePageLogin({ content: '登录后可编辑个人资料。' })
      .then(() => this.active(this._entryTicket) && wx.navigateTo({ url: '/pages/client/profile/edit/index?from=client' }))
      .catch(() => {})
  },

  openSubscriptions() {
    return this.ensurePageLogin({ content: '登录后可管理通知订阅。' })
      .then(() => this.active(this._entryTicket) && wx.navigateTo({ url: '/pages/common/subscriptions/index?role=client' }))
      .catch(() => {})
  },

  openSettings() {
    wx.navigateTo({ url: '/pages/client/profile/index?settings=1' })
  },

  openAccountSafety() {
    return this.ensurePageLogin({ content: '登录后可查看账号安全信息。' })
      .then(() => {
        if (!this.active(this._entryTicket)) return
        wx.showModal({
          title: '账号安全',
          content: `${this.data.userName}\n${this.data.userMeta}\n\n当前版本使用微信 openid 作为登录凭证，不保存微信密码。`,
          showCancel: false
        })
      })
      .catch(() => {})
  },

  openAbout() {
    wx.showModal({ title: '关于我们', content: 'Dovelin 多芙琳宠物上门服务提供上门喂养、遛狗、宠托师预约、订单跟踪与服务报告等宠物照护服务。', showCancel: false })
  },

  openInfoCollection() {
    wx.showModal({ title: '个人信息收集清单', content: '为提供服务，我们可能收集微信 openid、昵称头像、联系方式、宠物资料、服务地址、订单信息、服务打卡和评价内容。', showCancel: false })
  },

  openThirdPartySharing() {
    wx.showModal({ title: '第三方信息数据共享', content: '本小程序已接入微信登录、手机号授权、微信支付、地图定位、订阅消息、腾讯云开发与云存储及内容安全检测。AI问答将提问发送至腾讯云开发AI服务。具体用途和范围请查看完整隐私政策。', showCancel: false })
  },

  openPrivacySummary() {
    wx.navigateTo({ url: '/pages/common/agreement/index?type=privacy&mode=view' })
  },

  changeTheme(e) {
    const option = themeOptions[Number(e.detail.value || 0)] || themeOptions[0]
    const theme = saveTheme(option.value)
    this.setData({ ...getThemeState(theme.value), savingTheme: true })
    if (this.data.isGuest) {
      this.setData({ savingTheme: false })
      return
    }
    const ticket = this.ticket('theme')
    return callFunction('auth', 'updateTheme', { themeKey: theme.value })
      .then((user) => {
        if (!this.active(ticket) || this.currentScope(user) !== ticket.scope) return
        setCachedUser(user)
        this.applyUser(user)
      })
      .catch(err => { if (this.active(ticket)) showError(err) })
      .finally(() => { if (this.active(ticket)) this.setData({ savingTheme: false }) })
  },

  changeFont(e) {
    const option = fontOptions[Number(e.detail.value || 0)] || fontOptions[0]
    const font = saveFont(option.value)
    this.setData({ ...getFontState(font.value), savingFont: true })
    if (this.data.isGuest) {
      this.setData({ savingFont: false })
      return
    }
    const ticket = this.ticket('font')
    return callFunction('auth', 'updateFont', { fontKey: font.value })
      .then((user) => {
        if (!this.active(ticket) || this.currentScope(user) !== ticket.scope) return
        setCachedUser(user)
        this.applyUser(user)
      })
      .catch(err => { if (this.active(ticket)) showError(err) })
      .finally(() => { if (this.active(ticket)) this.setData({ savingFont: false }) })
  },

  togglePublicCheckinPhotos(e) {
    if (this.data.isGuest) return
    const hidePublicCheckinPhotos = e.detail.value === true
    this.setData({ savingPrivacy: true, hidePublicCheckinPhotos })
    const ticket = this.ticket('privacy')
    return callFunction('auth', 'updatePrivacySettings', { hidePublicCheckinPhotos })
      .then((user) => {
        if (!this.active(ticket) || this.currentScope(user) !== ticket.scope) return
        setCachedUser(user)
        this.applyUser(user)
        wx.showToast({ title: '已保存', icon: 'none' })
      })
      .catch((err) => {
        if (!this.active(ticket)) return
        this.setData({ hidePublicCheckinPhotos: !hidePublicCheckinPhotos })
        showError(err)
      })
      .finally(() => { if (this.active(ticket)) this.setData({ savingPrivacy: false }) })
  },

  logout() {
    const ticket = this.ticket('logout')
    wx.showModal({
      title: '退出登录',
      content: '退出后将以游客身份使用，需要登录的操作会再次提示微信登录。',
      confirmText: '退出',
      success: (res) => {
        if (!res.confirm || !this.active(ticket)) return
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
      .then((res) => {
        if (res) {
          const oa = res.officialAccount || {}
          const officialAccount = {
            enabled: oa.enabled !== false,
            name: oa.name || res.officialAccountName || 'Dovelin 多芙琳宠物上门服务',
            appId: oa.appId || '',
            originalId: oa.originalId || '',
            qrCodeUrl: oa.qrCodeUrl || '',
            qrCodeTempUrl: oa.qrCodeUrl && /^https?:\/\//.test(oa.qrCodeUrl) ? oa.qrCodeUrl : '',
            followGuideText: oa.followGuideText || '关注官方微信服务号，第一时间接收订单进展、履约打卡提醒与专属福利推送。',
            enableFollowBar: oa.enableFollowBar === true
          }
          this.setData({
            csInfo: {
              phone: res.phone || '',
              wechatId: res.wechatId || '',
              workHours: res.workHours || '每天 9:00 - 21:00',
              officialAccountName: officialAccount.name
            },
            officialAccount
          })
          if (oa.qrCodeUrl && oa.qrCodeUrl.startsWith('cloud://') && !officialAccount.qrCodeTempUrl) {
            wx.cloud.getTempFileURL({
              fileList: [oa.qrCodeUrl],
              success: (tempRes) => {
                const item = tempRes.fileList && tempRes.fileList[0]
                if (item && item.tempFileURL) {
                  this.setData({ 'officialAccount.qrCodeTempUrl': item.tempFileURL })
                }
              }
            })
          }
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
    copyText(this.data.csInfo.wechatId, { successTitle: '已复制微信号', emptyTitle: '暂无客服微信号' })
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
    const name = this.data.officialAccount.name || this.data.csInfo.officialAccountName || 'Dovelin 多芙琳宠物上门服务'
    copyText(name, { successTitle: '已复制服务号名称' })
  },

  previewOfficialAccountQrCode() {
    const url = this.data.officialAccount.qrCodeTempUrl || this.data.officialAccount.qrCodeUrl
    if (!url) return
    wx.previewImage({ current: url, urls: [url] })
  },

  saveOfficialAccountQrCode() {
    const url = this.data.officialAccount.qrCodeTempUrl || this.data.officialAccount.qrCodeUrl
    if (!url) {
      wx.showToast({ title: '暂未配置二维码', icon: 'none' })
      return
    }

    const saveImageToAlbum = (filePath) => {
      wx.saveImageToPhotosAlbum({
        filePath,
        success: () => wx.showToast({ title: '已保存至相册', icon: 'success' }),
        fail: (err) => {
          if (err && (err.errMsg || '').includes('auth')) {
            wx.showModal({
              title: '提示',
              content: '需要保存图片到相册权限，请在设置中开启',
              success: (modalRes) => {
                if (modalRes.confirm) wx.openSetting()
              }
            })
          } else {
            wx.showToast({ title: '保存失败', icon: 'none' })
          }
        }
      })
    }

    wx.showLoading({ title: '正在获取二维码...' })
    if (url.startsWith('cloud://')) {
      wx.cloud.downloadFile({
        fileID: url,
        success: (res) => {
          wx.hideLoading()
          saveImageToAlbum(res.tempFilePath)
        },
        fail: () => {
          wx.hideLoading()
          wx.showToast({ title: '下载失败', icon: 'none' })
        }
      })
    } else {
      wx.downloadFile({
        url,
        success: (res) => {
          wx.hideLoading()
          if (res.statusCode === 200) {
            saveImageToAlbum(res.tempFilePath)
          } else {
            wx.showToast({ title: '下载失败', icon: 'none' })
          }
        },
        fail: () => {
          wx.hideLoading()
          wx.showToast({ title: '下载失败', icon: 'none' })
        }
      })
    }
  },

  onOfficialAccountLoad() {
    this.setData({ officialAccountFollowBarLoaded: true })
  },

  onOfficialAccountError() {
    this.setData({ officialAccountFollowBarLoaded: false })
  },

  subscribe() {
    this.openOfficialAccountModal()
  }
})
