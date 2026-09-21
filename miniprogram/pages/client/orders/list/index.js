const { callFunction, showError } = require('../../../../utils/cloud')
const { ensureLogin } = require('../../../../utils/cloud')
const { loadMessageUnread } = require('../../../../utils/client-nav')
const { withOrderText } = require('../../../../utils/format')
const { applyTheme, getThemeState } = require('../../../../utils/theme')

const tabs = [
  { label: '全部', value: 'all' },
  { label: '待支付', value: 'pending_pay' },
  { label: '待派单', value: 'paid' },
  { label: '待服务', value: 'waiting_service' },
  { label: '已完成', value: 'completed' },
  { label: '已过期', value: 'expired' }
]

function pageList(result) {
  return Array.isArray(result) ? { list: result, hasMore: false, page: 1, total: result.length } : (result || { list: [], hasMore: false, page: 1, total: 0 })
}

Page({
  data: {
    themeClass: 'theme-day',
    tabs,
    activeStatus: 'all',
    orders: [],
    page: 1,
    pageSize: 10,
    hasMore: true,
    loading: false,
    total: 0,
    messageUnreadCount: 0,
    messageHasUnread: false
  },
  onShow() {
    this.applyCurrentTheme()
    ensureLogin({ content: '登录后可查看订单。' })
      .then(() => {
        this.load({ reset: true })
        loadMessageUnread(this)
      })
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },
  onReachBottom() {
    this.loadMore()
  },
  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },
  load(options = {}) {
    if (this.data.loading) return
    const reset = options.reset === true
    const page = reset ? 1 : this.data.page
    const activeStatus = this.data.activeStatus
    const params = { role: 'client', page, pageSize: this.data.pageSize }
    if (activeStatus === 'waiting_service') params.statusGroup = 'waiting_service'
    else if (activeStatus !== 'all') params.status = activeStatus
    this.setData({ loading: true })
    callFunction('order', 'listOrders', params)
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
    this.setData({ activeStatus: e.currentTarget.dataset.status, page: 1, hasMore: true }, () => this.load({ reset: true }))
  },
  detail(e) { wx.navigateTo({ url: '/pages/client/orders/detail/index?id=' + e.currentTarget.dataset.id }) },
  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    const pages = getCurrentPages()
    const current = pages[pages.length - 1]
    const currentRoute = current && current.route ? '/' + current.route : ''
    if (currentRoute === url) return
    const mainNavUrls = ['/pages/client/home/index', '/pages/client/sitters/list/index', '/pages/client/orders/list/index', '/pages/client/messages/index', '/pages/client/profile/index']
    const method = mainNavUrls.includes(url) ? 'redirectTo' : 'navigateTo'
    wx[method]({ url })
  }
})
