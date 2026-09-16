const { callFunction, showError } = require('../../../../utils/cloud')

const tabs = [
  { label: '全部', value: '' },
  { label: '待付款', value: 'pending_pay' },
  { label: '待发货', value: 'pending_ship' },
  { label: '已发货', value: 'shipped' },
  { label: '售后', value: 'refund_applied' },
  { label: '已退款', value: 'refunded' }
]

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
  return {
    ...order,
    goodsCount,
    goodsSummary: firstGoods ? `${firstGoods.name}${goodsCount > Number(firstGoods.quantity || 0) ? ` 等${goodsCount}件` : ` × ${firstGoods.quantity || 1}`}` : '商城订单',
    paymentStatusText: paymentStatusText(order.paymentStatus),
    refundStatusText: refundStatusText(order.refundStatus),
    statusClass: order.status === 'pending_ship' ? 'warning' : (order.status === 'refunded' ? 'muted-badge' : (order.status === 'refund_applied' ? 'danger-badge' : 'success')),
    refundClass: order.refundStatus === 'applied' ? 'danger-badge' : (order.refundStatus === 'approved' ? 'success' : 'muted-badge'),
    addressText,
    logisticsText: order.expressCompany && order.trackingNo ? `${order.expressCompany} ${order.trackingNo}` : '待录入',
    canShip: order.status === 'pending_ship',
    canAuditRefund: order.refundStatus === 'applied'
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
  data: { tabs, orders: [], stats: orderStats(), status: '', keyword: '', page: 1, pageSize: 10, hasMore: true, loading: false, shipping: false, refunding: false, activeOrder: null, shipForm: { expressCompany: '', trackingNo: '' }, refundForm: { approved: true, remark: '', refundAmount: '' } },

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
    wx.setClipboardData({ data: `${order.expressCompany || ''} ${order.trackingNo}`.trim() })
  }
})
