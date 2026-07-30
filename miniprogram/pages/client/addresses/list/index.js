const { callFunction, showError } = require('../../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../../utils/nav')

Page({
  data: {
    addresses: [],
    select: false,
    sectionHomeUrl: '',
    canGoBack: false
  },

  onLoad(query) {
    this.setData({ ...createPageNav(query), select: query.select === '1' })
  },

  onShow() {
    this.load()
  },

  load() {
    callFunction('client', 'listAddresses')
      .then((addresses) => this.setData({ addresses }))
      .catch(showError)
  },

  add() {
    wx.navigateTo({ url: '/pages/client/addresses/edit/index' })
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
