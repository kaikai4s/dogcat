const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { ensureLogin } = require('../../../../utils/cloud')

Page({
  data: {
    sitters: [],
    loading: false,
    sectionHomeUrl: '',
    canGoBack: false
  },

  onLoad(query) {
    this.setData(createPageNav(query))
  },

  onShow() {
    ensureLogin({ content: '登录后可查看关注的宠托师。' })
      .then(() => this.load())
      .catch(() => wx.redirectTo({ url: '/pages/client/sitters/list/index' }))
  },

  load() {
    this.setData({ loading: true })
    callFunction('staff', 'listFavoriteSitters')
      .then((sitters) => this.setData({ sitters, loading: false }))
      .catch((error) => {
        this.setData({ loading: false })
        showError(error)
      })
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
        this.load()
      })
      .catch(showError)
  },

  ...navMethods()
})
