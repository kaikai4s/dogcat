const { callFunction, showError } = require('../../../../utils/cloud')
const { formatDateTime, withStaffWorkflowText } = require('../../../../utils/format')

Page({
  data: { id: '', profile: null, remark: '', showAuditModal: false, auditStatus: '', expanded: { training: true, guide: false } },
  onLoad(q) { this.setData({ id: q.id || '' }); this.load() },
  load() {
    callFunction('admin', 'listTrainingAudits', { page: 1, pageSize: 100 })
      .then((res) => {
        const list = Array.isArray(res) ? res : (res.list || [])
        const profile = withStaffWorkflowText(list.find((item) => item._id === this.data.id))
        if (!profile) { wx.showToast({ title: '记录不存在或已处理', icon: 'none' }); return }
        this.setData({ profile: { ...profile, quizPassedAtText: formatDateTime(profile.quizPassedAt), videosCompletedAtText: formatDateTime(profile.trainingVideosCompletedAt), requestedAtText: formatDateTime(profile.videoAuditRequestedAt) } })
      })
      .catch(showError)
  },
  noop() {},
  inputRemark(e) { this.setData({ remark: e.detail.value }) },
  toggleSection(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    this.setData({ [`expanded.${key}`]: !this.data.expanded[key] })
  },
  openAuditModal(e) {
    this.setData({ auditStatus: e.currentTarget.dataset.status, showAuditModal: true })
  },
  closeAuditModal() {
    this.setData({ showAuditModal: false, auditStatus: '', remark: '' })
  },
  audit() {
    const status = this.data.auditStatus
    if (!status) return
    callFunction('admin', 'auditTrainingVideo', { staffProfileId: this.data.id, status, remark: this.data.remark })
      .then(() => { wx.showToast({ title: '已处理', icon: 'none' }); wx.navigateBack() })
      .catch(showError)
  }
})
