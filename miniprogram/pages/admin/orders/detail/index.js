const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { withOrderText } = require('../../../../utils/format')

Page({
  data: { id: '', detail: null, paymentStatus: null, refunds: [], sectionHomeUrl: '', canGoBack: false },
  onLoad(q) { this.setData({ ...createPageNav(q), id: q.id }); this.load() },
  load() {
    Promise.all([
      callFunction('admin', 'getOrderDetail', { id: this.data.id }),
      callFunction('payment', 'listRefunds', { orderId: this.data.id })
    ])
      .then(([detail, refunds]) => {
        const order = withOrderText(detail.order)
        this.setData({ detail: { ...detail, order }, refunds: refunds || [] })
      })
      .catch(showError)
  },
  evidence() { wx.navigateTo({ url: '/pages/admin/evidence/detail/index?id=' + this.data.id }) },
  incidents() { wx.navigateTo({ url: '/pages/admin/incidents/list/index?orderId=' + this.data.id }) },
  ...navMethods()
})
