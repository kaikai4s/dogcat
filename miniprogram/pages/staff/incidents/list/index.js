const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { withIncidentText } = require('../../../../utils/format')
const { applyTheme, getThemeState } = require('../../../../utils/theme')

Page({
  data: {
    themeClass: 'theme-day',
    incidents: [],
    loading: false,
    sectionHomeUrl: '',
    canGoBack: false
  },

  onLoad(q) {
    this.setData(createPageNav(q))
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
