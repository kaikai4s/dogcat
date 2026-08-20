const { callFunction, showError } = require('../../../../utils/cloud')
const { applyTheme, getThemeState } = require('../../../../utils/theme')

const tabs = [
  { label: '全部', value: '' },
  { label: '遛狗', value: 'walk' },
  { label: '喂养', value: 'feed' }
]

function pageList(result) {
  return Array.isArray(result) ? { list: result, hasMore: false, page: 1, total: result.length } : (result || { list: [], hasMore: false, page: 1, total: 0 })
}

Page({
  data: {
    themeClass: 'theme-day',
    tabs,
    activeServiceType: '',
    loading: false,
    page: 1,
    pageSize: 10,
    hasMore: true,
    total: 0,
    orders: []
  },

  onShow() {
    this.applyCurrentTheme()
    this.load({ reset: true })
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
    const params = { page, pageSize: this.data.pageSize }
    if (this.data.activeServiceType) params.serviceType = this.data.activeServiceType
    this.setData({ loading: true })
    callFunction('order', 'listPublicCompletedOrders', params)
      .then((result) => {
        const pageData = pageList(result)
        this.setData({
          orders: reset ? pageData.list : this.data.orders.concat(pageData.list),
          page: pageData.page,
          hasMore: pageData.hasMore,
          total: pageData.total,
          loading: false
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        showError(err)
      })
  },

  loadMore() {
    if (!this.data.hasMore || this.data.loading) return
    this.setData({ page: this.data.page + 1 }, () => this.load())
  },

  chooseServiceType(e) {
    this.setData({ activeServiceType: e.currentTarget.dataset.type || '', page: 1, hasMore: true }, () => this.load({ reset: true }))
  },

  detail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/client/orders/public-detail/index?id=${id}` })
  },

  previewPhoto(e) {
    const url = e.currentTarget.dataset.url
    const orderId = e.currentTarget.dataset.orderId
    const order = this.data.orders.find((item) => item._id === orderId)
    const urls = (order && order.checkinPhotos || []).map((item) => item.mediaFileId).filter(Boolean)
    if (!url) return
    wx.previewImage({ current: url, urls: urls.length ? urls : [url] })
  }
})
