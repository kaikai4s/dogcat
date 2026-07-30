const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')

Page({
  data: { id: '', evidence: null, sectionHomeUrl: '', canGoBack: false },
  onLoad(q) { this.setData({ ...createPageNav(q), id: q.id }); callFunction('admin', 'getEvidence', { orderId: q.id }).then((evidence) => this.setData({ evidence })).catch(showError) },
  ...navMethods()
})
