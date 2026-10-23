const { callFunction, showError, ensureLogin, requestSubscribeTemplates, loadSystemSettings, showLoading, hideLoading } = require('../../../../../utils/cloud')
const { createClientRequestId } = require('../../../../../utils/offlineQueue')
const { copyText } = require('../../../../../utils/clipboard')

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isPaidResult(result) {
  return Boolean(result && (result.paid || result.paymentStatus === 'paid' || result.status === 'paid' || result.status === 'pending_ship'))
}

const refundStatusTextMap = {
  none: '',
  applied: '售后申请中',
  approved: '已同意退款',
  rejected: '售后已驳回',
  refunded: '已退款',
  processing: '退款处理中',
  full_refunded: '已全额退款',
  partially_refunded: '已部分退款/赔付',
  return_pending_ship: '待买家寄回商品',
  return_shipped: '已寄出待商家验货',
  pending_manual: '待人工审核'
}

Page({
  data: {
    id: '',
    order: null,
    paying: false,
    refunding: false,
    refundReason: '',
    afterSaleType: 'refund_only',
    requestedAmount: '',
    showReturnModal: false,
    returnExpressCompany: '',
    returnTrackingNo: '',
    logisticsInfo: null,
    logisticsMessage: '',
    loadingLogistics: false,
    refreshingLogistics: false
  },

  onLoad(query) { this.setData({ id: query.id || query.orderId || '' }) },
  onPullDownRefresh() {
    Promise.resolve(this.load()).finally(() => wx.stopPullDownRefresh())
  },

  onShow() {
    loadSystemSettings().catch(() => null)
    ensureLogin({ content: '登录后可查看商城订单。' })
      .then(() => this.load())
      .catch(() => wx.navigateBack())
  },

  load() {
    if (!this.data.id) return
    callFunction('mall', 'getOrderDetail', { orderId: this.data.id })
      .then((order) => {
        if (order) {
          const refundStatus = String(order.refundStatus || '').toLowerCase()
          order.refundStatusText = refundStatusTextMap[refundStatus] || (refundStatus && refundStatus !== 'none' ? '售后处理中' : '')
        }
        this.setData({ order })
        if (order && order.trackingNo) {
          this.queryLogistics()
        }
      })
      .catch(showError)
  },

  queryLogistics() {
    if (!this.data.id || this.data.loadingLogistics) return
    this.setData({ loadingLogistics: true, logisticsMessage: '' })
    callFunction('mall', 'queryOrderLogistics', { orderId: this.data.id })
      .then((res) => {
        const isDelivered = res && res.orderStatusUpdated === 'completed'
        const updatePayload = {
          logisticsInfo: res && res.hasLogistics ? res : null,
          logisticsMessage: res && res.message || '',
          loadingLogistics: false,
          refreshingLogistics: false
        }
        if (isDelivered && this.data.order && this.data.order.status === 'shipped') {
          updatePayload['order.status'] = 'completed'
          updatePayload['order.statusText'] = '已完成'
        }
        this.setData(updatePayload)
      })
      .catch(() => {
        this.setData({ logisticsMessage: '物流查询暂不可用，请稍后重试', loadingLogistics: false, refreshingLogistics: false })
      })
  },

  refreshLogistics() {
    this.setData({ refreshingLogistics: true })
    this.queryLogistics()
  },

  callExpressTel() {
    const tel = this.data.logisticsInfo && this.data.logisticsInfo.companyTel
    if (tel) {
      wx.makePhoneCall({ phoneNumber: tel }).catch(() => null)
    }
  },

  syncPaymentStatusWithRetry(orderId) {
    const delays = [0, 800, 1600, 2500]
    let lastResult = null
    const run = (index) => {
      const delay = delays[index] || 0
      return wait(delay)
        .then(() => {
          if (index > 0) showLoading({ title: '正在确认支付结果...', mask: true })
          return callFunction('payment', 'getPaymentStatus', { orderId })
        })
        .then((result) => {
          lastResult = result
          if (isPaidResult(result) || index >= delays.length - 1) return result
          return run(index + 1)
        })
        .catch((error) => {
          if (index >= delays.length - 1) throw error
          lastResult = lastResult || { paymentStatus: 'paying' }
          return run(index + 1)
        })
    }
    return run(0)
  },

  pay() {
    if (this._payingLock || this.data.paying) return
    this._payingLock = true
    this.setData({ paying: true })
    showLoading({ title: '准备支付中...', mask: true })
    return requestSubscribeTemplates(['refundResult'], 'mall_pay').catch(() => null)
      .then(() => callFunction('payment', 'createPayment', { orderId: this.data.id, clientRequestId: createClientRequestId('mall_pay') }))
      .then((payment) => {
        if (payment.paid) return payment
        if (payment.mock) {
          return callFunction('payment', 'mockPayOrder', { orderId: this.data.id, paymentNo: payment.paymentNo })
            .then(() => this.syncPaymentStatusWithRetry(this.data.id))
        }
        if (!payment.payParams) throw new Error(payment.message || '微信支付参数未配置')
        hideLoading()
        return new Promise((resolve, reject) => wx.requestPayment({ ...payment.payParams, success: resolve, fail: reject }))
          .then(() => {
            showLoading({ title: '正在同步支付结果...', mask: true })
            return this.syncPaymentStatusWithRetry(this.data.id)
          })
      })
      .then((result) => {
        hideLoading()
        this._payingLock = false
        const paid = isPaidResult(result)
        wx.showToast({ title: paid ? '已支付' : '支付处理中，请稍后刷新', icon: paid ? 'success' : 'none' })
        this.setData({ paying: false })
        this.load()
      })
      .catch((error) => {
        hideLoading()
        this._payingLock = false
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
  inputRequestedAmount(e) { this.setData({ requestedAmount: e.detail.value }) },
  setAfterSaleType(e) {
    const type = e.currentTarget.dataset.type
    this.setData({ afterSaleType: type })
  },
  showRefund() {
    this.setData({
      refunding: true,
      refundReason: '',
      afterSaleType: 'refund_only',
      requestedAmount: this.data.order ? this.data.order.payAmount : ''
    })
  },
  hideRefund() { this.setData({ refunding: false }) },

  submitRefund() {
    if (!this.data.refundReason.trim()) {
      wx.showToast({ title: '请填写售后原因', icon: 'none' })
      return
    }
    const payload = {
      orderId: this.data.id,
      reason: this.data.refundReason.trim(),
      afterSaleType: this.data.afterSaleType,
      requestedAmount: this.data.afterSaleType === 'compensation' ? Number(this.data.requestedAmount || 0) : undefined
    }
    requestSubscribeTemplates(['refundResult'], 'mall_refund').catch(() => null)
      .then(() => callFunction('mall', 'applyRefund', payload))
      .then(() => {
        wx.showToast({ title: '已提交申请' })
        this.setData({ refunding: false })
        this.load()
      })
      .catch(showError)
  },

  openReturnModal() {
    this.setData({ showReturnModal: true, returnExpressCompany: '', returnTrackingNo: '' })
  },
  closeReturnModal() { this.setData({ showReturnModal: false }) },
  inputReturnField(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value })
  },
  copyReturnAddress() {
    const addr = this.data.order && this.data.order.returnAddress
    if (addr) {
      const text = `${addr.receiver} ${addr.phone} ${addr.address}`
      copyText(text, { successTitle: '退货地址已复制' })
    }
  },
  submitReturnLogistics() {
    const { returnExpressCompany, returnTrackingNo } = this.data
    if (!returnExpressCompany.trim()) return wx.showToast({ title: '请填写快递公司', icon: 'none' })
    if (!returnTrackingNo.trim()) return wx.showToast({ title: '请填写退货单号', icon: 'none' })
    callFunction('mall', 'fillReturnLogistics', {
      orderId: this.data.id,
      expressCompany: returnExpressCompany.trim(),
      trackingNo: returnTrackingNo.trim()
    })
      .then(() => {
        wx.showToast({ title: '退货单号已提交' })
        this.setData({ showReturnModal: false })
        this.load()
      })
      .catch(showError)
  }
})
