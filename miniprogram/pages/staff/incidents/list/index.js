const { callFunction, showError } = require('../../../../utils/cloud')
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
    this.load()
  },

  load() {
    this.setData({ loading: true })
    callFunction('incident', 'listMyIncidents', { role: 'staff' })
      .then((list) => this.setData({ incidents: (list || []).map(withIncidentText), loading: false }))
      .catch((error) => {
        this.setData({ loading: false })
        showError(error)
      })
  },

  detail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/staff/incidents/detail/index?id=${id}` })
  },

  goOrders() {
    wx.navigateTo({ url: '/pages/staff/orders/list/index' })
  },

  ...navMethods()
})
