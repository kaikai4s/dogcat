const { callFunction, showError, ensureLogin, requestSubscribeTemplates } = require('../../../../../utils/cloud')
const { createClientRequestId } = require('../../../../../utils/offlineQueue')
const { copyText } = require('../../../../../utils/clipboard')

Page({
  data: { id: '', order: null, paying: false, refunding: false, refundReason: '' },

  onLoad(query) { this.setData({ id: query.id || query.orderId || '' }) },
  onShow() {
    ensureLogin({ content: '登录后可查看商城订单。' })
      .then(() => this.load())
      .catch(() => wx.navigateBack())
  },

  load() {
    if (!this.data.id) return
    callFunction('mall', 'getOrderDetail', { orderId: this.data.id })
      .then((order) => this.setData({ order }))
      .catch(showError)
  },

  pay() {
    if (this.data.paying) return
    this.setData({ paying: true })
    callFunction('payment', 'createPayment', { orderId: this.data.id, clientRequestId: createClientRequestId('mall_pay') })
      .then((payment) => {
        if (payment.paid) return payment
        if (payment.mock) return callFunction('payment', 'mockPayOrder', { orderId: this.data.id, paymentNo: payment.paymentNo })
        if (!payment.payParams) throw new Error(payment.message || '微信支付参数未配置')
        return new Promise((resolve, reject) => wx.requestPayment({ ...payment.payParams, success: resolve, fail: reject }))
      })
      .then(() => {
        wx.showToast({ title: '已支付' })
        this.setData({ paying: false })
        this.load()
      })
      .catch((error) => {
        this.setData({ paying: false })
        const msg = error && (error.errMsg || error.message) || ''
        if (msg.includes('cancel')) wx.showToast({ title: '已取消支付', icon: 'none' })
        else showError(error)
      })
  },

  cancelOrder() {
    wx.showModal({
      title: '取消订单',
      content: '确认取消这个未支付订单吗？',
      success: (res) => {
        if (!res.confirm) return
        callFunction('mall', 'cancelOrder', { orderId: this.data.id })
          .then(() => {
            wx.showToast({ title: '已取消' })
            this.load()
          })
          .catch(showError)
      }
    })
  },

  confirmReceipt() {
    wx.showModal({
      title: '确认收货',
      content: '确认已收到商品吗？',
      success: (res) => {
        if (!res.confirm) return
        callFunction('mall', 'confirmReceipt', { orderId: this.data.id })
          .then(() => {
            wx.showToast({ title: '已确认' })
            this.load()
          })
          .catch(showError)
      }
    })
  },

  copyTracking() {
    const no = this.data.order && this.data.order.trackingNo
    copyText(no, { successTitle: '物流单号已复制', emptyTitle: '暂无物流单号' })
  },

  inputRefundReason(e) { this.setData({ refundReason: e.detail.value }) },
  showRefund() { this.setData({ refunding: true, refundReason: '' }) },
  hideRefund() { this.setData({ refunding: false }) },

  submitRefund() {
    if (!this.data.refundReason.trim()) {
      wx.showToast({ title: '请填写售后原因', icon: 'none' })
      return
    }
    requestSubscribeTemplates(['refundResult'], 'mall_refund').catch(() => null)
      .then(() => callFunction('mall', 'applyRefund', { orderId: this.data.id, reason: this.data.refundReason.trim() }))
      .then(() => {
        wx.showToast({ title: '已提交' })
        this.setData({ refunding: false })
        this.load()
      })
      .catch(showError)
  }
})
