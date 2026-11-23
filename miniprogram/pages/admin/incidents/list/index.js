const { callFunction, showError } = require('../../../../utils/cloud')
const { withIncidentText , pageList } = require('../../../../utils/format')

const statusTabs = [
  { label: '全部', value: '' },
  { label: '待处理', value: 'open' },
  { label: '处理中', value: 'processing' },
  { label: '已结案', value: 'resolved' }
]

Page({
  data: { incidents: [], statusTabs, status: '', orderId: '', page: 1, pageSize: 20, hasMore: true, total: 0, loading: false },

  onLoad(q) {
    this.setData({ orderId: q.orderId || '' })
  },

    onPullDownRefresh() {
    Promise.resolve(this.load({ reset: true })).finally(() => wx.stopPullDownRefresh())
  },

  onShow() {
    this.load({ reset: true })
  },

  onReachBottom() {
    this.loadMore()
  },

  load(options = {}) {
    const reset = options.reset === true
    if (this.data.loading && !reset) return
    const page = reset ? 1 : this.data.page
    const seq = (this._loadSeq = (this._loadSeq || 0) + 1)
    this.setData({ loading: true })
    return callFunction('incident', 'listIncidents', { status: this.data.status, orderId: this.data.orderId, page, pageSize: this.data.pageSize })
      .then((result) => {
        if (seq !== this._loadSeq) return
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
        if (seq !== this._loadSeq) return
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
    const id = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.id
    if (!id || this._resolvingLock) return
    this._resolvingLock = true
    return callFunction('incident', 'resolveIncident', { id })
      .then(() => this.load({ reset: true }))
      .catch(showError)
      .finally(() => { this._resolvingLock = false })
  },

  detail(e) {
    wx.navigateTo({ url: `/pages/admin/incidents/detail/index?id=${e.currentTarget.dataset.id}` })
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    const pages = getCurrentPages()
    const current = pages[pages.length - 1]
    const currentRoute = current && current.route ? '/' + current.route : ''
    if (currentRoute === url) return
    const mainNavUrls = ['/pages/admin/home/index', '/pages/admin/orders/list/index', '/pages/admin/staff-audit/list/index', '/pages/admin/incidents/list/index', '/pages/admin/checkin-config/index', '/pages/admin/points/index', '/pages/admin/settings/index']
    const method = mainNavUrls.includes(url) ? 'redirectTo' : 'navigateTo'
    wx[method]({ url })
  }
})
