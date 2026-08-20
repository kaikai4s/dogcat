const { callFunction, showError, requestSubscribeTemplates } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { createClientRequestId } = require('../../../../utils/offlineQueue')
const { ensureLogin } = require('../../../../utils/cloud')
const { withOrderText } = require('../../../../utils/format')
const { applyTheme, getThemeState } = require('../../../../utils/theme')

function getRefundText(order = {}) {
  if (!order.refundStatus || order.refundStatus === 'not_required') return ''
  if (order.refundStatus === 'processing') return `退款处理中 ¥${order.refundAmount || 0}`
  if (order.refundStatus === 'success') return `已退款 ¥${order.refundAmount || 0}`
  if (order.refundStatus === 'failed') return '退款失败，请联系平台'
  return '退款待处理'
}

Page({
  data: { themeClass: 'theme-day', id: '', order: null, timeline: [], review: null, paying: false, cancelling: false, handlingEarlyStart: false, sectionHomeUrl: '', canGoBack: false },
  onLoad(q) { this.setData({ ...createPageNav(q), id: q.id }) },
  onShow() {
    this.applyCurrentTheme()
    ensureLogin({ content: '登录后可查看订单详情。' })
      .then(() => this.load())
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },
  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },
  load() {
    Promise.all([
      callFunction('order', 'getOrderDetail', { id: this.data.id }),
      callFunction('order', 'getOrderTimeline', { orderId: this.data.id }),
      callFunction('order', 'getOrderReview', { orderId: this.data.id })
    ])
      .then(([order, timeline, review]) => {
        const displayOrder = withOrderText(order)
        this.setData({ order: { ...displayOrder, refundText: getRefundText(displayOrder) }, timeline, review })
      })
      .catch(showError)
  },
  pay() {
    if (this.data.paying) return
    this.setData({ paying: true })
    const clientRequestId = createClientRequestId('pay')
    requestSubscribeTemplates(['orderPaid', 'orderAssigned', 'refundResult'], 'client_pay')
      .then(() => callFunction('payment', 'createPayment', { orderId: this.data.id, clientRequestId }))
      .then((payment) => {
        if (payment.paid) return payment
        if (payment.mock) {
          return callFunction('payment', 'mockPayOrder', { orderId: this.data.id, paymentNo: payment.paymentNo })
        }
        if (!payment.payParams) throw new Error(payment.message || '微信支付参数未配置')
        return new Promise((resolve, reject) => {
          wx.requestPayment({
            ...payment.payParams,
            success: resolve,
            fail: reject
          })
        }).then(() => callFunction('payment', 'getPaymentStatus', { orderId: this.data.id }))
      })
      .then((result) => {
        const paid = result && (result.paid || result.paymentStatus === 'paid' || result.status === 'paid')
        wx.showToast({ title: paid ? '已支付' : '支付处理中，请稍后刷新订单状态', icon: paid ? 'success' : 'none' })
        this.setData({ paying: false })
        this.load()
      })
      .catch((error) => {
        this.setData({ paying: false })
        const errorMessage = (error && (error.errMsg || error.message)) || ''
        if (errorMessage.includes('cancel')) wx.showToast({ title: '已取消支付', icon: 'none' })
        else if (errorMessage.includes('配置') || errorMessage.includes('未完成')) wx.showToast({ title: '微信支付暂未配置完成', icon: 'none' })
        else if (errorMessage.includes('微信支付下单失败')) wx.showToast({ title: '微信支付下单失败，请稍后重试', icon: 'none' })
        else showError(error)
      })
  },
  tracking() { wx.navigateTo({ url: '/pages/client/orders/tracking/index?id=' + this.data.id }) },
  report() { wx.navigateTo({ url: '/pages/client/orders/report/index?id=' + this.data.id }) },
  rebook() { wx.navigateTo({ url: '/pages/client/orders/create/index?rebookOrderId=' + this.data.id }) },
  reviewOrder() { wx.navigateTo({ url: '/pages/client/orders/review/index?id=' + this.data.id }) },
  createIncident() { wx.navigateTo({ url: '/pages/client/incidents/create/index?id=' + this.data.id }) },
  handleEarlyStart(e) {
    if (this.data.handlingEarlyStart) return
    const approve = e.currentTarget.dataset.action === 'approve'
    this.setData({ handlingEarlyStart: true })
    requestSubscribeTemplates(['serviceStart'], 'client_early_start')
      .then(() => callFunction('order', approve ? 'approveEarlyStart' : 'rejectEarlyStart', { id: this.data.id }))
      .then(() => {
        wx.showToast({ title: approve ? '已同意提前开始' : '已拒绝', icon: 'none' })
        this.setData({ handlingEarlyStart: false })
        this.load()
      })
      .catch((error) => {
        this.setData({ handlingEarlyStart: false })
        showError(error)
      })
  },
  cancelOrder() {
    if (this.data.cancelling) return
    this.setData({ cancelling: true })
    callFunction('order', 'getCancelQuote', { orderId: this.data.id })
      .then((quote) => {
        if (!quote.canCancel) {
          this.setData({ cancelling: false })
          wx.showToast({ title: quote.ruleText, icon: 'none' })
          return
        }
        wx.showModal({
          title: '取消订单',
          content: `${quote.ruleText}，预计退款 ¥${quote.refundAmount}。确认取消吗？`,
          success: (res) => {
            if (!res.confirm) {
              this.setData({ cancelling: false })
              return
            }
            callFunction('order', 'cancelOrder', { orderId: this.data.id, reason: '宠物主取消', clientRequestId: createClientRequestId('cancel') })
              .then(() => {
                wx.showToast({ title: '已取消' })
                this.setData({ cancelling: false })
                this.load()
              })
              .catch((error) => {
                this.setData({ cancelling: false })
                showError(error)
              })
          },
          fail: () => this.setData({ cancelling: false })
        })
      })
      .catch((error) => {
        this.setData({ cancelling: false })
        showError(error)
      })
  },

  ...navMethods()
})
