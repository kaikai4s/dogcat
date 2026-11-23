const { callFunction, showError } = require('../../../../utils/cloud')
const { formatDateTime, formatPromotionStatus } = require('../../../../utils/format')

const tabs = [
  { label: '待审核', value: 'pending' },
  { label: '已通过', value: 'approved' },
  { label: '已拒绝', value: 'rejected' }
]

function withDisplay(item) {
  const profile = item.profile || {}
  return {
    ...item,
    createdAtText: formatDateTime(item.createdAt),
    statusText: formatPromotionStatus(item.status),
    realName: profile.realName || '宠托师',
    phone: profile.phone || '',
    accountPhone: profile.accountPhone || profile.phone || '',
    certifiedPhone: profile.certifiedPhone || '',
    staffLevelText: profile.staffLevelText || ''
  }
}

Page({
  data: { tabs, status: 'pending', list: [], page: 1, pageSize: 20, hasMore: true, loading: false },
  onShow() { this.load({ reset: true }) },
  onReachBottom() { this.loadMore() },
  switchStatus(e) { this.setData({ status: e.currentTarget.dataset.value || 'pending' }, () => this.load({ reset: true })) },
  load(options = {}) {
    const reset = options.reset === true
    if (this.data.loading && !reset) return
    const page = reset ? 1 : this.data.page
    const seq = (this._loadSeq = (this._loadSeq || 0) + 1)
    this.setData({ loading: true })
    return callFunction('admin', 'listPromotionApplications', { status: this.data.status, page, pageSize: this.data.pageSize })
      .then((res) => {
        if (seq !== this._loadSeq) return
        const pageData = Array.isArray(res) ? { list: res, page: 1, hasMore: false } : res
        const list = (pageData.list || []).map(withDisplay)
        this.setData({ list: reset ? list : this.data.list.concat(list), page: pageData.page || page, hasMore: Boolean(pageData.hasMore), loading: false })
      })
      .catch((err) => {
        if (seq !== this._loadSeq) return
        this.setData({ loading: false })
        showError(err)
      })
  },
  loadMore() { if (!this.data.hasMore || this.data.loading) return; this.setData({ page: this.data.page + 1 }, () => this.load()) },
  detail(e) { wx.navigateTo({ url: `/pages/admin/staff-promotion/detail/index?id=${e.currentTarget.dataset.id}` }) }
})
