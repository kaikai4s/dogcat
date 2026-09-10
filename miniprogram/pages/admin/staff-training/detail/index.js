const { callFunction, showError } = require('../../../../utils/cloud')
const { formatDateTime, withStaffWorkflowText } = require('../../../../utils/format')

Page({
  data: { id: '', profile: null, remark: '' },
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
  inputRemark(e) { this.setData({ remark: e.detail.value }) },
  audit(e) {
    const status = e.currentTarget.dataset.status
    wx.showModal({
      title: status === 'approved' ? '通过视频审核' : '拒绝视频审核',
      content: status === 'approved' ? '确认该宠托师已完成微信视频审核并成为实习宠托师？' : '确认拒绝本次视频审核？',
      success: (res) => {
        if (!res.confirm) return
        callFunction('admin', 'auditTrainingVideo', { staffProfileId: this.data.id, status, remark: this.data.remark })
          .then(() => { wx.showToast({ title: '已处理', icon: 'none' }); wx.navigateBack() })
          .catch(showError)
      }
    })
  }
})
