const { callFunction, showError } = require('../../../../utils/cloud')

const tabs = [
  { label: '全部', value: '' },
  { label: '待审核', value: 'pending' },
  { label: '已通过', value: 'approved' },
  { label: '未通过', value: 'rejected' }
]

function pageList(result) {
  return Array.isArray(result) ? { list: result, hasMore: false, page: 1, total: result.length } : (result || { list: [], hasMore: false, page: 1, total: 0 })
}

function statusText(status) {
  return { pending: '待审核', approved: '已通过', rejected: '未通过', cancelled: '已取消' }[status] || '未知'
}

Page({
  data: {
    tabs,
    activeStatus: 'pending',
    keyword: '',
    applications: [],
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
    this.setData({ loading: true })
    callFunction('admin', 'listPetVaccineCertifications', {
      status: this.data.activeStatus,
      keyword: this.data.keyword,
      page,
      pageSize: this.data.pageSize
    }).then((result) => {
      const pageData = pageList(result)
      const list = (pageData.list || []).map((item) => ({ ...item, statusText: statusText(item.status) }))
      this.setData({
        applications: reset ? list : this.data.applications.concat(list),
        page: pageData.page,
        hasMore: pageData.hasMore,
        total: pageData.total,
        loading: false
      })
    }).catch((error) => {
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

  previewFile(e) {
    const current = e.currentTarget.dataset.file
    const app = this.data.applications.find((item) => item._id === e.currentTarget.dataset.id) || {}
    const urls = app.fileIds || []
    if (current && urls.length) wx.previewImage({ current, urls })
  },

  approve(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '通过疫苗认证',
      content: '确认该宠物疫苗接种材料真实有效？',
      confirmText: '通过',
      success: (res) => {
        if (!res.confirm) return
        callFunction('admin', 'auditPetVaccineCertification', { applicationId: id, status: 'approved' })
          .then(() => { wx.showToast({ title: '已通过' }); this.load({ reset: true }) })
          .catch(showError)
      }
    })
  },

  reject(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '驳回疫苗认证',
      editable: true,
      placeholderText: '请输入驳回原因',
      confirmText: '驳回',
      success: (res) => {
        if (!res.confirm) return
        const reason = String(res.content || '').trim()
        if (!reason) {
          wx.showToast({ title: '请填写驳回原因', icon: 'none' })
          return
        }
        callFunction('admin', 'auditPetVaccineCertification', { applicationId: id, status: 'rejected', rejectReason: reason })
          .then(() => { wx.showToast({ title: '已驳回', icon: 'none' }); this.load({ reset: true }) })
          .catch(showError)
      }
    })
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  }
})
