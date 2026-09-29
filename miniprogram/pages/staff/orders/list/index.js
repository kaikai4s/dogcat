const { callFunction, showError } = require('../../../../utils/cloud')
const { withOrderText } = require('../../../../utils/format')
const { getSelectedLocation } = require('../../../../utils/cloud')
const { applyTheme, getThemeState } = require('../../../../utils/theme')
const { loadMessageUnread } = require('../../../../utils/client-nav')

const tabs = [
  { label: '全部', value: 'all' },
  { label: '待服务', value: 'waiting_service' },
  { label: '服务中', value: 'in_service' },
  { label: '已完成', value: 'completed' }
]

function pageList(result) {
  return Array.isArray(result) ? { list: result, hasMore: false, page: 1, total: result.length } : (result ? { ...result, list: Array.isArray(result.list) ? result.list : [] } : { list: [], hasMore: false, page: 1, total: 0 })
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
    orderKeyword: '',
    startDate: '',
    endDate: '',
    messageUnreadCount: 0,
    messageHasUnread: false
  },
  onShow() {
    this.applyCurrentTheme()
    this.load({ reset: true })
    loadMessageUnread(this, 'staff')
  },
  onReachBottom() {
    this.loadMore()
  },
  load(options = {}) {
    const reset = options.reset === true
    if (!reset && this.data.loading) return
    const page = reset ? 1 : this.data.page
    const location = getSelectedLocation()
    const data = location ? { latitude: location.latitude, longitude: location.longitude } : {}
    data.page = page
    data.pageSize = this.data.pageSize
    data.orderKeyword = (this.data.orderKeyword || '').trim()
    data.startDate = (this.data.startDate || '').trim()
    data.endDate = (this.data.endDate || '').trim()
    if (this.data.activeStatus === 'waiting_service') data.statusGroup = 'waiting_service'
    else if (this.data.activeStatus !== 'all') data.status = this.data.activeStatus

    const requestSeq = (this._requestSeq || 0) + 1
    this._requestSeq = requestSeq
    this.setData({ loading: true })
    callFunction('staff', 'listStaffOrders', data)
      .then((result) => {
        if (requestSeq !== this._requestSeq) return
        const pageData = pageList(result)
        const orders = (pageData.list || []).map(withOrderText)
        this.setData({
          orders: reset ? orders : this.data.orders.concat(orders),
          page: pageData.page,
          hasMore: pageData.hasMore,
          total: pageData.total,
          loading: false
        })
      })
      .catch((error) => {
        if (requestSeq !== this._requestSeq) return
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
    const status = e.currentTarget.dataset.status
    if (status === this.data.activeStatus) return
    this.setData({ activeStatus: status, page: 1, hasMore: true }, () => this.load({ reset: true }))
  },
  inputKeyword(e) {
    this.setData({ orderKeyword: e.detail.value })
  },
  confirmSearch() {
    this.setData({ page: 1, hasMore: true }, () => this.load({ reset: true }))
  },
  clearKeyword() {
    this.setData({ orderKeyword: '', page: 1, hasMore: true }, () => this.load({ reset: true }))
  },
  changeStartDate(e) {
    this.setData({ startDate: e.detail.value, page: 1, hasMore: true }, () => this.load({ reset: true }))
  },
  changeEndDate(e) {
    this.setData({ endDate: e.detail.value, page: 1, hasMore: true }, () => this.load({ reset: true }))
  },
  resetFilters() {
    this.setData({ orderKeyword: '', startDate: '', endDate: '', page: 1, hasMore: true }, () => this.load({ reset: true }))
  },
  detail(e) { wx.navigateTo({ url: '/pages/staff/orders/detail/index?id=' + e.currentTarget.dataset.id }) },
  openOrderMessages(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/staff/messages/thread/index?orderId=' + id })
  },
  openNavigation(e) {
    const { latitude, longitude, name, address, approximate } = e.currentTarget.dataset
    const lat = Number(latitude)
    const lng = Number(longitude)
    if (latitude == null || longitude == null || String(latitude).trim() === '' || String(longitude).trim() === '' || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180 || (lat === 0 && lng === 0)) {
      wx.showToast({ title: '订单缺少定位，无法导航', icon: 'none' })
      return
    }
    const isApproximate = approximate === true || approximate === 'true'
    const cleanAddress = isApproximate ? '约 1 公里范围的参考位置，非实际上门地点；接单后可见精确位置' : (address && !address.includes('接单后可见') ? address : (name || '服务地址'))
    wx.openLocation({ latitude: lat, longitude: lng, name: isApproximate ? '服务区域（模糊位置）' : (name || '服务地址'), address: cleanAddress, scale: isApproximate ? 14 : 16, fail: () => wx.showToast({ title: '地图打开失败，请稍后重试', icon: 'none' }) })
  },
  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    const pages = getCurrentPages()
    const current = pages[pages.length - 1]
    const currentRoute = current && current.route ? '/' + current.route : ''
    if (currentRoute === url) return
    const mainNavUrls = ['/pages/staff/home/index', '/pages/staff/orders/list/index', '/pages/staff/messages/index', '/pages/staff/certification/index', '/pages/staff/profile/index']
    const method = mainNavUrls.includes(url) ? 'redirectTo' : 'navigateTo'
    wx[method]({ url })
  },
  backProfile() { wx.redirectTo({ url: '/pages/staff/profile/index' }) }
})
