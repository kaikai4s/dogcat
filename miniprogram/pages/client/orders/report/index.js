const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { ensureLogin } = require('../../../../utils/cloud')
const { withOrderText, withCheckinText } = require('../../../../utils/format')
const { applyTheme, getThemeState } = require('../../../../utils/theme')

function groupCheckinPhotos(checkins = []) {
  const map = {}
  checkins.filter((item) => item.mediaFileId).forEach((item) => {
    const eventType = item.eventType || ''
    if (!map[eventType]) map[eventType] = { eventType, eventTypeText: item.eventTypeText || eventType, count: 0, photos: [], remarks: [], remarkText: '' }
    map[eventType].count += 1
    map[eventType].photos.push(item)
    if (item.remark && !map[eventType].remarks.includes(item.remark)) map[eventType].remarks.push(item.remark)
    map[eventType].remarkText = map[eventType].remarks.join('；')
  })
  return Object.values(map)
}

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
      .then((report) => {
        const checkins = (report.checkins || []).map(withCheckinText)
        this.setData({ report: { ...report, order: withOrderText(report.order), checkins, checkinGroups: groupCheckinPhotos(checkins) } })
      })
      .catch(showError)
  },
  previewPhoto(e) {
    const current = e.currentTarget.dataset.url
    const urls = (this.data.report && this.data.report.checkins || []).map((item) => item.mediaFileId).filter(Boolean)
    if (current && urls.length) wx.previewImage({ current, urls })
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
