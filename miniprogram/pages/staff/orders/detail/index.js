const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { withOrderText } = require('../../../../utils/format')
const { applyTheme, getThemeState } = require('../../../../utils/theme')

Page({
  data: { themeClass: 'theme-day', id: '', order: null, customerService: null, sectionHomeUrl: '', canGoBack: false },
  onLoad(q) { this.setData({ ...createPageNav(q), id: q.id }); this.loadCustomerService() },
  onShow() {
    this.applyCurrentTheme()
    this.load()
  },
  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },
  load() { callFunction('order', 'getOrderDetail', { id: this.data.id }).then((order) => this.setData({ order: withOrderText(order) })).catch(showError) },
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
    const orderNo = this.data.order && this.data.order.orderNo
    if (!orderNo) return
    wx.setClipboardData({ data: orderNo })
  },
  previewPetPhoto() {
    const photo = this.data.order && this.data.order.petSnapshot && this.data.order.petSnapshot.avatarFileId
    if (photo) {
      wx.previewImage({ urls: [photo] })
    }
  },
  openNavigation() {
    const order = this.data.order || {}
    const latitude = Number(order.addressLatitude)
    const longitude = Number(order.addressLongitude)
    if (!latitude || !longitude) {
      wx.showToast({ title: '订单缺少定位，无法导航', icon: 'none' })
      return
    }
    wx.openLocation({ latitude, longitude, name: order.serviceAddress || '服务地址', address: `${order.addressDetail || ''} ${order.doorplate || ''}`, scale: 16 })
  },
  accept() {
    callFunction('staff', 'acceptOrder', { orderId: this.data.id })
      .then(() => {
        wx.showToast({ title: '接单成功' })
        this.load()
      })
      .catch(showError)
  },
  service() { wx.navigateTo({ url: '/pages/staff/orders/service/index?id=' + this.data.id }) },
  sos() { wx.navigateTo({ url: '/pages/staff/sos/index?id=' + this.data.id }) },
  ...navMethods()
})
