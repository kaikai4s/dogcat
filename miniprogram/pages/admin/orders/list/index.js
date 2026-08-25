const { callFunction, showError } = require('../../../../utils/cloud')
const { withOrderText } = require('../../../../utils/format')

const tabs = [
  { label: '全部', value: '' },
  { label: '待支付', value: 'pending_pay' },
  { label: '待派单', value: 'paid' },
  { label: '待服务', value: 'assigned' },
  { label: '服务中', value: 'in_service' },
  { label: '已完成', value: 'completed' }
]

function pageList(result) {
  return Array.isArray(result) ? { list: result, hasMore: false, page: 1, total: result.length } : (result || { list: [], hasMore: false, page: 1, total: 0 })
}

function applySelected(orders, selectedOrderIds) {
  const selected = new Set(selectedOrderIds || [])
  return (orders || []).map((order) => ({ ...order, selected: selected.has(order._id) }))
}

Page({
  data: { tabs, activeStatus: '', orderKeyword: '', clientPhone: '', staffPhone: '', selectedOrderIds: [], deleting: false, orders: [], page: 1, pageSize: 20, hasMore: true, loading: false, total: 0 },
  onShow() { this.load({ reset: true }) },
  onReachBottom() { this.loadMore() },
  load(options = {}) {
    if (this.data.loading && options.force !== true) return
    const reset = options.reset === true
    const page = reset ? 1 : this.data.page
    const requestSeq = (this._orderListRequestSeq || 0) + 1
    this._orderListRequestSeq = requestSeq
    this.setData({ loading: true })
    callFunction('admin', 'listOrders', { page, pageSize: this.data.pageSize, status: this.data.activeStatus, orderKeyword: this.data.orderKeyword.trim(), phone: this.data.clientPhone.trim(), clientPhone: this.data.clientPhone.trim(), staffPhone: this.data.staffPhone.trim() })
      .then((result) => {
        if (requestSeq !== this._orderListRequestSeq) return
        const pageData = pageList(result)
        const orders = pageData.list.map(withOrderText)
        const selectedOrderIds = reset ? [] : this.data.selectedOrderIds
        this.setData({
          orders: applySelected(reset ? orders : this.data.orders.concat(orders), selectedOrderIds),
          selectedOrderIds,
          page: pageData.page,
          hasMore: pageData.hasMore,
          total: pageData.total,
          loading: false
        })
      })
      .catch((error) => {
        if (requestSeq !== this._orderListRequestSeq) return
        this.setData({ loading: false })
        showError(error)
      })
  },
  loadMore() {
    if (!this.data.hasMore || this.data.loading) return
    this.setData({ page: this.data.page + 1 }, () => this.load())
  },
  chooseStatus(e) {
    this.setData({ activeStatus: e.currentTarget.dataset.status || '', page: 1, hasMore: true }, () => this.load({ reset: true, force: true }))
  },
  inputOrderKeyword(e) { this.setData({ orderKeyword: e.detail.value }) },
  inputClientPhone(e) { this.setData({ clientPhone: e.detail.value }) },
  inputStaffPhone(e) { this.setData({ staffPhone: e.detail.value }) },
  submitSearch() { this.setData({ page: 1, hasMore: true }, () => this.load({ reset: true, force: true })) },
  clearSearch() { this.setData({ orderKeyword: '', clientPhone: '', staffPhone: '', page: 1, hasMore: true }, () => this.load({ reset: true, force: true })) },
  toggleSelect(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    const selected = new Set(this.data.selectedOrderIds)
    if (selected.has(id)) selected.delete(id)
    else selected.add(id)
    const selectedOrderIds = Array.from(selected)
    this.setData({ selectedOrderIds, orders: applySelected(this.data.orders, selectedOrderIds) })
  },
  toggleSelectAll() {
    const loadedIds = this.data.orders.map((order) => order._id).filter(Boolean)
    const selected = new Set(this.data.selectedOrderIds)
    const allSelected = loadedIds.length > 0 && loadedIds.every((id) => selected.has(id))
    loadedIds.forEach((id) => {
      if (allSelected) selected.delete(id)
      else selected.add(id)
    })
    const selectedOrderIds = Array.from(selected)
    this.setData({ selectedOrderIds, orders: applySelected(this.data.orders, selectedOrderIds) })
  },
  batchDeleteOrders() {
    if (this.data.deleting) return
    const orderIds = this.data.selectedOrderIds
    if (!orderIds.length) {
      wx.showToast({ title: '请选择订单', icon: 'none' })
      return
    }
    wx.showModal({
      title: '确认删除订单',
      content: `将从订单列表删除 ${orderIds.length} 个订单，关联支付和履约记录会保留用于审计。`,
      confirmText: '删除',
      confirmColor: '#e11d48',
      success: (res) => {
        if (!res.confirm) return
        this.setData({ deleting: true })
        callFunction('admin', 'batchDeleteOrders', { orderIds })
          .then((result) => {
            wx.showToast({ title: `已删除 ${result.count || 0} 个`, icon: 'none' })
            this.setData({ deleting: false, selectedOrderIds: [], page: 1, hasMore: true }, () => this.load({ reset: true }))
          })
          .catch((error) => {
            this.setData({ deleting: false })
            showError(error)
          })
      }
    })
  },
  detail(e) { wx.navigateTo({ url: '/pages/admin/orders/detail/index?id=' + e.currentTarget.dataset.id }) },
  assign(e) { wx.navigateTo({ url: '/pages/admin/orders/assign/index?id=' + e.currentTarget.dataset.id }) },
  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  }
})
