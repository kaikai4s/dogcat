const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { ensureLogin } = require('../../../../utils/cloud')
const { applyTheme, getThemeState } = require('../../../../utils/theme')

function pageList(result) {
  return Array.isArray(result) ? { list: result, hasMore: false, page: 1, total: result.length } : (result || { list: [], hasMore: false, page: 1, total: 0 })
}

Page({
  data: {
    themeClass: 'theme-day',
    sitters: [],
    keyword: '',
    page: 1,
    pageSize: 10,
    hasMore: true,
    total: 0,
    loading: false,
    sectionHomeUrl: '',
    canGoBack: false
  },

  onLoad(query) {
    this.setData(createPageNav(query))
  },

  onShow() {
    this.applyCurrentTheme()
    ensureLogin({ content: '登录后可查看关注的宠托师。' })
      .then(() => this.load({ reset: true }))
      .catch(() => wx.redirectTo({ url: '/pages/client/sitters/list/index' }))
  },

  onReachBottom() {
    this.loadMore()
  },

  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },

  load(options = {}) {
    if (this.data.loading) return
    const reset = options.reset === true
    const page = reset ? 1 : this.data.page
    this.setData({ loading: true })
    callFunction('staff', 'listFavoriteSitters', { keyword: this.data.keyword, page, pageSize: this.data.pageSize })
      .then((result) => {
        const pageData = pageList(result)
        this.setData({
          sitters: reset ? pageData.list : this.data.sitters.concat(pageData.list),
          page: pageData.page,
          hasMore: pageData.hasMore,
          total: pageData.total,
          loading: false
        })
      })
      .catch((error) => {
        this.setData({ loading: false })
        showError(error)
      })
  },

  loadMore() {
    if (!this.data.hasMore || this.data.loading) return
    this.setData({ page: this.data.page + 1 }, () => this.load())
  },

  inputKeyword(e) {
    this.setData({ keyword: e.detail.value })
  },

  submitSearch() {
    this.setData({ page: 1, hasMore: true }, () => this.load({ reset: true }))
  },

  clearSearch() {
    this.setData({ keyword: '', page: 1, hasMore: true }, () => this.load({ reset: true }))
  },

  detail(e) {
    wx.navigateTo({ url: '/pages/client/sitters/detail/index?id=' + e.currentTarget.dataset.id + '&from=favorites' })
  },

  book(e) {
    wx.navigateTo({ url: `/pages/client/orders/create/index?publishMode=direct&staffProfileId=${e.currentTarget.dataset.id}` })
  },

  goList() {
    wx.redirectTo({ url: '/pages/client/sitters/list/index' })
  },

  unfavorite(e) {
    callFunction('staff', 'unfavoriteSitter', { staffProfileId: e.currentTarget.dataset.id })
      .then(() => {
        wx.showToast({ title: '已取消' })
        this.load({ reset: true })
      })
      .catch(showError)
  },

  ...navMethods()
})
