const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { ensureLogin } = require('../../../../utils/cloud')
const { withOrderText, withCheckinText } = require('../../../../utils/format')

Page({
  data: { id: '', report: null, sectionHomeUrl: '', canGoBack: false },
  onLoad(q) {
    this.setData({ ...createPageNav(q), id: q.id })
  },
  onShow() {
    ensureLogin({ content: '登录后可查看服务报告。' })
      .then(() => this.load())
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },
  load() {
    callFunction('order', 'getServiceReport', { id: this.data.id })
      .then((report) => this.setData({ report: { ...report, order: withOrderText(report.order), checkins: (report.checkins || []).map(withCheckinText) } }))
      .catch(showError)
  },
  ...navMethods()
})
