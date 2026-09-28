const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { ensureLogin } = require('../../../../utils/cloud')
const { applyTheme, getThemeState } = require('../../../../utils/theme')
const { normalizeCardStyle, buildCardStyle } = require('../utils/profileCardStyle')

Page({
  data: {
    themeClass: 'theme-day',
    id: '',
    staffGenderRequirement: 'any',
    sitter: null,
    heroExpanded: false,
    heroLayoutStyle: '',
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
      .then((sitter) => this.setData({ sitter: { ...sitter, ...normalizeCardStyle(sitter) }, profileCardStyle: buildCardStyle(sitter) }, () => this.measureHeroLayout()))
      .catch(showError)
  },

  toggleHeroExpand() {
    if (!this.data.sitter || !this.data.sitter.profileBackgroundFileId) return
    this.setData({ heroExpanded: !this.data.heroExpanded })
  },

  onResize() {
    this.measureHeroLayout()
  },

  measureHeroLayout() {
    if (!this.data.sitter || !this.data.sitter.profileBackgroundFileId || typeof wx.createSelectorQuery !== 'function') return
    const query = wx.createSelectorQuery().in(this)
    query.select('.sitter-hero').boundingClientRect()
    query.select('.hero-info-panel').boundingClientRect()
    query.selectViewport().fields({ size: true })
    query.exec(([hero, panel, viewport]) => {
      if (!hero || !panel || !viewport || !viewport.width || !viewport.height) return
      const unit = viewport.width / 750
      // 仅在内容加载/屏幕尺寸变化后测量；动画期间不逐帧 setData 或测量布局。
      const collapsed = Math.max(520 * unit, panel.height + 80 * unit)
      const expanded = Math.max(collapsed, viewport.height * 0.92)
      this.setData({ heroLayoutStyle: `--hero-collapsed-height: ${collapsed}px; --hero-expanded-height: ${expanded}px;` })
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
    ensureLogin({ content: '登录后可预约宠托师。' })
      .then(() => wx.navigateTo({ url: `/pages/client/orders/create/index?publishMode=direct&staffProfileId=${this.data.id}&staffGenderRequirement=${this.data.staffGenderRequirement}` }))
      .catch(() => {})
  },

  goList() {
    wx.redirectTo({ url: '/pages/client/sitters/list/index?staffGenderRequirement=' + this.data.staffGenderRequirement })
  },

  ...navMethods()
})
