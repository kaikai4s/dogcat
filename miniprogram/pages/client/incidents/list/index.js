const { callFunction, showError, ensureLogin } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { withIncidentText } = require('../../../../utils/format')

const tabs = [
  { label: '全部', value: 'all' },
  { label: '待处理', value: 'open' },
  { label: '处理中', value: 'processing' },
  { label: '待补充', value: 'waiting_client' },
  { label: '已解决', value: 'resolved' },
  { label: '已关闭', value: 'closed' }
]

function pageList(result) {
  return Array.isArray(result) ? { list: result, hasMore: false, page: 1, total: result.length } : (result || { list: [], hasMore: false, page: 1, total: 0 })
}

Page({
  data: {
    tabs,
    activeStatus: 'all',
    incidents: [],
    page: 1,
    pageSize: 10,
    hasMore: true,
    loading: false,
    total: 0,
    sectionHomeUrl: '',
    canGoBack: false
  },

  onLoad(q) {
    this.setData(createPageNav(q))
  },

  onShow() {
    ensureLogin({ content: '登录后可查看投诉和售后进度。' })
      .then(() => this.load({ reset: true }))
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },

  onReachBottom() {
    this.loadMore()
  },

  load(options = {}) {
    if (this.data.loading) return
    const reset = options.reset === true
    const page = reset ? 1 : this.data.page
    const params = { role: 'client', page, pageSize: this.data.pageSize }
    if (this.data.activeStatus !== 'all') params.status = this.data.activeStatus
    this.setData({ loading: true })
    callFunction('incident', 'listMyIncidents', params)
      .then((result) => {
        const pageData = pageList(result)
        const incidents = pageData.list.map(withIncidentText)
        this.setData({
          incidents: reset ? incidents : this.data.incidents.concat(incidents),
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

  detail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/client/incidents/detail/index?id=${id}` })
  },

  goOrders() {
    wx.navigateTo({ url: '/pages/client/orders/list/index' })
  },

  ...navMethods()
})
