const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { ensureLogin } = require('../../../../utils/cloud')
const { applyTheme, getThemeState } = require('../../../../utils/theme')

Page({
  data: {
    themeClass: 'theme-day',
    id: '',
    staffGenderRequirement: 'any',
    sitter: null,
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
      .then((sitter) => this.setData({ sitter }))
      .catch(showError)
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
