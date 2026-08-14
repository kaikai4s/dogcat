const { callFunction, showError, ensureLogin } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { withIncidentText } = require('../../../../utils/format')

Page({
  data: {
    incidents: [],
    loading: false,
    sectionHomeUrl: '',
    canGoBack: false
  },

  onLoad(q) {
    this.setData(createPageNav(q))
  },

  onShow() {
    ensureLogin({ content: '登录后可查看投诉和售后进度。' })
      .then(() => this.load())
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },

  load() {
    this.setData({ loading: true })
    callFunction('incident', 'listMyIncidents', { role: 'client' })
      .then((list) => this.setData({ incidents: (list || []).map(withIncidentText), loading: false }))
      .catch((error) => {
        this.setData({ loading: false })
        showError(error)
      })
  },

  detail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/client/incidents/detail/index?id=${id}` })
  },

  goOrders() {
    wx.navigateTo({ url: '/pages/client/orders/list/index' })
  },

  ...navMethods()
})
