const { callFunction, showError, requestSubscribeTemplates } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { ensureLogin } = require('../../../../utils/cloud')
const { withOrderText } = require('../../../../utils/format')

function getRefundText(order = {}) {
  if (!order.refundStatus || order.refundStatus === 'not_required') return ''
  if (order.refundStatus === 'processing') return `退款处理中 ¥${order.refundAmount || 0}`
  if (order.refundStatus === 'success') return `已退款 ¥${order.refundAmount || 0}`
  if (order.refundStatus === 'failed') return '退款失败，请联系平台'
  return '退款待处理'
}

Page({
  data: { id: '', order: null, timeline: [], review: null, paying: false, sectionHomeUrl: '', canGoBack: false },
  onLoad(q) { this.setData({ ...createPageNav(q), id: q.id }) },
  onShow() {
    ensureLogin({ content: '登录后可查看订单详情。' })
      .then(() => this.load())
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
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
    requestSubscribeTemplates(['orderPaid', 'orderAssigned', 'refundResult'], 'client_pay')
      .then(() => callFunction('payment', 'createPayment', { orderId: this.data.id }))
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
      .then(() => {
        wx.showToast({ title: '已支付' })
        this.setData({ paying: false })
        this.load()
      })
      .catch((error) => {
        this.setData({ paying: false })
        const message = error && error.errMsg && error.errMsg.includes('cancel') ? '已取消支付' : ''
        if (message) wx.showToast({ title: message, icon: 'none' })
        else showError(error)
      })
  },
  tracking() { wx.navigateTo({ url: '/pages/client/orders/tracking/index?id=' + this.data.id }) },
  report() { wx.navigateTo({ url: '/pages/client/orders/report/index?id=' + this.data.id }) },
  rebook() { wx.navigateTo({ url: '/pages/client/orders/create/index?rebookOrderId=' + this.data.id }) },
  reviewOrder() { wx.navigateTo({ url: '/pages/client/orders/review/index?id=' + this.data.id }) },
  createIncident() { wx.navigateTo({ url: '/pages/client/incidents/create/index?id=' + this.data.id }) },
  cancelOrder() {
    callFunction('order', 'getCancelQuote', { orderId: this.data.id })
      .then((quote) => {
        if (!quote.canCancel) {
          wx.showToast({ title: quote.ruleText, icon: 'none' })
          return
        }
        wx.showModal({
          title: '取消订单',
          content: `${quote.ruleText}，预计退款 ¥${quote.refundAmount}。确认取消吗？`,
          success: (res) => {
            if (!res.confirm) return
            callFunction('order', 'cancelOrder', { orderId: this.data.id, reason: '宠物主取消' })
              .then(() => {
                wx.showToast({ title: '已取消' })
                this.load()
              })
              .catch(showError)
          }
        })
      })
      .catch(showError)
  },

  ...navMethods()
})
