const { getSelectedLocation, chooseSelectedLocation, callFunction, showError, ensureLogin, getCurrentUser, getCachedSystemSettings, loadSystemSettings } = require('../../../utils/cloud')
const { getCachedHeroMedia, resolveHeroMedia } = require('../../../utils/hero-media')
const { loadMessageUnread, startStaffEntryUnread, stopStaffEntryUnread } = require('../../../utils/client-nav')
const { applyTheme, getThemeState } = require('../../../utils/theme')
const { safeNavigateTo } = require('../../../utils/nav')
const { formatDateTime } = require('../../../utils/format')

const VISIT_FEE_SERVICE_KEY = 'visit_fee'
const RETIRED_SERVICE_KEYS = ['extra_pet']

const serviceIconMap = {
  walk: 'ri-footprint-fill',
  feed: 'ri-restaurant-fill',
  clean: 'ri-sparkling-fill',
  litter: 'ri-delete-bin-fill',
  play: 'ri-gamepad-fill',
  medicine: 'ri-capsule-fill',
  visit_fee: 'ri-map-pin-2-fill'
}

const CUSTOM_SERVICE_COVERS_KEY = 'custom_service_covers'

function getCustomServiceCovers() {
  try {
    return wx.getStorageSync(CUSTOM_SERVICE_COVERS_KEY) || {}
  } catch (e) {
    return {}
  }
}

function getTodayDateString() {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function isGroupNoticeDismissedToday() {
  try {
    const todayStr = getTodayDateString()
    const dismissedDate = wx.getStorageSync('dismiss_community_group_notice_date')
    return dismissedDate === todayStr
  } catch (_) {
    return false
  }
}

function buildGroupNoticeCards(result) {
  if (!result) return []
  const cards = []
  const communityName = result.communityName || '本小区'
  const seenGroupIds = new Set()

  // 1. 优先提取“我的拼单”（我发起的或我已参加的拼单，招募中）
  // 必须只显示为“🐾 我的拼单”，绝不重复出现在小区邻居拼单中
  const rawMyGroups = [
    ...(result.myGroups || []),
    ...((result.groups || []).filter((g) => g && g.mine))
  ]

  for (const group of rawMyGroups) {
    if (!group) continue
    const gid = String(group.id || group._id || '')
    if (!gid || seenGroupIds.has(gid)) continue
    // 仅展示已付款、未成团的有效拼单（已取消/已失效不展示在弹窗中）
    if (group.status !== 'recruiting' || group.orderStatus === 'pending_pay' || group.paymentExpired || !(group.householdCount > 0)) continue

    seenGroupIds.add(gid)
    const minH = group.minHouseholds || (group.rules && group.rules.minHouseholds) || 2
    const currentH = group.householdCount || 1
    const remaining = Math.max(0, minH - currentH)
    cards.push({
      id: gid,
      groupId: gid,
      type: 'my_group',
      badge: '🐾 我的拼单',
      communityName,
      title: group.serviceSummary ? `${group.serviceSummary}拼单` : '我的拼单',
      highlightText: group.status === 'formed' ? '🎉 已成团！享受拼单优惠' : `招募中 · 已有 ${currentH} 户 (还差 ${remaining} 户)`,
      subText: group.statusText || (group.status === 'formed' ? '拼单已成团' : '等待邻居参团'),
      actionText: '查看拼单进度'
    })
  }

  // 2. 邻居发起的招募中拼单（排除我自己的拼单、排除已出现的拼单、排除0人无效拼单）
  const activeNeighborGroups = (result.groups || []).filter((g) => g && !g.mine && g.status === 'recruiting' && (g.householdCount || 0) > 0)
  for (const group of activeNeighborGroups) {
    const gid = String(group.id || group._id || '')
    if (!gid || seenGroupIds.has(gid)) continue

    seenGroupIds.add(gid)
    const minH = group.minHouseholds || (group.rules && group.rules.minHouseholds) || 2
    const currentH = group.householdCount || 1
    const remaining = Math.max(1, minH - currentH)
    const timeStr = group.startTime ? (typeof formatDateTime === 'function' ? formatDateTime(group.startTime) : group.startTime) : ''
    cards.push({
      id: gid,
      groupId: gid,
      type: 'community_group',
      badge: '🏡 同小区拼单',
      communityName,
      title: group.serviceSummary ? `${group.serviceSummary}拼单` : '邻居拼单',
      highlightText: `已有 ${currentH} 户参团 · 还差 ${remaining} 户成团`,
      subText: timeStr ? `服务时间: ${timeStr}` : (group.serviceSummary || '点击查看详情'),
      actionText: '立即查看拼单'
    })
  }

  // 3. 兜底汇总卡片（当没有单项列表但有拼单统计时）
  if (cards.length === 0 && (result.availableCount || (result.myGroups && result.myGroups.length))) {
    const hasMyGroups = Array.isArray(result.myGroups) && result.myGroups.some((g) => g && g.status === 'recruiting' && g.orderStatus !== 'pending_pay' && !g.paymentExpired && g.householdCount > 0)
    if (hasMyGroups) {
      cards.push({
        id: 'summary_my',
        groupId: 'summary_my',
        type: 'my_group',
        badge: '🐾 我的拼单',
        communityName,
        title: '我的拼单',
        highlightText: '查看我发起和参加的拼单',
        subText: '拼单进行中',
        actionText: '查看拼单进度'
      })
    } else if (result.availableCount && !Array.isArray(result.groups)) {
      cards.push({
        id: 'summary_community',
        groupId: 'summary_community',
        type: 'community_group',
        badge: '🏡 同小区拼单',
        communityName,
        title: '同小区拼单',
        highlightText: `${result.availableCount} 个邻居拼单可加入`,
        subText: '邻居拼单享优惠',
        actionText: '立即查看拼单'
      })
    }
  }

  return cards
}

function normalizeHomeServicePrices(options = []) {
  const localCovers = getCustomServiceCovers()
  return options
    .filter((item) => item.key !== VISIT_FEE_SERVICE_KEY && !RETIRED_SERVICE_KEYS.includes(item.key) && item.enabled !== false && item.showOnHome === true)
    .map((item) => {
      let cover = item.coverUrl || localCovers[item.key] || ''
      if (typeof cover === 'string' && cover.startsWith('/images/services/')) {
        cover = ''
      }
      const icon = serviceIconMap[item.key] || 'ri-price-tag-3-fill'
      let res = { ...item, coverUrl: cover, serviceIcon: icon }
      if (item.key === 'walk' && String(item.label || '').includes('上门')) {
        res = { ...res, label: '遛狗服务', price: 39, description: '牵引遛狗、轨迹记录、回家安置', priceText: '¥39起' }
      }
      if (item.key === 'feed' && String(item.label || '').includes('上门')) {
        res = { ...res, label: '喂养服务', price: 29, description: '换粮换水、基础陪伴', priceText: '¥29起' }
      }
      return res
    })
}

const defaultModules = {
  quickBooking: true,
  nearbySitters: true,
  repeatBooking: true,
  hotServices: true,
  newbieCoupon: true,
  featuredSitters: true,
  platformAssurance: true,
  historyStats: true,
  lottery: true,
  petBeautyActivity: true
}

Page({
  data: {
    themeClass: 'theme-day',
    protectedNavigationUrl: '',
    locationName: '选择位置',
    locationTip: '点击选择当前位置或常用地址',
    latitude: 0,
    longitude: 0,
    lotteryActivity: null,
    lotteryLoaded: false,
    lotteryFloatVisible: false,
    petBeautyContestEnabled: true,
    homePage: {
      ctaTitle: '立即预约上门宠护',
      ctaSubtitle: '填写宠物和服务时间，平台认证宠托师快速响应。',
      ctaText: '立即预约',
      nearbyTitle: '附近宠托师',
      repeatTitle: '一键复购',
      couponTitle: '新人优惠',
      assuranceTitle: '平台保障',
      modules: defaultModules
    },
    statsData: {
      completedCount: '0',
      sitterCount: '0',
      ratingCount: '0'
    },
    servicePrices: [],
    displayServicePrices: [],
    hotServicesScrollLeft: 0,
    isHotServicesLooping: false,
    featuredSitters: [],
    coupons: [],
    noticeTicker: { enabled: false, items: [] },
    maintenance: { petRanking: false, booking: false, invitation: false },
    claimingCouponId: '',
    repeatOrder: null,
    recentOrders: [],
    assuranceItems: [],
    staffUnreadCount: 0,
    staffUnreadCountText: '0',
    messageUnreadCount: 0,
    messageHasUnread: false,
    communityGroupNotice: null,
    showCommunityGroupNotice: true,
    groupNoticeDismissed: false,
    groupNoticeCards: [],
    noticeCardDismissing: false,
    noticeCardRebounding: false,
    topCardTransformStyle: '',
    staffEntryLoaded: true,
    staffEntryTitle: '宠护端',
    staffEntryTip: '',
    staffEntryStatus: 'none',

    // 服务流程说明折叠状态
    flowExpanded: false,

    // 轮播 hero 相关状态
    heroCarouselEnabled: false,
    heroLoading: true,
    heroAutoRotate: true,
    heroRotateInterval: 5000,
    heroSlides: [],
    heroCurrent: 0,
    heroCarouselKey: '',
    heroAutoplay: true,
    heroPlayingVideoId: null,
    heroPausedByVideo: false,
    pageScrollTop: 0
  },

  onShow() {
    this._staffEntryVisible = true
    startStaffEntryUnread(this)
    this._isPageActive = true
    clearTimeout(this._navigatingSafetyTimer)
    this._navigatingLock = false
    if (this.data.protectedNavigationUrl) {
      this.setData({ protectedNavigationUrl: '' })
    }
    this.applyCurrentTheme()
    this.applySavedLocation()
    if (isGroupNoticeDismissedToday()) {
      this.setData({ showCommunityGroupNotice: false, groupNoticeDismissed: true })
    }
    if (!this._heroRestored) {
      this._heroRestored = true
      const cached = getCachedSystemSettings()
      this.setData({ noticeTicker: cached.noticeTicker || { enabled: false, items: [] }, maintenance: cached.maintenance || this.data.maintenance })
      if (cached.homeHeroCarousel && cached.homeHeroCarousel.enabled) this.applyHeroCarousel(cached.homeHeroCarousel)
    }
    this.loadHeroCarousel()
    this.loadHomePageData()
    this.loadStaffEntryState()
    this.loadCommunityGroups()
    loadMessageUnread(this)
    if (this.data.isHotServicesLooping) {
      this.startHotServicesAutoScroll()
    }
  },

  showNoticeTickerItem(e) {
    const text = e.currentTarget.dataset.text
    if (text) wx.showModal({ title: '平台公告', content: text, showCancel: false })
  },

  async loadCommunityGroups() {
    clearTimeout(this._groupNoticeTimer)
    const request = this._groupNoticeRequest = (this._groupNoticeRequest || 0) + 1
    const currentRequest = () => this._isPageActive && request === this._groupNoticeRequest
    let authenticated = false
    try {
      const user = typeof getCurrentUser === 'function' ? await getCurrentUser() : null
      if (!currentRequest()) return
      if (!user) return this.setData({ communityGroupNotice: null, showCommunityGroupNotice: false, groupNoticeCards: [] })
      authenticated = true
      const result = await callFunction('playground', 'listCommunityGroupBuys')
      const current = await getCurrentUser()
      if (currentRequest()) {
        const isOwner = current && (current.openid || current._id) === (user.openid || user._id)
        const validNotice = isOwner ? { ...result, myGroups: (result.myGroups || []).filter(g => g && g.status === 'recruiting' && g.orderStatus !== 'pending_pay' && !g.paymentExpired && g.householdCount > 0) } : null
        const isDismissed = this.data.groupNoticeDismissed || isGroupNoticeDismissedToday()
        this._dismissedGroupIds = this._dismissedGroupIds || new Set()
        // 过滤掉用户在本会话中已手动上滑取消的拼单卡片，防止轮询与刷新后死而复生
        const rawCards = validNotice ? buildGroupNoticeCards(validNotice) : []
        const cards = rawCards.filter((c) => !this._dismissedGroupIds.has(c.id))
        this.setData({
          communityGroupNotice: validNotice,
          groupNoticeCards: cards,
          showCommunityGroupNotice: Boolean(validNotice && cards.length && !isDismissed)
        })
      }
    } catch (_) {
      if (currentRequest()) this.setData({ communityGroupNotice: null, showCommunityGroupNotice: false, groupNoticeCards: [] })
    } finally {
      if (authenticated && currentRequest()) {
        this._groupNoticeTimer = setTimeout(() => this.loadCommunityGroups(), 30000)
        if (this._groupNoticeTimer && typeof this._groupNoticeTimer.unref === 'function') this._groupNoticeTimer.unref()
      }
    }
  },

  onNoticeTouchStart(e) {
    if (this._isDismissing || !e.touches || e.touches.length !== 1) return
    this._touchStartX = e.touches[0].clientX
    this._touchStartY = e.touches[0].clientY
    this._touchStartTime = Date.now()
    this._touchDeltaY = 0
    this._touchMoved = false
    if (this.data.noticeCardRebounding) {
      this.setData({ noticeCardRebounding: false })
    }
  },

  onNoticeTouchMove(e) {
    if (this._isDismissing || !this._touchStartY || !e.touches || e.touches.length !== 1) return
    const clientX = e.touches[0].clientX
    const clientY = e.touches[0].clientY
    const deltaX = clientX - (this._touchStartX || 0)
    const deltaY = clientY - this._touchStartY

    // 若水平位移明显大于垂直位移，判定为非上下滑动，不触发卡片垂直动效
    if (Math.abs(deltaX) > Math.abs(deltaY) * 1.5 && Math.abs(deltaX) > 10) return

    if (deltaY <= 0) {
      // 向上滑动：第一张卡片随手指上移，逐渐增加模糊度并淡出
      const moveUp = -deltaY
      if (moveUp > 8) this._touchMoved = true
      const opacity = Math.max(0.05, Number((1 - (moveUp / 140) * 0.85).toFixed(2)))
      const blur = Math.min(14, Math.round(moveUp / 6))
      this._touchDeltaY = deltaY
      this.setData({
        topCardTransformStyle: `transform: translateY(${deltaY}px); opacity: ${opacity}; filter: blur(${blur}px); -webkit-filter: blur(${blur}px);`
      })
    } else {
      // 向下拉微弱阻尼
      const dampY = Math.min(deltaY * 0.15, 12)
      this._touchDeltaY = dampY
      this.setData({
        topCardTransformStyle: `transform: translateY(${dampY}px);`
      })
    }
  },

  onNoticeTouchEnd() {
    if (this._isDismissing) return
    const deltaY = this._touchDeltaY || 0
    const distance = -deltaY
    const duration = Date.now() - (this._touchStartTime || 0)
    const velocity = distance / Math.max(duration, 1)

    if (this._touchMoved) {
      // 产生过滑动位移，防止松手瞬间误触发卡片 bindtap 点击跳转
      this._preventCardTap = true
      setTimeout(() => { this._preventCardTap = false }, 320)
    }

    if (distance >= 45 || (distance >= 20 && velocity > 0.25)) {
      // 向上滑达到阈值，触发飞出模糊淡出动画
      this.animateDismissTopCard()
    } else {
      // 未达到阈值，弹性平滑回弹原位
      this.setData({
        noticeCardRebounding: true,
        topCardTransformStyle: ''
      })
      clearTimeout(this._noticeReboundTimer)
      this._noticeReboundTimer = setTimeout(() => {
        if (!this._isDismissing && this._isPageActive !== false) {
          this.setData({ noticeCardRebounding: false })
        }
      }, 260)
    }
    this._touchStartY = 0
    this._touchStartX = 0
    this._touchDeltaY = 0
  },

  onNoticeTouchCancel() {
    this.onNoticeTouchEnd()
  },

  animateDismissTopCard() {
    if (this._isDismissing) return
    this._isDismissing = true
    this._preventCardTap = true
    this.setData({
      noticeCardDismissing: true,
      noticeCardRebounding: false,
      topCardTransformStyle: ''
    })

    clearTimeout(this._noticeDismissTimer)
    this._noticeDismissTimer = setTimeout(() => {
      this._isDismissing = false
      this._preventCardTap = false
      if (this._isPageActive === false) return

      const currentCards = this.data.groupNoticeCards || []
      const topCard = currentCards[0]
      if (topCard && topCard.id) {
        this._dismissedGroupIds = this._dismissedGroupIds || new Set()
        this._dismissedGroupIds.add(topCard.id)
      }

      const remaining = currentCards.slice(1)
      if (remaining.length === 0) {
        // 卡片已全部取消（或原本仅有单张卡片）
        this.setData({
          groupNoticeCards: [],
          showCommunityGroupNotice: false,
          groupNoticeDismissed: true,
          noticeCardDismissing: false,
          topCardTransformStyle: ''
        })
      } else {
        // 还有剩余堆叠卡片：下一张顶上来成为当前卡片
        this.setData({
          groupNoticeCards: remaining,
          noticeCardDismissing: false,
          topCardTransformStyle: ''
        })
      }
    }, 270)
  },

  dismissGroupNotice(e) {
    if (!e || typeof e !== 'object' || !e.type) {
      // 同步直接关闭（满足测试及快速调用契约）
      const currentCards = this.data.groupNoticeCards || []
      this._dismissedGroupIds = this._dismissedGroupIds || new Set()
      for (const card of currentCards) {
        if (card && card.id) this._dismissedGroupIds.add(card.id)
      }
      this.setData({
        showCommunityGroupNotice: false,
        groupNoticeDismissed: true,
        groupNoticeCards: []
      })
      return
    }
    // 用户真机点击右上角取消按钮时触发飞出模糊淡出动效
    this.animateDismissTopCard()
  },

  dismissGroupNoticeToday() {
    try {
      wx.setStorageSync('dismiss_community_group_notice_date', getTodayDateString())
    } catch (_) {}
    const currentCards = this.data.groupNoticeCards || []
    this._dismissedGroupIds = this._dismissedGroupIds || new Set()
    for (const card of currentCards) {
      if (card && card.id) this._dismissedGroupIds.add(card.id)
    }
    this.setData({
      showCommunityGroupNotice: false,
      groupNoticeDismissed: true,
      groupNoticeCards: []
    })
    wx.showToast({ title: '今日将不再提示拼单', icon: 'none' })
  },
  openCommunityGroups() {
    if (this._preventCardTap || this._isDismissing || this._touchMoved) return
    wx.navigateTo({url:'/pages/client/orders/group-buy/index'})
  },
  toggleFlowExpand() {
    this.setData({
      flowExpanded: !this.data.flowExpanded
    })
  },

  onPageScroll(e) {
    this.setData({
      pageScrollTop: (e && e.scrollTop) || 0
    })
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
    return Promise.all([this.loadHeroCarousel(), this.loadHomePageData(), this.loadCommunityGroups()])
      .finally(() => wx.stopPullDownRefresh())
  },

  onHide() {
    this._staffEntryVisible = false
    stopStaffEntryUnread(this)
    clearTimeout(this._groupNoticeTimer)
    clearTimeout(this._noticeDismissTimer)
    clearTimeout(this._noticeReboundTimer)
    this._isDismissing = false
    this._groupNoticeRequest=(this._groupNoticeRequest||0)+1
    this._isPageActive = false
    this._homeDataRequestSeq = (this._homeDataRequestSeq || 0) + 1
    this._heroSettingsRequestSeq = (this._heroSettingsRequestSeq || 0) + 1
    this._heroCarouselRequestSeq = (this._heroCarouselRequestSeq || 0) + 1
    this._protectedNavigationSeq = (this._protectedNavigationSeq || 0) + 1
    this.stopAllVideos()
    this.clearLotteryFloatTimer()
    this.stopHotServicesAutoScroll()
    if (this.hotServicesResumeTimer) {
      clearTimeout(this.hotServicesResumeTimer)
      this.hotServicesResumeTimer = null
    }
    clearTimeout(this._navigatingSafetyTimer)
    this._navigatingLock = false
    if (this.data.protectedNavigationUrl) {
      this.setData({ protectedNavigationUrl: '' })
    }
    if (this.data.lotteryFloatVisible) {
      setTimeout(() => {
        if (!this._isPageActive) this.setData({ lotteryFloatVisible: false })
      }, 350)
    }
  },

  onUnload() {
    this._staffEntryVisible = false
    stopStaffEntryUnread(this)
    clearTimeout(this._groupNoticeTimer)
    clearTimeout(this._noticeDismissTimer)
    clearTimeout(this._noticeReboundTimer)
    this._isDismissing = false
    this._groupNoticeRequest=(this._groupNoticeRequest||0)+1
    this._isPageActive = false
    this._homeDataRequestSeq = (this._homeDataRequestSeq || 0) + 1
    this._heroSettingsRequestSeq = (this._heroSettingsRequestSeq || 0) + 1
    this._heroCarouselRequestSeq = (this._heroCarouselRequestSeq || 0) + 1
    this._protectedNavigationSeq = (this._protectedNavigationSeq || 0) + 1
    this.stopAllVideos()
    this.clearLotteryFloatTimer()
    this.stopHotServicesAutoScroll()
    if (this.hotServicesResumeTimer) {
      clearTimeout(this.hotServicesResumeTimer)
      this.hotServicesResumeTimer = null
    }
  },

  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },

  showModuleMaintenance(url) {
    const path = String(url || '').split('?')[0]
    const module = path === '/pages/client/orders/create/index' ? 'booking'
      : path === '/pages/client/pet-beauty/activity/index' ? 'petRanking' : ''
    if (!module || this.data.maintenance?.[module] !== true) return false
    const label = module === 'booking' ? '预约下单' : '宠物排行榜'
    wx.showModal({ title: '功能维护', content: `${label}功能暂时不可使用，正在维护中`, showCancel: false })
    return true
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    if (this.showModuleMaintenance(url)) return
    const pages = getCurrentPages()
    const current = pages[pages.length - 1]
    const currentRoute = current && current.route ? '/' + current.route : ''
    if (currentRoute === url) return
    const mainNavUrls = ['/pages/client/home/index', '/pages/client/sitters/list/index', '/pages/client/orders/list/index', '/pages/client/messages/index', '/pages/client/profile/index']
    const method = mainNavUrls.includes(url) ? 'redirectTo' : 'navigateTo'
    wx[method]({ url })
  },

  goProtected(e) {
    const url = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.url
    if (!url || this._navigatingLock || this.data.protectedNavigationUrl) return
    if (this.showModuleMaintenance(url)) return
    this._navigatingLock = true
    const requestSeq = this._protectedNavigationSeq = (this._protectedNavigationSeq || 0) + 1
    const isActive = () => this._isPageActive !== false && requestSeq === this._protectedNavigationSeq
    this.setData({ protectedNavigationUrl: url })

    if (typeof wx !== 'undefined' && typeof wx.vibrateShort === 'function') {
      try { wx.vibrateShort({ type: 'light' }) } catch (_) {}
    }

    clearTimeout(this._navigatingSafetyTimer)
    this._navigatingSafetyTimer = setTimeout(() => {
      this._navigatingLock = false
      if (this.data.protectedNavigationUrl) {
        this.setData({ protectedNavigationUrl: '' })
      }
    }, 1500)

    const releaseNavigation = () => {
      clearTimeout(this._navigatingSafetyTimer)
      this._navigatingLock = false
      if (this.data.protectedNavigationUrl) {
        this.setData({ protectedNavigationUrl: '' })
      }
    }

    return ensureLogin({ content: '登录后可预约服务、管理宠物、查看订单和消息。', isActive })
      .then(() => {
        const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
        const current = pages[pages.length - 1]
        const currentRoute = current && current.route ? (current.route.startsWith('/') ? current.route : '/' + current.route) : ''
        if (currentRoute === url) {
          releaseNavigation()
          return
        }
        const mainNavUrls = ['/pages/client/home/index', '/pages/client/sitters/list/index', '/pages/client/orders/list/index', '/pages/client/messages/index', '/pages/client/profile/index']
        return new Promise((resolve, reject) => {
          const options = {
            url,
            success: (res) => {
              resolve(res)
            },
            fail: (err) => {
              reject(err)
            }
          }
          if (mainNavUrls.includes(url)) wx.redirectTo(options)
          else safeNavigateTo(options)
        })
      }, () => {
        // ensureLogin already presents authentication errors or opens the login page.
      })
      .catch((error) => {
        const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
        const current = pages[pages.length - 1]
        const currentRoute = current && current.route ? (current.route.startsWith('/') ? current.route : '/' + current.route) : ''
        const targetPath = (url || '').split('?')[0]
        if (currentRoute === targetPath) return
        console.error('[home navigation failed]', url, error)
        showError(error)
      })
      .finally(() => {
        releaseNavigation()
      })
  },

  onTapQuickRepeat() {
    ensureLogin({ content: '登录后可一键复购历史订单。' })
      .then(() => {
        if (this.data.repeatOrder && this.data.repeatOrder._id) {
          wx.navigateTo({
            url: `/pages/client/orders/create/index?rebookOrderId=${this.data.repeatOrder._id}`
          })
          return
        }
        return callFunction('order', 'getClientOrders', { page: 1, pageSize: 5 })
          .then((res) => {
            const list = (res && res.list) || []
            const validOrder = list.find((o) => ['completed', 'in_service', 'assigned'].includes(o.status)) || list[0]
            if (validOrder && validOrder._id) {
              this.setData({ repeatOrder: validOrder })
              wx.navigateTo({
                url: `/pages/client/orders/create/index?rebookOrderId=${validOrder._id}`
              })
            } else {
              wx.showToast({ title: '暂无历史订单，直接为您开启预约', icon: 'none' })
              wx.navigateTo({
                url: '/pages/client/orders/create/index'
              })
            }
          })
          .catch(() => {
            wx.navigateTo({
              url: '/pages/client/orders/create/index'
            })
          })
      })
      .catch(() => {})
  },

  loadStaffEntryState() {
    // 静默刷新宠护师状态，不重置 staffEntryLoaded: false，避免每次页面 onShow 时金刚区图标消失跳动
    getCurrentUser({ silent: true, sessionOnly: true })
      .then((user) => {
        if (!user) {
          const title = '申请宠护师'
          this.setData({
            staffEntryLoaded: true,
            staffEntryStatus: 'none',
            staffEntryTitle: title,
            staffEntryTip: '通过审核后进入多芙琳宠护端接单'
          })
          try { wx.setStorageSync('cached_staff_entry_title', title) } catch (e) {}
          return
        }
        return callFunction('staff', 'getStaffProfile')
          .then((profile) => this.applyStaffEntryState(profile))
          .catch(() => this.applyStaffEntryState(null))
      })
      .catch(() => this.setData({ staffEntryLoaded: true }))
  },

  applyStaffEntryState(profile) {
    const status = profile && profile.auditStatus
    const stateMap = {
      approved: { title: '宠护端', tip: '查看任务与接单工作台' },
      pending: { title: '审核中', tip: '资料已提交，请等待平台审核' },
      rejected: { title: '修改认证', tip: (profile && profile.auditRemark) || '审核未通过，请修改后重新提交' },
      none: { title: '申请宠护师', tip: '通过审核后进入多芙琳宠护端接单' }
    }
    const entry = stateMap[status] || stateMap.none
    this.setData({
      staffEntryLoaded: true,
      staffEntryStatus: status || 'none',
      staffEntryTitle: entry.title,
      staffEntryTip: entry.tip
    })
    try { wx.setStorageSync('cached_staff_entry_title', entry.title) } catch (e) {}
  },

  openStaffEntry() {
    ensureLogin({ content: '登录后可申请或进入多芙琳宠护端。' })
      .then(() => callFunction('staff', 'getStaffProfile'))
      .then((profile) => {
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
      .catch(showError)
  },

  claimNewbieCoupon(e) {
    const templateId = e.currentTarget.dataset.id
    if (!templateId || this.data.claimingCouponId) return
    ensureLogin({ content: '登录后可领取新人优惠券。' })
      .then(() => {
        this.setData({ claimingCouponId: templateId })
        return callFunction('coupon', 'claimNewbieCoupon', { templateId })
      })
      .then(() => {
        wx.showToast({ title: '已领取' })
        this.setData({
          claimingCouponId: '',
          coupons: this.data.coupons.filter((item) => item._id !== templateId)
        })
        this.loadHomePageData()
      })
      .catch((err) => {
        this.setData({ claimingCouponId: '' })
        showError(err)
      })
  },

  applySavedLocation() {
    const location = getSelectedLocation()
    if (!location) return
    this.setData({
      locationName: location.name,
      locationTip: location.address || '已选择服务附近位置',
      latitude: location.latitude,
      longitude: location.longitude
    })
  },

  updateLocation() {
    chooseSelectedLocation()
      .then((loc) => {
        this.setData({
          locationName: loc.name || '已选择位置',
          locationTip: loc.address || '已选择服务附近位置',
          latitude: loc.latitude,
          longitude: loc.longitude
        })
        this.loadHomePageData()
      })
      .catch((err) => {
        console.log('chooseSelectedLocation fail error:', err)
        const errMsg = (err && err.errMsg) || ''
        if (errMsg.includes('cancel')) return
        if (errMsg.includes('authorize') || errMsg.includes('auth deny') || errMsg.includes('scope.userLocation')) {
          this.showLocationAuth()
          return
        }
        wx.showToast({ title: '获取位置失败', icon: 'none' })
      })
  },

  loadHomePageData() {
    const requestSeq = this._homeDataRequestSeq = (this._homeDataRequestSeq || 0) + 1
    const settingsSeq = this._displaySettingsRequestSeq = (this._displaySettingsRequestSeq || 0) + 1
    const location = getSelectedLocation()
    const params = location ? { latitude: location.latitude, longitude: location.longitude } : {}
    return callFunction('system', 'getHomePageData', params)
      .then((homeData) => {
        if (requestSeq !== this._homeDataRequestSeq) return
        const homePage = homeData.settings && homeData.settings.homePage ? homeData.settings.homePage : this.data.homePage
        const servicePrices = normalizeHomeServicePrices(homeData.servicePrices || [])
        this.setData({
          ...this.getDisplaySettingsPatch(homeData.settings, settingsSeq),
          homePage: {
            ...homePage,
            modules: { ...defaultModules, ...(homePage.modules || {}) }
          },
          petBeautyContestEnabled: homeData.settings?.petBeautyContestEnabled !== false,
          servicePrices,
          featuredSitters: homeData.featuredSitters || [],
          coupons: homeData.coupons || [],
          repeatOrder: homeData.repeatOrder || null,
          recentOrders: homeData.recentOrders || [],
          statsData: homeData.statsData || this.data.statsData,
          assuranceItems: homeData.assuranceItems || []
        }, () => {
          this.initHotServicesScroll()
        })
        this.resolveHomeServiceCoverUrls(servicePrices).then((resolved) => {
          if (resolved && requestSeq === this._homeDataRequestSeq) {
            this.setData({ servicePrices: resolved }, () => {
              this.initHotServicesScroll()
            })
          }
        })
        if (homePage.modules && homePage.modules.lottery === false) {
          this.clearLotteryFloatTimer()
          this.setData({ lotteryActivity: null, lotteryLoaded: false, lotteryFloatVisible: false })
        } else {
          this.loadLottery()
        }
      })
      .catch((error) => {
        if (requestSeq !== this._homeDataRequestSeq) return
        this.loadLottery()
        showError(error)
      })
  },

  resolveHomeServiceCoverUrls(services = []) {
    const cloudIds = (services || []).map((item) => item.coverUrl).filter((url) => url && url.startsWith('cloud://'))
    if (!cloudIds.length) return Promise.resolve(services)
    return new Promise((resolve) => {
      wx.cloud.getTempFileURL({
        fileList: Array.from(new Set(cloudIds)),
        success: (res) => {
          const map = {}
          ;(res.fileList || []).forEach((f) => {
            if (f.fileID && f.tempFileURL) map[f.fileID] = f.tempFileURL
          })
          const resolved = services.map((s) => ({
            ...s,
            coverUrl: (s.coverUrl && map[s.coverUrl]) || s.coverUrl
          }))
          resolve(resolved)
        },
        fail: () => resolve(services)
      })
    })
  },

  loadLottery() {
    // 不要求登录，公开接口；已登录时会返回今日剩余抽奖次数
    callFunction('lottery', 'getActiveActivity')
      .then((activity) => {
        this.setData({ lotteryActivity: activity, lotteryLoaded: true })
        this.showLotteryFloatIfNeeded(activity)
      })
      .catch(() => this.setData({ lotteryLoaded: true }))
  },

  showLotteryFloatIfNeeded(activity) {
    const remainingDrawCount = Number(activity && activity.remainingDrawCount)
    const hasRemainingDrawCount = Number.isFinite(remainingDrawCount) && remainingDrawCount > 0
    const noRemainingDrawCount = Number.isFinite(remainingDrawCount) && remainingDrawCount <= 0
    const drawStateUnknown = activity && activity.canDraw === undefined && activity.remainingDrawCount === undefined
    const canDraw = activity && !noRemainingDrawCount && activity.canDraw !== false && (activity.canDraw === true || hasRemainingDrawCount || drawStateUnknown)
    if (!canDraw) {
      this.clearLotteryFloatTimer()
      this.setData({ lotteryFloatVisible: false })
      return
    }
    const app = getApp()
    if (app.globalData && app.globalData.lotteryFloatShownThisLaunch) {
      this.setData({ lotteryFloatVisible: false })
      return
    }
    if (app.globalData) app.globalData.lotteryFloatShownThisLaunch = true
    this.clearLotteryFloatTimer()
    this.setData({ lotteryFloatVisible: true })
    this._lotteryFloatTimer = setTimeout(() => {
      this.setData({ lotteryFloatVisible: false })
      this._lotteryFloatTimer = null
    }, 10000)
  },

  clearLotteryFloatTimer() {
    if (!this._lotteryFloatTimer) return
    clearTimeout(this._lotteryFloatTimer)
    this._lotteryFloatTimer = null
  },

  getDisplaySettingsPatch(settings, requestSeq) {
    if (requestSeq < (this._displaySettingsAppliedSeq || 0)) return {}
    this._displaySettingsAppliedSeq = requestSeq
    return {
      noticeTicker: settings?.noticeTicker || { enabled: false, items: [] },
      maintenance: settings?.maintenance || this.data.maintenance
    }
  },

  loadHeroCarousel() {
    const seq = this._heroSettingsRequestSeq = (this._heroSettingsRequestSeq || 0) + 1
    const settingsSeq = this._displaySettingsRequestSeq = (this._displaySettingsRequestSeq || 0) + 1
    return loadSystemSettings()
      .then((settings) => {
        if (seq === this._heroSettingsRequestSeq) {
          const patch = this.getDisplaySettingsPatch(settings, settingsSeq)
          if (Object.keys(patch).length) this.setData(patch)
          return this.applyHeroCarousel(settings.homeHeroCarousel)
        }
      })
      .catch(() => {
        if (seq === this._heroSettingsRequestSeq) this.setData({ heroLoading: false })
      })
  },

  applyHeroCarousel(carousel = {}, force = false) {
    this._heroCarouselRequestSeq = (this._heroCarouselRequestSeq || 0) + 1
    const requestSeq = this._heroCarouselRequestSeq

    if (!carousel.enabled || !Array.isArray(carousel.items) || !carousel.items.length) {
      this.setData({ heroLoading: false, heroCarouselEnabled: false, heroSlides: [], heroCarouselKey: '', heroCurrent: 0 })
      return
    }

    const validItems = carousel.items.filter((item) => item && item.enabled !== false && item.fileId)
    if (!validItems.length) {
      this.setData({ heroLoading: false, heroCarouselEnabled: false, heroSlides: [], heroCarouselKey: '', heroCurrent: 0 })
      return
    }

    const carouselKey = validItems.map((item) => [item.id || '', item.fileId, item.posterFileId || '', item.type || 'image', item.title || '', item.subtitle || '', item.linkUrl || '', item.linkTitle || ''].join(':')).join('|')
    const autoRotate = carousel.autoRotate !== false
    const interval = Number(carousel.rotateIntervalMs) || 5000

    this._heroConfig = carousel
    if (!force && this.data.heroCarouselEnabled && this.data.heroCarouselKey === carouselKey && this.data.heroSlides.length === validItems.length) {
      this.setData({
        heroLoading: false,
        heroAutoRotate: autoRotate,
        heroRotateInterval: interval,
        heroAutoplay: autoRotate && this.data.heroSlides.length > 1 && !this.data.heroPausedByVideo
      })
      return
    }

    const fileIds = []
    validItems.forEach((item) => {
      if (item.fileId) fileIds.push(item.fileId)
      if (item.posterFileId) fileIds.push(item.posterFileId)
    })

    const uniqueIds = Array.from(new Set(fileIds))
    const applyUrls = (urlMap) => {
      if (requestSeq !== this._heroCarouselRequestSeq) return
      const slides = validItems.map((item) => ({
        ...item,
        url: urlMap[item.fileId] || '',
        posterUrl: urlMap[item.posterFileId] || urlMap[item.fileId] || ''
      })).filter(item => item.url)

      if (!slides.length) {
        // Keep the displayed media during a transient refresh failure.
        this.setData({ heroLoading: false })
        return
      }

      this.setData({
        heroLoading: false,
        heroCarouselEnabled: true,
        heroAutoRotate: autoRotate,
        heroRotateInterval: interval,
        heroSlides: slides,
        heroCarouselKey: carouselKey,
        heroCurrent: Math.min(this.data.heroCurrent || 0, slides.length - 1),
        heroAutoplay: autoRotate && slides.length > 1 && !this.data.heroPausedByVideo
      })
    }
    // Render reusable URLs immediately, before any network request. HTTP caching
    // can then reuse the same image across redirectTo-created home instances.
    const cached = force ? {} : getCachedHeroMedia(uniqueIds)
    if (validItems.every(item => cached[item.fileId] && (!item.posterFileId || cached[item.posterFileId]))) {
      applyUrls(cached)
      return Promise.resolve()
    }
    return resolveHeroMedia(uniqueIds, { force }).then(applyUrls)
  },

  onHeroMediaError(e) {
    const id = e.currentTarget.dataset.id
    const url = e.currentTarget.dataset.url
    if (!this._heroConfig || !this.data.heroSlides.some(item => item.id === id && (item.url === url || item.posterUrl === url))) return
    // A revoked/expired signed URL can fail before its conservative cache TTL.
    const key = `${this.data.heroCarouselKey}:${id}`
    this._heroRetriedKeys = this._heroRetriedKeys || new Set()
    if (this._heroRetriedKeys.has(key)) return
    this._heroRetriedKeys.add(key)
    this.applyHeroCarousel(this._heroConfig, true)
  },

  onHeroSlideTap(e) {
    const item = e.currentTarget.dataset.item
    if (!item) return
    const linkUrl = String(item.linkUrl || '').trim()
    if (linkUrl) {
      const targetUrl = linkUrl.startsWith('/') ? linkUrl : `/${linkUrl}`
      const pages = getCurrentPages()
      const current = pages[pages.length - 1]
      const currentRoute = current && current.route ? '/' + current.route : ''
      const targetPath = targetUrl.split('?')[0]
      if (this.showModuleMaintenance(targetPath)) return
      if (currentRoute === targetPath) return

      const mainNavUrls = [
        '/pages/client/home/index',
        '/pages/client/sitters/list/index',
        '/pages/client/orders/list/index',
        '/pages/client/messages/index',
        '/pages/client/profile/index'
      ]
      const method = mainNavUrls.includes(targetPath) ? 'redirectTo' : 'navigateTo'
      wx[method]({
        url: targetUrl,
        fail: (err) => {
          console.warn('轮播图页面跳转失败:', err, targetUrl)
          if (item.type === 'image' && item.url) {
            this.previewHeroMedia(e)
          } else if (item.type === 'video') {
            this.playHeroVideo(e)
          }
        }
      })
      return
    }

    this.previewHeroMedia(e)
  },

  noBubble() {},

  previewHeroMedia(e) {
    const item = e.currentTarget.dataset.item
    if (!item) return

    if (item.type === 'image') {
      const urls = this.data.heroSlides
        .filter((s) => s.type === 'image' && s.url)
        .map((s) => s.url)
      wx.previewImage({
        current: item.url,
        urls: urls.length ? urls : [item.url]
      })
    } else if (item.type === 'video') {
      this.playHeroVideo(e)
    }
  },

  onSwiperChange(e) {
    const current = e.detail.current
    if (this.data.heroPlayingVideoId) {
      this.stopAllVideos()
    }
    this.setData({ heroCurrent: current })
  },

  playHeroVideo(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return

    this.stopAllVideos()

    const videoCtx = wx.createVideoContext(`hero_video_${id}`, this)
    if (videoCtx) {
      videoCtx.play()
      this.setData({
        heroPlayingVideoId: id,
        heroAutoplay: false,
        heroPausedByVideo: true
      })
    }
  },

  onVideoPauseOrEnded(e) {
    const id = e.currentTarget.dataset.id
    if (this.data.heroPlayingVideoId === id) {
      this.setData({
        heroPlayingVideoId: null,
        heroPausedByVideo: false,
        heroAutoplay: this.data.heroAutoRotate && this.data.heroSlides.length > 1
      })
    }
  },

  stopAllVideos() {
    if (this.data.heroPlayingVideoId) {
      const videoCtx = wx.createVideoContext(`hero_video_${this.data.heroPlayingVideoId}`, this)
      if (videoCtx) {
        videoCtx.pause()
      }
    }
    this.setData({
      heroPlayingVideoId: null,
      heroPausedByVideo: false,
      heroAutoplay: this.data.heroAutoRotate && this.data.heroSlides.length > 1
    })
  },

  goLottery() {
    this.clearLotteryFloatTimer()
    this.setData({ lotteryFloatVisible: false })
    ensureLogin({ content: '登录后可参与抽奖。' })
      .then(() => wx.navigateTo({ url: '/pages/client/lottery/index' }))
      .catch(() => {})
  },

  showLocationAuth() {
    this.setData({
      locationName: '点击选择位置',
      locationTip: '打开地图后可手动选择地点'
    })
    wx.showModal({
      title: '需要位置权限',
      content: '请开启位置信息权限，方便推荐附近宠托师和附近订单。',
      confirmText: '去开启',
      success: (res) => {
        if (res.confirm) wx.openSetting()
      }
    })
  },

  // ==========================================
  // 热门服务横向跑马灯：>=3个时自动循环平移，触摸暂停，松手5秒后恢复
  // ==========================================
  initHotServicesScroll() {
    const list = this.data.servicePrices || []
    if (list.length < 3) {
      this.stopHotServicesAutoScroll()
      if (this.hotServicesResumeTimer) {
        clearTimeout(this.hotServicesResumeTimer)
        this.hotServicesResumeTimer = null
      }
      this.setData({
        displayServicePrices: list.map((item, idx) => ({ ...item, uniqueKey: `${item.key || idx}` })),
        isHotServicesLooping: false,
        hotServicesScrollLeft: 0
      })
      this.currentHotScrollLeft = 0
      return
    }

    // >= 3个时，拼接双份构造无缝循环
    const displayList = [
      ...list.map((item, idx) => ({ ...item, uniqueKey: `${item.key || idx}_0` })),
      ...list.map((item, idx) => ({ ...item, uniqueKey: `${item.key || idx}_1` }))
    ]

    this.setData({
      displayServicePrices: displayList,
      isHotServicesLooping: true
    }, () => {
      if (!this._isPageActive) return
      this.calcHotServicesSingleSetWidth()
      this.startHotServicesAutoScroll()
    })
  },

  calcHotServicesSingleSetWidth() {
    const list = this.data.servicePrices || []
    if (!list.length) return
    let windowWidth = 375
    try {
      const sys = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync()
      if (sys && sys.windowWidth) windowWidth = sys.windowWidth
    } catch (_) {}
    const rpx2px = windowWidth / 750
    // 每个卡片 270rpx + margin-right 18rpx = 288rpx
    this.singleSetWidth = Math.round(list.length * 288 * rpx2px)

    if (typeof this.createSelectorQuery === 'function') {
      const query = this.createSelectorQuery()
      query.selectAll('.service-price-card').boundingClientRect((rects) => {
        if (rects && rects.length >= list.length + 1) {
          const first = rects[0]
          const target = rects[list.length]
          if (first && target && target.left > first.left) {
            this.singleSetWidth = Math.round(target.left - first.left)
          }
        }
      }).exec()
    }
  },

  startHotServicesAutoScroll() {
    this.stopHotServicesAutoScroll()
    if (!this._isPageActive) return
    if (!this.data.isHotServicesLooping) return
    if (this.isHotServicesTouching) return
    if ((this.data.servicePrices || []).length < 3) return

    const STEP = 0.8
    const INTERVAL = 30

    this.hotServicesScrollTimer = setInterval(() => {
      if (!this._isPageActive) {
        this.stopHotServicesAutoScroll()
        return
      }
      if (this.isHotServicesTouching) return
      let nextLeft = (this.currentHotScrollLeft || 0) + STEP
      if (this.singleSetWidth && this.singleSetWidth > 0) {
        if (nextLeft >= this.singleSetWidth) {
          nextLeft -= this.singleSetWidth
        }
      }
      this.currentHotScrollLeft = nextLeft
      try {
        this.setData({
          hotServicesScrollLeft: Math.round(nextLeft)
        })
      } catch (_) {
        this.stopHotServicesAutoScroll()
      }
    }, INTERVAL)
  },

  stopHotServicesAutoScroll() {
    if (this.hotServicesScrollTimer) {
      clearInterval(this.hotServicesScrollTimer)
      this.hotServicesScrollTimer = null
    }
  },

  onHotServicesTouchStart() {
    if (!this.data.isHotServicesLooping) return
    this.isHotServicesTouching = true
    this.stopHotServicesAutoScroll()
    if (this.hotServicesResumeTimer) {
      clearTimeout(this.hotServicesResumeTimer)
      this.hotServicesResumeTimer = null
    }
  },

  onHotServicesScroll(e) {
    if (!e || !e.detail) return
    this.currentHotScrollLeft = e.detail.scrollLeft
    if (this.data.isHotServicesLooping && this.singleSetWidth && this.singleSetWidth > 0) {
      if (this.currentHotScrollLeft >= this.singleSetWidth * 2) {
        this.currentHotScrollLeft -= this.singleSetWidth
      }
    }
  },

  onHotServicesTouchEnd() {
    if (!this.data.isHotServicesLooping) return
    this.isHotServicesTouching = false
    if (this.hotServicesResumeTimer) {
      clearTimeout(this.hotServicesResumeTimer)
      this.hotServicesResumeTimer = null
    }
    if (!this._isPageActive) return
    // 用户取消操作 5 秒钟后再继续开启循环移动
    this.hotServicesResumeTimer = setTimeout(() => {
      if (!this._isPageActive) return
      if (!this.isHotServicesTouching) {
        this.startHotServicesAutoScroll()
      }
    }, 5000)
  }
})
