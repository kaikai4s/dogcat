const { callFunction, showError } = require('../../../../utils/cloud')
const { withIncidentText } = require('../../../../utils/format')

const statusTabs = [
  { label: '全部', value: '' },
  { label: '待处理', value: 'open' },
  { label: '处理中', value: 'processing' },
  { label: '已结案', value: 'resolved' }
]

function pageList(result) {
  return Array.isArray(result) ? { list: result, hasMore: false, page: 1, total: result.length } : (result || { list: [], hasMore: false, page: 1, total: 0 })
}

Page({
  data: { incidents: [], statusTabs, status: '', orderId: '', page: 1, pageSize: 20, hasMore: true, total: 0, loading: false },

  onLoad(q) {
    this.setData({ orderId: q.orderId || '' })
  },

  onShow() {
    this.load({ reset: true })
  },

  onReachBottom() {
    this.loadMore()
  },

  load(options = {}) {
    if (this.data.loading) return
    const reset = options.reset === true
    const page = reset ? 1 : this.data.page
    this.setData({ loading: true })
    callFunction('incident', 'listIncidents', { status: this.data.status, orderId: this.data.orderId, page, pageSize: this.data.pageSize })
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

  switchStatus(e) {
    this.setData({ status: e.currentTarget.dataset.status || '' }, () => this.load({ reset: true }))
  },

  resolve(e) {
    callFunction('incident', 'resolveIncident', { id: e.currentTarget.dataset.id }).then(() => this.load({ reset: true })).catch(showError)
  },

  detail(e) {
    wx.navigateTo({ url: `/pages/admin/incidents/detail/index?id=${e.currentTarget.dataset.id}` })
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  }
})
