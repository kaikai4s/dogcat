const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { withOrderText } = require('../../../../utils/format')
const { applyTheme, getThemeState } = require('../../../../utils/theme')
const { copyText } = require('../../../../utils/clipboard')

Page({
  data: {
    themeClass: 'theme-day',
    id: '',
    order: null,
    customerService: null,
    sectionHomeUrl: '',
    canGoBack: false,
    acceptRisk: null,
    acceptRiskStep: 1,
    acceptRiskAgreed: false,
    acceptingRiskOrder: false
  },
  onLoad(q) { this.setData({ ...createPageNav(q), id: q.id }); this.loadCustomerService() },
  onShow() {
    this.applyCurrentTheme()
    this.load()
  },
  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },
  load() {
    callFunction('order', 'getOrderDetail', { id: this.data.id })
      .then((order) => {
        const displayOrder = withOrderText(order)
        this.setData({ order: displayOrder })
      })
      .catch(showError)
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
    const orderNo = String((this.data.order && this.data.order.orderNo) || '').trim()
    if (!orderNo) {
      wx.showToast({ title: '暂无订单号', icon: 'none' })
      return
    }
    copyText(orderNo, { successTitle: '订单号已复制', emptyTitle: '暂无订单号' })
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
    const orderId = this.data.id
    console.log('【调试】开始接单，订单ID:', orderId)
    callFunction('staff', 'checkAcceptOrderRisk', { orderId })
      .then((risk) => {
        console.log('【调试】风险检测结果:', JSON.stringify(risk, null, 2))
        console.log('【调试】requiresConfirmation:', risk?.requiresConfirmation)
        console.log('【调试】warnings数量:', risk?.warnings?.length)
        if (risk && risk.requiresConfirmation) {
          console.log('【调试】检测到风险，显示弹窗')
          this.setData({ acceptRisk: risk, acceptRiskStep: 1, acceptRiskAgreed: false })
          return
        }
        console.log('【调试】无风险或未检测到风险，直接接单')
        this.submitAcceptOrder(false)
      })
      .catch((error) => {
        console.error('【调试】风险检测失败:', error)
        showError(error)
      })
  },
  submitAcceptOrder(riskConfirmed) {
    this.setData({ acceptingRiskOrder: true })
    callFunction('staff', 'acceptOrder', { orderId: this.data.id, riskConfirmed: riskConfirmed === true })
      .then(() => {
        wx.showToast({ title: '接单成功' })
        this.closeAcceptRiskModal()
        this.load()
      })
      .catch(showError)
      .finally(() => this.setData({ acceptingRiskOrder: false }))
  },
  continueAcceptRisk() {
    this.setData({ acceptRiskStep: 2, acceptRiskAgreed: false })
  },
  toggleAcceptRiskAgreed() {
    this.setData({ acceptRiskAgreed: !this.data.acceptRiskAgreed })
  },
  confirmRiskAccept() {
    if (!this.data.acceptRiskAgreed) {
      wx.showToast({ title: '请先确认已阅读并会遵守规定', icon: 'none' })
      return
    }
    this.submitAcceptOrder(true)
  },
  closeAcceptRiskModal() {
    this.setData({ acceptRisk: null, acceptRiskStep: 1, acceptRiskAgreed: false })
  },
  service() { wx.navigateTo({ url: '/pages/staff/orders/service/index?id=' + this.data.id }) },
  tracking() { wx.navigateTo({ url: '/pages/client/orders/tracking/index?id=' + this.data.id }) },
  report() { wx.navigateTo({ url: '/pages/client/orders/report/index?id=' + this.data.id }) },
  sos() { wx.navigateTo({ url: '/pages/staff/sos/index?id=' + this.data.id }) },
  openOrderMessages() {
    if (!this.data.id) return
    wx.navigateTo({ url: '/pages/staff/messages/thread/index?orderId=' + this.data.id })
  },
  ...navMethods()
})
