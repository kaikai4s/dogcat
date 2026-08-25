const { callFunction, showError } = require('../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../utils/nav')
const { requireSelectedLocation } = require('../../../utils/cloud')
const { createClientRequestId } = require('../../../utils/offlineQueue')
const { applyTheme, getThemeState } = require('../../../utils/theme')

Page({
  data: { themeClass: 'theme-day', orderId: '', order: null, customerService: null, description: '', submitting: false, sectionHomeUrl: '', canGoBack: false },
  onLoad(q) {
    this.applyCurrentTheme()
    this.setData({ ...createPageNav(q), orderId: q.id })
    this.loadOrder()
    this.loadCustomerService()
  },
  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },
  input(e) { this.setData({ description: e.detail.value }) },
  loadOrder() {
    if (!this.data.orderId) return
    callFunction('order', 'getOrderDetail', { id: this.data.orderId })
      .then((order) => this.setData({ order }))
      .catch(() => {})
  },
  loadCustomerService() {
    callFunction('system', 'getCustomerServiceInfo')
      .then((customerService) => this.setData({ customerService }))
      .catch(() => {})
  },
  callCustomerService() {
    const phone = this.data.customerService && this.data.customerService.phone
    if (!phone) {
      wx.showToast({ title: '暂未配置客服电话', icon: 'none' })
      return
    }
    wx.makePhoneCall({ phoneNumber: phone })
  },
  copyOrderNo() {
    const orderNo = (this.data.order && this.data.order.orderNo) || this.data.orderId
    if (!orderNo) return
    wx.setClipboardData({ data: orderNo })
  },
  submit() {
    if (this.data.submitting) return
    this.setData({ submitting: true })
    requireSelectedLocation()
      .then((loc) => callFunction('incident', 'createSosIncident', {
        orderId: this.data.orderId,
        description: this.data.description,
        latitude: loc.latitude,
        longitude: loc.longitude,
        clientRequestId: createClientRequestId('sos')
      }))
      .then((incident) => {
        wx.showToast({ title: '已上报' })
        this.setData({ submitting: false })
        wx.redirectTo({ url: `/pages/staff/incidents/detail/index?id=${incident._id}` })
      })
      .catch((error) => {
        this.setData({ submitting: false })
        showError(error)
      })
  },
  ...navMethods()
})
