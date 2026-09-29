const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { ensureLogin } = require('../../../../utils/cloud')
const { applyTheme, getThemeState } = require('../../../../utils/theme')
const { normalizeCardStyle, buildCardStyle } = require('../utils/profileCardStyle')
const { HERO_DURATION, buildHeroMotion, buildHeroBodyStyle } = require('../utils/heroMotion')

Page({
  data: {
    themeClass: 'theme-day',
    id: '',
    staffGenderRequirement: 'any',
    sitter: null,
    heroExpanded: false,
    heroLayoutStyle: '',
    heroBodyStyle: '',
    heroCommittedExpanded: false,
    heroMoving: false,
    heroReady: false,
    heroSurfaceStyle: '',
    sectionHomeUrl: '',
    canGoBack: false
  },

  onLoad(query) {
    this.setData({ ...createPageNav(query), id: query.id || query.staffProfileId || '' })
    this.setData({ staffGenderRequirement: ['male', 'female'].includes(query.staffGenderRequirement) ? query.staffGenderRequirement : 'any' })
  },

  onShow() {
    this.applyCurrentTheme()
    this.load()
  },

  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },

  load() {
    if (!this.data.id) return
    callFunction('staff', 'getPublicSitterDetail', { staffProfileId: this.data.id })
      .then((sitter) => {
        if (this._heroDisposed) return
        const card = normalizeCardStyle(sitter)
        // 动画表面不使用 backdrop-filter；磨砂来自下方固定尺寸的图片层。
        const surface = buildCardStyle({ ...card, profileCardBlur: 0 }).replace(/(?:-webkit-)?backdrop-filter:[^;]+;/g, '')
        this.setData({ sitter: { ...sitter, ...card }, profileCardStyle: buildCardStyle(sitter), heroSurfaceStyle: surface }, () => this.measureHeroLayout())
      })
      .catch(showError)
  },

  toggleHeroExpand() {
    if (!this.data.sitter || !this.data.sitter.profileBackgroundFileId) return
    if (!this._heroLayout) return this.measureHeroLayout()
    clearTimeout(this._heroTimer)
    const version = (this._heroMotionVersion || 0) + 1
    this._heroMotionVersion = version
    const expanded = !this.data.heroExpanded
    this.setData({
      heroExpanded: expanded,
      heroMoving: true,
      heroBodyStyle: buildHeroBodyStyle(this._heroLayout, expanded, this.data.heroCommittedExpanded, true)
    }, () => {
      // 从视图更新完成后计时，避免低端手机的通信延迟让占位提前切换。
      if (this._heroDisposed || version !== this._heroMotionVersion) return
      this._heroTimer = setTimeout(() => {
        if (version === this._heroMotionVersion) this.finishHeroMotion()
      }, HERO_DURATION + 40)
    })
  },

  finishHeroMotion() {
    clearTimeout(this._heroTimer)
    this._heroMotionVersion = (this._heroMotionVersion || 0) + 1
    this.setData({
      heroCommittedExpanded: this.data.heroExpanded,
      heroMoving: false,
      heroBodyStyle: buildHeroBodyStyle(this._heroLayout, this.data.heroExpanded, this.data.heroExpanded, false)
    })
  },

  onHide() {
    this.finishHeroMotion()
  },

  onUnload() {
    this._heroDisposed = true
    clearTimeout(this._heroTimer)
  },

  onResize() {
    this.finishHeroMotion()
    this.measureHeroLayout()
  },

  measureHeroLayout() {
    if (!this.data.sitter || !this.data.sitter.profileBackgroundFileId || typeof wx.createSelectorQuery !== 'function') return
    const query = wx.createSelectorQuery().in(this)
    query.select('.hero-copy-normal').boundingClientRect()
    query.select('.hero-copy-compact').boundingClientRect()
    query.selectViewport().fields({ size: true })
    query.exec(([normal, compact, viewport]) => {
      if (this._heroDisposed || !normal || !compact || !viewport || !viewport.width || !viewport.height) return
      this.finishHeroMotion()
      this._heroLayout = buildHeroMotion(viewport.width, viewport.height, normal.height, compact.height)
      this.setData({ heroLayoutStyle: this._heroLayout.style, heroReady: true })
    })
  },

  toggleFavorite() {
    const sitter = this.data.sitter
    if (!sitter) return
    ensureLogin({ content: '登录后可收藏宠托师。' })
      .then(() => {
        const action = sitter.favorite ? 'unfavoriteSitter' : 'favoriteSitter'
        return callFunction('staff', action, { staffProfileId: sitter._id })
      })
      .then((res) => {
        this.setData({ ['sitter.favorite']: res.favorite })
        wx.showToast({ title: res.favorite ? '已收藏' : '已取消' })
      })
      .catch((error) => {
        if (error && error.code === 'LOGIN_CANCELLED') return
        showError(error)
      })
  },

  book() {
    if (!this.data.id) return
    if (this.data.sitter && this.data.sitter.acceptDirectOrders === false) {
      wx.showToast({ title: '该宠托师当前暂不接受指定预约，可发布公共抢单', icon: 'none', duration: 2500 })
      return
    }
    ensureLogin({ content: '登录后可预约宠托师。' })
      .then(() => wx.navigateTo({ url: `/pages/client/orders/create/index?publishMode=direct&staffProfileId=${this.data.id}&staffGenderRequirement=${this.data.staffGenderRequirement}` }))
      .catch(() => {})
  },

  goList() {
    wx.redirectTo({ url: '/pages/client/sitters/list/index?staffGenderRequirement=' + this.data.staffGenderRequirement })
  },

  ...navMethods()
})
