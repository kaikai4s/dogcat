const { callFunction, showError, ensureLogin } = require('../../../../../utils/cloud')

const tabs = [
  { label: '全部', value: 'all' },
  { label: '待付款', value: 'pending_pay' },
  { label: '待发货', value: 'pending_ship' },
  { label: '已发货', value: 'shipped' },
  { label: '已完成', value: 'completed' },
  { label: '售后', value: 'after_sale' }
]

function pageList(result) {
  return Array.isArray(result) ? { list: result, hasMore: false, page: 1, total: result.length } : (result || { list: [], hasMore: false, page: 1, total: 0 })
}

Page({
  data: { tabs, activeStatus: 'all', orders: [], page: 1, pageSize: 10, hasMore: true, loading: false },

  onShow() {
    ensureLogin({ content: '登录后可查看商城订单。' })
      .then(() => this.load({ reset: true }))
      .catch(() => wx.navigateBack())
  },

  onReachBottom() { this.loadMore() },

  load(options = {}) {
    if (this.data.loading) return
    const reset = options.reset === true
    const page = reset ? 1 : this.data.page
    this.setData({ loading: true })
    callFunction('mall', 'listMyOrders', { status: this.data.activeStatus, page, pageSize: this.data.pageSize })
      .then((result) => {
        const pageData = pageList(result)
        this.setData({ orders: reset ? pageData.list : this.data.orders.concat(pageData.list), page: pageData.page, hasMore: pageData.hasMore, loading: false })
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

  chooseStatus(e) { this.setData({ activeStatus: e.currentTarget.dataset.status, page: 1, hasMore: true }, () => this.load({ reset: true })) },
  detail(e) { wx.navigateTo({ url: '/pages/client/mall/orders/detail/index?id=' + e.currentTarget.dataset.id }) },
  goMall() { wx.navigateTo({ url: '/pages/client/mall/list/index' }) }
})
