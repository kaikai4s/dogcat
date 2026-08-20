const { callFunction, showError } = require('../../../../utils/cloud')
const { withOrderText } = require('../../../../utils/format')
const { getSelectedLocation } = require('../../../../utils/cloud')
const { applyTheme, getThemeState } = require('../../../../utils/theme')

const tabs = [
  { label: '全部', value: 'all' },
  { label: '待服务', value: 'waiting_service' },
  { label: '服务中', value: 'in_service' },
  { label: '已完成', value: 'completed' }
]

function pageList(result) {
  return Array.isArray(result) ? { list: result, hasMore: false, page: 1, total: result.length } : (result || { list: [], hasMore: false, page: 1, total: 0 })
}

Page({
  data: { themeClass: 'theme-day', tabs, activeStatus: 'all', orders: [], page: 1, pageSize: 10, hasMore: true, loading: false, total: 0 },
  onShow() {
    this.applyCurrentTheme()
    this.load({ reset: true })
  },
  onReachBottom() {
    this.loadMore()
  },
  load(options = {}) {
    if (this.data.loading) return
    const reset = options.reset === true
    const page = reset ? 1 : this.data.page
    const location = getSelectedLocation()
    const data = location ? { latitude: location.latitude, longitude: location.longitude } : {}
    data.page = page
    data.pageSize = this.data.pageSize
    if (this.data.activeStatus === 'waiting_service') data.statusGroup = 'waiting_service'
    else if (this.data.activeStatus !== 'all') data.status = this.data.activeStatus
    this.setData({ loading: true })
    callFunction('staff', 'listStaffOrders', data)
      .then((result) => {
        const pageData = pageList(result)
        const orders = pageData.list.map(withOrderText)
        this.setData({ orders: reset ? orders : this.data.orders.concat(orders), page: pageData.page, hasMore: pageData.hasMore, total: pageData.total, loading: false })
      })
      .catch((error) => {
        this.setData({ loading: false })
        showError(error)
      })
  },
  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },
  loadMore() {
    if (!this.data.hasMore || this.data.loading) return
    this.setData({ page: this.data.page + 1 }, () => this.load())
  },
  chooseStatus(e) {
    this.setData({ activeStatus: e.currentTarget.dataset.status, page: 1, hasMore: true }, () => this.load({ reset: true }))
  },
  detail(e) { wx.navigateTo({ url: '/pages/staff/orders/detail/index?id=' + e.currentTarget.dataset.id }) },
  openNavigation(e) {
    const { latitude, longitude, name, address } = e.currentTarget.dataset
    const lat = Number(latitude)
    const lng = Number(longitude)
    if (!lat || !lng) {
      wx.showToast({ title: '订单缺少定位，无法导航', icon: 'none' })
      return
    }
    wx.openLocation({ latitude: lat, longitude: lng, name: name || '服务地址', address: address || name || '服务地址', scale: 16 })
  },
  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  },
  backProfile() { wx.redirectTo({ url: '/pages/staff/profile/index' }) }
})
