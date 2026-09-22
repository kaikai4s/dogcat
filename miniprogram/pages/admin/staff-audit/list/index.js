const { callFunction, showError } = require('../../../../utils/cloud')
const { withAuditText } = require('../../../../utils/format')

const tabs = [
  { label: '全部', value: '' },
  { label: '待审核', value: 'pending' },
  { label: '已通过', value: 'approved' },
  { label: '未通过', value: 'rejected' }
]

function pageList(result) {
  return Array.isArray(result) ? { list: result, hasMore: false, page: 1, total: result.length } : (result || { list: [], hasMore: false, page: 1, total: 0 })
}

Page({
  data: {
    tabs,
    activeStatus: '',
    keyword: '',
    staff: [],
    page: 1,
    pageSize: 10,
    hasMore: true,
    loading: false,
    total: 0
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
    const params = {
      auditStatus: this.data.activeStatus,
      keyword: this.data.keyword,
      page,
      pageSize: this.data.pageSize
    }
    this.setData({ loading: true })
    callFunction('admin', 'listStaffAudits', params)
      .then((result) => {
        const pageData = pageList(result)
        const staff = pageData.list.map(withAuditText)
        this.setData({
          staff: reset ? staff : this.data.staff.concat(staff),
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

  inputKeyword(e) {
    this.setData({ keyword: e.detail.value })
  },

  submitSearch() {
    this.setData({ page: 1, hasMore: true }, () => this.load({ reset: true }))
  },

  clearSearch() {
    this.setData({ keyword: '', page: 1, hasMore: true }, () => this.load({ reset: true }))
  },

  detail(e) {
    wx.navigateTo({ url: '/pages/admin/staff-audit/detail/index?id=' + e.currentTarget.dataset.id })
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
