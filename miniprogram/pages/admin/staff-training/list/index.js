const { callFunction, showError } = require('../../../../utils/cloud')
const { formatDateTime, withStaffWorkflowText } = require('../../../../utils/format')

function withDisplay(item) {
  const profile = withStaffWorkflowText(item)
  return { ...profile, requestedAtText: formatDateTime(profile.videoAuditRequestedAt), quizPassedAtText: formatDateTime(profile.quizPassedAt), videosCompletedAtText: formatDateTime(profile.trainingVideosCompletedAt) }
}

Page({
  data: {
    list: [],
    keyword: '',
    page: 1,
    pageSize: 20,
    hasMore: true,
    loading: false,
    videoAuditGuide: {
      wechatId: 'pet-service-admin',
      remarkTemplate: '宠托师审核 + 姓名 + 手机号'
    },
    showWechatModal: false,
    editWechatId: '',
    editRemarkTemplate: '',
    savingWechat: false
  },
  onShow() {
    this.load({ reset: true })
    this.loadAuditGuide()
  },
  onReachBottom() { this.loadMore() },
  inputKeyword(e) { this.setData({ keyword: e.detail.value }) },
  search() { this.load({ reset: true }) },
  loadAuditGuide() {
    callFunction('admin', 'getSystemSettings')
      .then((settings) => {
        const staffTraining = (settings && settings.staffTraining) || {}
        const guide = staffTraining.videoAuditGuide || {}
        this.setData({
          videoAuditGuide: {
            wechatId: guide.wechatId || 'pet-service-admin',
            remarkTemplate: guide.remarkTemplate || '宠托师审核 + 姓名 + 手机号'
          },
          editWechatId: guide.wechatId || 'pet-service-admin',
          editRemarkTemplate: guide.remarkTemplate || '宠托师审核 + 姓名 + 手机号'
        })
      })
      .catch(() => {})
  },
  openEditWechatModal() {
    this.setData({
      showWechatModal: true,
      editWechatId: this.data.videoAuditGuide.wechatId || '',
      editRemarkTemplate: this.data.videoAuditGuide.remarkTemplate || ''
    })
  },
  closeEditWechatModal() {
    this.setData({ showWechatModal: false })
  },
  inputEditWechatId(e) {
    this.setData({ editWechatId: e.detail.value })
  },
  inputEditRemark(e) {
    this.setData({ editRemarkTemplate: e.detail.value })
  },
  saveWechatConfig() {
    const wechatId = (this.data.editWechatId || '').trim()
    if (!wechatId) {
      wx.showToast({ title: '请输入微信号', icon: 'none' })
      return
    }
    this.setData({ savingWechat: true })
    callFunction('admin', 'updateVideoAuditGuide', {
      guide: {
        wechatId,
        remarkTemplate: (this.data.editRemarkTemplate || '').trim() || '宠托师审核 + 姓名 + 手机号'
      }
    })
      .then((res) => {
        this.setData({
          savingWechat: false,
          showWechatModal: false,
          videoAuditGuide: res.videoAuditGuide || {
            wechatId,
            remarkTemplate: this.data.editRemarkTemplate
          }
        })
        wx.showToast({ title: '审核微信配置已更新', icon: 'success' })
      })
      .catch((err) => {
        this.setData({ savingWechat: false })
        showError(err)
      })
  },
  noop() {},
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
