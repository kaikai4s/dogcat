const { callFunction, showError } = require('../../../../utils/cloud')
const { copyText } = require('../../../../utils/clipboard')

const tabs = [
  { label: '全部', value: '' },
  { label: '待付款', value: 'pending_pay' },
  { label: '待发货', value: 'pending_ship' },
  { label: '已发货', value: 'shipped' },
  { label: '售后', value: 'refund_applied' },
  { label: '已退款', value: 'refunded' }
]

const MALL_ORDER_STATUS_OPTIONS = [
  { value: 'pending_pay', label: '待付款' },
  { value: 'pending_ship', label: '待发货' },
  { value: 'shipped', label: '已发货' },
  { value: 'completed', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
  { value: 'refunded', label: '已退款' }
]

const MALL_STATUS_TEXT_MAP = {
  pending_pay: '待付款',
  pending_ship: '待发货',
  shipped: '已发货',
  completed: '已完成',
  cancelled: '已取消',
  refunded: '已退款'
}

function pageList(result) {
  return Array.isArray(result) ? { list: result, hasMore: false, page: 1, total: result.length } : (result || { list: [], hasMore: false, page: 1, total: 0 })
}

function paymentStatusText(status) {
  return ({ unpaid: '未支付', paying: '支付中', paid: '已支付', refunding: '退款中', refunded: '已退款' })[status] || '未支付'
}

function refundStatusText(status) {
  return ({ none: '无售后', applied: '待审核', approved: '已同意', rejected: '已拒绝' })[status] || '无售后'
}

function decorateOrder(order = {}) {
  const goodsCount = (order.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0)
  const firstGoods = (order.items || [])[0]
  const address = order.shippingAddress || {}
  const addressText = [address.serviceAddress, address.addressDetail, address.doorplate].filter(Boolean).join(' ')
  const maxRefundable = order.maxRefundable != null
    ? order.maxRefundable
    : Math.max(0, Math.round(((order.payAmount || 0) - (order.alreadyRefunded || 0)) * 100) / 100)
  return {
    ...order,
    goodsCount,
    goodsSummary: firstGoods ? `${firstGoods.name}${goodsCount > Number(firstGoods.quantity || 0) ? ` 等${goodsCount}件` : ` × ${firstGoods.quantity || 1}`}` : '商城订单',
    statusText: order.statusText || MALL_STATUS_TEXT_MAP[order.status] || order.status || '未知状态',
    paymentStatusText: paymentStatusText(order.paymentStatus),
    refundStatusText: refundStatusText(order.refundStatus),
    statusClass: order.status === 'pending_ship' ? 'warning' : (order.status === 'refunded' ? 'muted-badge' : (order.status === 'refund_applied' ? 'danger-badge' : 'success')),
    refundClass: order.refundStatus === 'applied' ? 'danger-badge' : (order.refundStatus === 'approved' ? 'success' : 'muted-badge'),
    addressText,
    maxRefundable,
    logisticsText: order.expressCompany && order.trackingNo ? `${order.expressCompany} ${order.trackingNo}` : '待录入',
    canShip: order.status === 'pending_ship',
    canAuditRefund: order.refundStatus === 'applied',
    canManualRefund: maxRefundable > 0 && order.paymentStatus === 'paid'
  }
}

function orderStats(orders = []) {
  return {
    pendingShip: orders.filter((item) => item.status === 'pending_ship').length,
    refundApplied: orders.filter((item) => item.refundStatus === 'applied').length,
    shipped: orders.filter((item) => item.status === 'shipped').length
  }
}

Page({
  data: {
    tabs,
    orders: [],
    stats: orderStats(),
    status: '',
    keyword: '',
    page: 1,
    pageSize: 10,
    hasMore: true,
    loading: false,
    shipping: false,
    refunding: false,
    activeOrder: null,
    shipForm: { expressCompany: '', trackingNo: '' },
    refundForm: { approved: true, remark: '', refundAmount: '' },

    // 手动修改状态
    showStatusModal: false,
    statusOptions: MALL_ORDER_STATUS_OPTIONS,
    statusOrder: null,
    statusIndex: 0,
    statusRemark: '',
    submittingStatus: false,

    // 手动退款
    showManualRefundModal: false,
    manualRefundOrder: null,
    manualRefundAmount: '',
    manualRefundReason: '',
    submittingManualRefund: false
  },

  onShow() { this.load({ reset: true }) },
  onReachBottom() { this.loadMore() },

  load(options = {}) {
    if (this.data.loading) return
    const reset = options.reset === true
    const page = reset ? 1 : this.data.page
    this.setData({ loading: true })
    callFunction('adminMall', 'listOrders', { status: this.data.status, keyword: this.data.keyword, page, pageSize: this.data.pageSize })
      .then((result) => {
        const pageData = pageList(result)
        const orders = reset ? pageData.list.map(decorateOrder) : this.data.orders.concat(pageData.list.map(decorateOrder))
        this.setData({ orders, stats: orderStats(orders), page: pageData.page, hasMore: pageData.hasMore, loading: false })
      })
      .catch((error) => { this.setData({ loading: false }); showError(error) })
  },
  loadMore() { if (!this.data.hasMore || this.data.loading) return; this.setData({ page: this.data.page + 1 }, () => this.load()) },
  inputKeyword(e) { this.setData({ keyword: e.detail.value }) },
  search() { this.setData({ page: 1, hasMore: true }, () => this.load({ reset: true })) },
  chooseStatus(e) { this.setData({ status: e.currentTarget.dataset.status || '', page: 1, hasMore: true }, () => this.load({ reset: true })) },

  showShip(e) {
    const order = this.data.orders.find((item) => item._id === e.currentTarget.dataset.id)
    this.setData({ shipping: true, activeOrder: order, shipForm: { expressCompany: order && order.expressCompany || '', trackingNo: order && order.trackingNo || '' } })
  },
  hideShip() { this.setData({ shipping: false }) },
  inputShip(e) { this.setData({ ['shipForm.' + e.currentTarget.dataset.field]: e.detail.value }) },
  submitShip() {
    const order = this.data.activeOrder
    callFunction('adminMall', 'shipOrder', { orderId: order._id, ...this.data.shipForm }).then(() => { wx.showToast({ title: '已发货' }); this.setData({ shipping: false }); this.load({ reset: true }) }).catch(showError)
  },

  showRefund(e) {
    const order = this.data.orders.find((item) => item._id === e.currentTarget.dataset.id)
    this.setData({ refunding: true, activeOrder: order, refundForm: { approved: true, remark: '', refundAmount: order ? order.refundAmount || order.payAmount : '' } })
  },
  hideRefund() { this.setData({ refunding: false }) },
  inputRefund(e) { this.setData({ ['refundForm.' + e.currentTarget.dataset.field]: e.detail.value }) },
  switchRefund(e) { this.setData({ ['refundForm.approved']: e.detail.value }) },
  submitRefund() {
    const order = this.data.activeOrder
    callFunction('adminMall', 'auditRefund', { orderId: order._id, approved: this.data.refundForm.approved, remark: this.data.refundForm.remark, refundAmount: Number(this.data.refundForm.refundAmount || order.payAmount) }).then(() => { wx.showToast({ title: '已处理' }); this.setData({ refunding: false }); this.load({ reset: true }) }).catch(showError)
  },
  copyLogistics(e) {
    const order = this.data.orders.find((item) => item._id === e.currentTarget.dataset.id)
    if (!order || !order.trackingNo) return wx.showToast({ title: '暂无物流单号', icon: 'none' })
    copyText(`${order.expressCompany || ''} ${order.trackingNo}`.trim(), { successTitle: '物流单号已复制', emptyTitle: '暂无物流单号' })
  },

  // 手动修改商城订单状态
  openStatusModal(e) {
    const id = e.currentTarget.dataset.id
    const order = this.data.orders.find((item) => item._id === id)
    if (!order) return
    let idx = MALL_ORDER_STATUS_OPTIONS.findIndex((opt) => opt.value === order.status)
    if (idx < 0) idx = 0
    this.setData({
      showStatusModal: true,
      statusOrder: order,
      statusIndex: idx,
      statusRemark: ''
    })
  },
  closeStatusModal() {
    this.setData({ showStatusModal: false, statusOrder: null, statusRemark: '' })
  },
  onStatusPickerChange(e) {
    this.setData({ statusIndex: Number(e.detail.value || 0) })
  },
  inputStatusRemark(e) {
    this.setData({ statusRemark: e.detail.value })
  },
  submitUpdateStatus() {
    const order = this.data.statusOrder
    if (!order) return
    const target = MALL_ORDER_STATUS_OPTIONS[this.data.statusIndex]
    if (!target) return
    if (target.value === order.status) {
      wx.showToast({ title: '所选状态与当前一致', icon: 'none' })
      return
    }
    const remark = String(this.data.statusRemark || '').trim()
    if (!remark) {
      wx.showToast({ title: '请填写操作说明', icon: 'none' })
      return
    }
    this.setData({ submittingStatus: true })
    callFunction('adminMall', 'updateOrderStatus', {
      orderId: order._id,
      status: target.value,
      remark
    })
      .then(() => {
        wx.showToast({ title: '状态已修改' })
        this.closeStatusModal()
        this.load({ reset: true })
      })
      .catch(showError)
      .finally(() => this.setData({ submittingStatus: false }))
  },

  // 手动退款商城订单
  openManualRefundModal(e) {
    const id = e.currentTarget.dataset.id
    const order = this.data.orders.find((item) => item._id === id)
    if (!order) return
    const maxRefundable = order.maxRefundable != null
      ? order.maxRefundable
      : Math.max(0, Math.round(((order.payAmount || 0) - (order.alreadyRefunded || 0)) * 100) / 100)
    if (maxRefundable <= 0) {
      wx.showToast({ title: '该订单无剩余可退金额', icon: 'none' })
      return
    }
    this.setData({
      showManualRefundModal: true,
      manualRefundOrder: { ...order, maxRefundable },
      manualRefundAmount: String(maxRefundable),
      manualRefundReason: ''
    })
  },
  closeManualRefundModal() {
    this.setData({ showManualRefundModal: false, manualRefundOrder: null, manualRefundAmount: '', manualRefundReason: '' })
  },
  inputManualRefund(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [field]: e.detail.value })
  },
  setFullManualRefund() {
    const order = this.data.manualRefundOrder
    if (!order) return
    this.setData({ manualRefundAmount: String(order.maxRefundable || 0) })
  },
  submitManualRefund() {
    const order = this.data.manualRefundOrder
    if (!order) return
    const refundAmount = Number(this.data.manualRefundAmount)
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
      wx.showToast({ title: '请输入有效退款金额', icon: 'none' })
      return
    }
    if (refundAmount > order.maxRefundable) {
      wx.showToast({ title: `不能超过最大可退 ¥${order.maxRefundable}`, icon: 'none' })
      return
    }
    const reason = String(this.data.manualRefundReason || '').trim()
    if (!reason) {
      wx.showToast({ title: '请填写退款说明', icon: 'none' })
      return
    }
    wx.showModal({
      title: '确认手动退款',
      content: `确定为订单 ${order.orderNo} 退款 ¥${refundAmount.toFixed(2)} 吗？款项将原路退回用户。`,
      confirmColor: '#ea580c',
      success: (res) => {
        if (!res.confirm) return
        this.setData({ submittingManualRefund: true })
        callFunction('adminMall', 'refundOrder', {
          orderId: order._id,
          refundAmount,
          reason
        })
          .then(() => {
            wx.showToast({ title: '退款已提交' })
            this.closeManualRefundModal()
            this.load({ reset: true })
          })
          .catch(showError)
          .finally(() => this.setData({ submittingManualRefund: false }))
      }
    })
  }
})

