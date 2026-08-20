const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { ensureLogin } = require('../../../../utils/cloud')

function pageList(result) {
  return Array.isArray(result) ? { list: result, hasMore: false, page: 1, total: result.length } : (result || { list: [], hasMore: false, page: 1, total: 0 })
}

Page({
  data: {
    addresses: [],
    select: false,
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
    this.setData({ ...createPageNav(query), select: query.select === '1' })
  },

  onShow() {
    ensureLogin({ content: '登录后可管理常用地址。' })
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
    this.setData({ loading: true })
    callFunction('client', 'listAddresses', { keyword: this.data.keyword, page, pageSize: this.data.pageSize })
      .then((result) => {
        const pageData = pageList(result)
        this.setData({
          addresses: reset ? pageData.list : this.data.addresses.concat(pageData.list),
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

  add() {
    wx.navigateTo({
      url: '/pages/client/addresses/edit/index',
      fail: (error) => wx.showModal({ title: '无法打开新增地址', content: error.errMsg || '请重新编译小程序后再试', showCancel: false })
    })
  },

  edit(e) {
    wx.navigateTo({ url: '/pages/client/addresses/edit/index?id=' + e.currentTarget.dataset.id })
  },

  choose(e) {
    if (!this.data.select) return
    const address = this.data.addresses.find((item) => item._id === e.currentTarget.dataset.id)
    if (!address) return
    const pages = getCurrentPages()
    const prev = pages[pages.length - 2]
    if (prev && prev.applyAddress) prev.applyAddress(address)
    wx.navigateBack()
  },

  setDefault(e) {
    callFunction('client', 'setDefaultAddress', { id: e.currentTarget.dataset.id })
      .then(() => {
        wx.showToast({ title: '已设默认' })
        this.load({ reset: true })
      })
      .catch(showError)
  },

  remove(e) {
    wx.showModal({
      title: '删除地址',
      content: '确认删除这个常用地址吗？',
      success: (res) => {
        if (!res.confirm) return
        callFunction('client', 'deleteAddress', { id: e.currentTarget.dataset.id })
          .then(() => {
            wx.showToast({ title: '已删除' })
            this.load({ reset: true })
          })
          .catch(showError)
      }
    })
  },

  ...navMethods()
})
