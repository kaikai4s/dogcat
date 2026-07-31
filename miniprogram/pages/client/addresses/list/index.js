const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { ensureLogin } = require('../../../../utils/cloud')

Page({
  data: {
    addresses: [],
    select: false,
    loading: false,
    sectionHomeUrl: '',
    canGoBack: false
  },

  onLoad(query) {
    this.setData({ ...createPageNav(query), select: query.select === '1' })
  },

  onShow() {
    ensureLogin({ content: '登录后可管理常用地址。' })
      .then(() => this.load())
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },

  load() {
    this.setData({ loading: true })
    callFunction('client', 'listAddresses')
      .then((addresses) => this.setData({ addresses, loading: false }))
      .catch((error) => {
        this.setData({ loading: false })
        showError(error)
      })
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
        this.load()
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
            this.load()
          })
          .catch(showError)
      }
    })
  },

  ...navMethods()
})
