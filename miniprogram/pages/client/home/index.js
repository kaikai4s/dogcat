const { getSelectedLocation, chooseSelectedLocation, callFunction, showError } = require('../../../utils/cloud')
const { ensureLogin } = require('../../../utils/cloud')

Page({
  data: {
    locationName: '选择位置',
    locationTip: '点击选择当前位置或常用地址',
    latitude: 0,
    longitude: 0,
    lotteryActivity: null,
    statsData: {
      catCount: '14,720',
      dogCount: '5,373',
      ratingCount: '13,020'
    },
    topSitter: {
      name: '小眠',
      distance: '14.64km',
      rating: '5.0',
      orderCount: 215,
      avatar: '/images/sitter-avatar-default.jpg',
      bio: '点击主页即可下单 欢迎提前预约',
      tags: ['有责任心', '超级耐心', '超爱小动物']
    },

    // 轮播 hero 相关状态
    heroCarouselEnabled: false,
    heroAutoRotate: true,
    heroRotateInterval: 5000,
    heroSlides: [],
    heroCurrent: 0,
    heroAutoplay: true,
    heroPlayingVideoId: null,
    heroPausedByVideo: false
  },

  onShow() {
    this.applySavedLocation()
    this.loadLottery()
    this.loadHeroCarousel()
  },

  onHide() {
    this.stopAllVideos()
  },

  onUnload() {
    this.stopAllVideos()
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

  loadLottery() {
    // 不要求登录，公开接口
    callFunction('lottery', 'getActiveActivity')
      .then((activity) => this.setData({ lotteryActivity: activity }))
      .catch(() => {})
  },

  loadHeroCarousel() {
    callFunction('system', 'getSettings')
      .then((settings) => {
        const carousel = settings.homeHeroCarousel || {}
        if (!carousel.enabled || !Array.isArray(carousel.items) || !carousel.items.length) {
          this.setData({ heroCarouselEnabled: false, heroSlides: [] })
          return
        }

        const validItems = carousel.items.filter((item) => item && item.enabled !== false && item.fileId)
        if (!validItems.length) {
          this.setData({ heroCarouselEnabled: false, heroSlides: [] })
          return
        }

        const fileIds = []
        validItems.forEach((item) => {
          if (item.fileId) fileIds.push(item.fileId)
          if (item.posterFileId) fileIds.push(item.posterFileId)
        })

        const uniqueIds = Array.from(new Set(fileIds))
        if (!uniqueIds.length) {
          this.setData({ heroCarouselEnabled: false, heroSlides: [] })
          return
        }

        wx.cloud.getTempFileURL({
          fileList: uniqueIds,
          success: (res) => {
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
              this.setData({ heroCarouselEnabled: false, heroSlides: [] })
              return
            }

            const autoRotate = carousel.autoRotate !== false
            const interval = Number(carousel.rotateIntervalMs) || 5000

            this.setData({
              heroCarouselEnabled: true,
              heroAutoRotate: autoRotate,
              heroRotateInterval: interval,
              heroSlides: slides,
              heroCurrent: 0,
              heroAutoplay: autoRotate && slides.length > 1
            })
          },
          fail: () => {
            this.setData({ heroCarouselEnabled: false, heroSlides: [] })
          }
        })
      })
      .catch(() => {
        this.setData({ heroCarouselEnabled: false, heroSlides: [] })
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
