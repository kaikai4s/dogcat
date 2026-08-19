const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { ensureLogin } = require('../../../../utils/cloud')
const { withOrderText, withCheckinText } = require('../../../../utils/format')
const { applyTheme, getThemeState } = require('../../../../utils/theme')

Page({
  data: { themeClass: 'theme-day', id: '', report: null, sectionHomeUrl: '', canGoBack: false },
  onLoad(q) {
    this.setData({ ...createPageNav(q), id: q.id })
  },
  onShow() {
    this.applyCurrentTheme()
    ensureLogin({ content: '登录后可查看服务报告。' })
      .then(() => this.load())
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },
  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },
  load() {
    callFunction('order', 'getServiceReport', { id: this.data.id })
      .then((report) => this.setData({ report: { ...report, order: withOrderText(report.order), checkins: (report.checkins || []).map(withCheckinText) } }))
      .catch(showError)
  },
  goTracking() {
    wx.navigateTo({ url: `/pages/client/orders/tracking/index?id=${this.data.id}` })
  },

  generateAiReport() {
    if (!this.data.id || this.data.loadingAi) return
    this.setData({ loadingAi: true })
    callFunction('ai', 'aiGenerateReport', { orderId: this.data.id })
      .then((res) => {
        this.setData({ aiSummary: res.reportSummary, loadingAi: false })
      })
      .catch((err) => {
        this.setData({ loadingAi: false })
        showError(err)
      })
  },
  ...navMethods()
})
