const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { withOrderText, withCheckinText } = require('../../../../utils/format')

Page({
  data: { id: '', report: null, sectionHomeUrl: '', canGoBack: false },
  onLoad(q) {
    this.setData({ ...createPageNav(q), id: q.id })
    callFunction('order', 'getServiceReport', { id: q.id })
      .then((report) => this.setData({ report: { ...report, order: withOrderText(report.order), checkins: (report.checkins || []).map(withCheckinText) } }))
      .catch(showError)
  },
  ...navMethods()
})
