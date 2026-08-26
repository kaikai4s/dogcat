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
        order.acceptedNotifyStatusText = order.acceptedNotifyStatus || '未记录'
        order.acceptedNotifyErrorText = order.acceptedNotifyError || '无'
        this.setData({ detail: { ...detail, order }, refunds: refunds || [] })
      })
      .catch(showError)
  },
  callClient() {
    const phone = this.data.detail && this.data.detail.order && this.data.detail.order.clientContact && this.data.detail.order.clientContact.phone
    if (!phone) {
      wx.showToast({ title: '用户电话未绑定', icon: 'none' })
      return
    }
    wx.makePhoneCall({ phoneNumber: phone })
  },
  callStaff() {
    const phone = this.data.detail && this.data.detail.order && this.data.detail.order.staffContact && this.data.detail.order.staffContact.phone
    if (!phone) {
      wx.showToast({ title: '宠托师电话未绑定', icon: 'none' })
      return
    }
    wx.makePhoneCall({ phoneNumber: phone })
  },
  copyOrderNo() {
    const orderNo = this.data.detail && this.data.detail.order && this.data.detail.order.orderNo
    if (!orderNo) return
    wx.setClipboardData({ data: orderNo })
  },
  evidence() { wx.navigateTo({ url: '/pages/admin/evidence/detail/index?id=' + this.data.id }) },
  incidents() { wx.navigateTo({ url: '/pages/admin/incidents/list/index?orderId=' + this.data.id }) },
  ...navMethods()
})
