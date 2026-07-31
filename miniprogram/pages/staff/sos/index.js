const { callFunction, showError } = require('../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../utils/nav')
const { requireSelectedLocation } = require('../../../utils/cloud')

Page({
  data: { orderId: '', description: '', sectionHomeUrl: '', canGoBack: false },
  onLoad(q) { this.setData({ ...createPageNav(q), orderId: q.id }) },
  input(e) { this.setData({ description: e.detail.value }) },
  submit() { requireSelectedLocation().then((loc) => { callFunction('incident', 'createSosIncident', { orderId: this.data.orderId, description: this.data.description, latitude: loc.latitude, longitude: loc.longitude }).then(() => wx.showToast({ title: '已上报' })).catch(showError) }).catch(showError) },
  ...navMethods()
})
