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

Page({
  data: { tabs, activeStatus: '', orders: [], page: 1, pageSize: 20, hasMore: true, loading: false, total: 0 },
  onShow() { this.load({ reset: true }) },
  onReachBottom() { this.loadMore() },
  load(options = {}) {
    if (this.data.loading) return
    const reset = options.reset === true
    const page = reset ? 1 : this.data.page
    this.setData({ loading: true })
    callFunction('admin', 'listOrders', { page, pageSize: this.data.pageSize, status: this.data.activeStatus })
      .then((result) => {
        const pageData = pageList(result)
        const orders = pageData.list.map(withOrderText)
        this.setData({
          orders: reset ? orders : this.data.orders.concat(orders),
          page: pageData.page,
          hasMore: pageData.hasMore,
          total: pageData.total,
          loading: false
        })
      })
      .catch((error) => {
        this.setData({ loading: false })
        showError(error)
      })
  },
  loadMore() {
    if (!this.data.hasMore || this.data.loading) return
    this.setData({ page: this.data.page + 1 }, () => this.load())
  },
  chooseStatus(e) {
    this.setData({ activeStatus: e.currentTarget.dataset.status || '', page: 1, hasMore: true }, () => this.load({ reset: true }))
  },
  detail(e) { wx.navigateTo({ url: '/pages/admin/orders/detail/index?id=' + e.currentTarget.dataset.id }) },
  assign(e) { wx.navigateTo({ url: '/pages/admin/orders/assign/index?id=' + e.currentTarget.dataset.id }) },
  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  }
})
