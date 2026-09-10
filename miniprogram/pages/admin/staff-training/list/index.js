const { callFunction, showError } = require('../../../../utils/cloud')
const { formatDateTime, withStaffWorkflowText } = require('../../../../utils/format')

function withDisplay(item) {
  const profile = withStaffWorkflowText(item)
  return { ...profile, requestedAtText: formatDateTime(profile.videoAuditRequestedAt), quizPassedAtText: formatDateTime(profile.quizPassedAt), videosCompletedAtText: formatDateTime(profile.trainingVideosCompletedAt) }
}

Page({
  data: { list: [], keyword: '', page: 1, pageSize: 20, hasMore: true, loading: false },
  onShow() { this.load({ reset: true }) },
  onReachBottom() { this.loadMore() },
  inputKeyword(e) { this.setData({ keyword: e.detail.value }) },
  search() { this.load({ reset: true }) },
  load(options = {}) {
    if (this.data.loading) return
    const reset = options.reset === true
    const page = reset ? 1 : this.data.page
    this.setData({ loading: true })
    callFunction('admin', 'listTrainingAudits', { keyword: this.data.keyword, page, pageSize: this.data.pageSize })
      .then((res) => {
        const pageData = Array.isArray(res) ? { list: res, page: 1, hasMore: false } : res
        const list = (pageData.list || []).map(withDisplay)
        this.setData({ list: reset ? list : this.data.list.concat(list), page: pageData.page || page, hasMore: Boolean(pageData.hasMore), loading: false })
      })
      .catch((err) => { this.setData({ loading: false }); showError(err) })
  },
  loadMore() { if (!this.data.hasMore) return; this.setData({ page: this.data.page + 1 }, () => this.load()) },
  detail(e) { wx.navigateTo({ url: `/pages/admin/staff-training/detail/index?id=${e.currentTarget.dataset.id}` }) }
})
