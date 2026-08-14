const { getSelectedLocation, chooseSelectedLocation, callFunction, showError, ensureLogin } = require('../../../utils/cloud')

const defaultModules = {
  quickBooking: true,
  nearbySitters: true,
  repeatBooking: true,
  hotServices: true,
  newbieCoupon: true,
  featuredSitters: true,
  platformAssurance: true,
  historyStats: true,
  lottery: true
}

Page({
  data: {
    locationName: '选择位置',
    locationTip: '点击选择当前位置或常用地址',
    latitude: 0,
    longitude: 0,
    lotteryActivity: null,
    lotteryLoaded: false,
    lotteryFloatVisible: false,
    homePage: {
      ctaTitle: '立即预约上门宠护',
      ctaSubtitle: '填写宠物和服务时间，平台认证宠托师快速响应。',
      ctaText: '立即预约',
      nearbyTitle: '附近宠托师',
      repeatTitle: '再次预约',
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
    featuredSitters: [],
    coupons: [],
    repeatOrder: null,
    recentOrders: [],
    assuranceItems: [],

    // 轮播 hero 相关状态
    heroCarouselEnabled: false,
    heroAutoRotate: true,
    heroRotateInterval: 5000,
    heroSlides: [],
    heroCurrent: 0,
    heroCarouselKey: '',
    heroAutoplay: true,
    heroPlayingVideoId: null,
    heroPausedByVideo: false
  },

  onShow() {
    this.applySavedLocation()
    this.loadHomePageData()
  },

  onHide() {
    this.stopAllVideos()
    this.clearLotteryFloatTimer()
    this.setData({ lotteryFloatVisible: false })
  },

  onUnload() {
    this.stopAllVideos()
    this.clearLotteryFloatTimer()
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.navigateTo({ url })
  },

  goProtected(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    ensureLogin({ content: '登录后可预约服务、管理宠物和查看订单。' })
      .then(() => wx.navigateTo({ url }))
      .catch(() => {})
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
    const location = getSelectedLocation()
    const params = location ? { latitude: location.latitude, longitude: location.longitude } : {}
    callFunction('system', 'getHomePageData', params)
      .then((homeData) => {
        const homePage = homeData.settings && homeData.settings.homePage ? homeData.settings.homePage : this.data.homePage
        this.setData({
          homePage: {
            ...homePage,
            modules: { ...defaultModules, ...(homePage.modules || {}) }
          },
          servicePrices: homeData.servicePrices || [],
          featuredSitters: homeData.featuredSitters || [],
          coupons: homeData.coupons || [],
          repeatOrder: homeData.repeatOrder || null,
          recentOrders: homeData.recentOrders || [],
          statsData: homeData.statsData || this.data.statsData,
          assuranceItems: homeData.assuranceItems || []
        })
        this.applyHeroCarousel(homeData.settings && homeData.settings.homeHeroCarousel)
        if (homePage.modules && homePage.modules.lottery === false) {
          this.clearLotteryFloatTimer()
          this.setData({ lotteryActivity: null, lotteryLoaded: false, lotteryFloatVisible: false })
        } else {
          this.loadLottery()
        }
      })
      .catch((error) => {
        this.loadLottery()
        this.loadHeroCarousel()
        showError(error)
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
    const hasDrawCount = Number(activity && activity.remainingDrawCount || 0) > 0
    const drawStateUnknown = activity && activity.canDraw === undefined && activity.remainingDrawCount === undefined
    const canDraw = activity && (activity.canDraw === true || hasDrawCount || drawStateUnknown)
    if (!canDraw) {
      this.clearLotteryFloatTimer()
      this.setData({ lotteryFloatVisible: false })
      return
    }
    if (this._lotteryFloatShown) return
    this._lotteryFloatShown = true
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

  loadHeroCarousel() {
    callFunction('system', 'getSettings')
      .then((settings) => this.applyHeroCarousel(settings.homeHeroCarousel))
      .catch(() => {
        this.setData({ heroCarouselEnabled: false, heroSlides: [] })
      })
  },

  applyHeroCarousel(carousel = {}) {
    this._heroCarouselRequestSeq = (this._heroCarouselRequestSeq || 0) + 1
    const requestSeq = this._heroCarouselRequestSeq

    if (!carousel.enabled || !Array.isArray(carousel.items) || !carousel.items.length) {
      this.setData({ heroCarouselEnabled: false, heroSlides: [], heroCarouselKey: '', heroCurrent: 0 })
      return
    }

    const validItems = carousel.items.filter((item) => item && item.enabled !== false && item.fileId)
    if (!validItems.length) {
      this.setData({ heroCarouselEnabled: false, heroSlides: [], heroCarouselKey: '', heroCurrent: 0 })
      return
    }

    const carouselKey = validItems.map((item) => [item.id || '', item.fileId, item.posterFileId || '', item.type || 'image', item.title || '', item.subtitle || ''].join(':')).join('|')
    const autoRotate = carousel.autoRotate !== false
    const interval = Number(carousel.rotateIntervalMs) || 5000

    if (this.data.heroCarouselEnabled && this.data.heroCarouselKey === carouselKey && this.data.heroSlides.length) {
      this.setData({
        heroAutoRotate: autoRotate,
        heroRotateInterval: interval,
        heroAutoplay: autoRotate && this.data.heroSlides.length > 1
      })
      return
    }

    const fileIds = []
    validItems.forEach((item) => {
      if (item.fileId) fileIds.push(item.fileId)
      if (item.posterFileId) fileIds.push(item.posterFileId)
    })

    const uniqueIds = Array.from(new Set(fileIds))
    if (!uniqueIds.length) {
      this.setData({ heroCarouselEnabled: false, heroSlides: [], heroCarouselKey: '', heroCurrent: 0 })
      return
    }

    wx.cloud.getTempFileURL({
      fileList: uniqueIds,
      success: (res) => {
        if (requestSeq !== this._heroCarouselRequestSeq) return

        const urlMap = {}
        ;(res.fileList || []).forEach((f) => {
          if (f.fileID && f.tempFileURL) urlMap[f.fileID] = f.tempFileURL
        })

        const slides = validItems.map((item) => ({
          ...item,
          url: urlMap[item.fileId] || '',
          posterUrl: urlMap[item.posterFileId] || urlMap[item.fileId] || ''
        })).filter(item => item.url)

        if (!slides.length) {
          this.setData({ heroCarouselEnabled: false, heroSlides: [], heroCarouselKey: '', heroCurrent: 0 })
          return
        }

        this.setData({
          heroCarouselEnabled: true,
          heroAutoRotate: autoRotate,
          heroRotateInterval: interval,
          heroSlides: slides,
          heroCarouselKey: carouselKey,
          heroCurrent: Math.min(this.data.heroCurrent || 0, slides.length - 1),
          heroAutoplay: autoRotate && slides.length > 1
        })
      },
      fail: () => {
        if (requestSeq !== this._heroCarouselRequestSeq) return
        this.setData({ heroCarouselEnabled: false, heroSlides: [], heroCarouselKey: '', heroCurrent: 0 })
      }
    })
  },

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
  }
})
