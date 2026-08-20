const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { ensureLogin } = require('../../../../utils/cloud')

const tabs = [
  { label: '全部', value: '' },
  { label: '狗狗', value: 'dog' },
  { label: '猫咪', value: 'cat' },
  { label: '其他', value: 'other' }
]

function pageList(result) {
  return Array.isArray(result) ? { list: result, hasMore: false, page: 1, total: result.length } : (result || { list: [], hasMore: false, page: 1, total: 0 })
}

Page({
  data: {
    tabs,
    activeSpecies: '',
    keyword: '',
    pets: [],
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
    ensureLogin({ content: '登录后可管理宠物档案。' })
      .then(() => this.load({ reset: true }))
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },

  onReachBottom() {
    this.loadMore()
  },

  load(options = {}) {
    if (this.data.loading) return
    const reset = options.reset === true
    const page = reset ? 1 : this.data.page
    const params = { keyword: this.data.keyword, page, pageSize: this.data.pageSize }
    if (this.data.activeSpecies) params.species = this.data.activeSpecies
    this.setData({ loading: true })
    callFunction('pet', 'listPets', params)
      .then((result) => {
        const pageData = pageList(result)
        this.setData({
          pets: reset ? pageData.list : this.data.pets.concat(pageData.list),
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

  chooseSpecies(e) {
    this.setData({ activeSpecies: e.currentTarget.dataset.species || '', page: 1, hasMore: true }, () => this.load({ reset: true }))
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

  create() {
    wx.navigateTo({ url: '/pages/client/pets/edit/index' })
  },

  edit(e) {
    wx.navigateTo({ url: '/pages/client/pets/edit/index?id=' + e.currentTarget.dataset.id })
  },

  ...navMethods()
})
