const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { withOrderText } = require('../../../../utils/format')

Page({
  data: { id: '', detail: null, sectionHomeUrl: '', canGoBack: false },
  onLoad(q) { this.setData({ ...createPageNav(q), id: q.id }); this.load() },
  load() { callFunction('admin', 'getOrderDetail', { id: this.data.id }).then((detail) => this.setData({ detail: { ...detail, order: withOrderText(detail.order) } })).catch(showError) },
  evidence() { wx.navigateTo({ url: '/pages/admin/evidence/detail/index?id=' + this.data.id }) },
  ...navMethods()
})
