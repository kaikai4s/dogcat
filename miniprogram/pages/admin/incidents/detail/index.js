const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { withIncidentText } = require('../../../../utils/format')

const statusOptions = [
  { label: '待处理', value: 'open' },
  { label: '分诊中', value: 'triaging' },
  { label: '待客户补充', value: 'waiting_client' },
  { label: '待宠托师补充', value: 'waiting_staff' },
  { label: '处理中', value: 'processing' },
  { label: '退款处理中', value: 'refund_pending' },
  { label: '已解决', value: 'resolved' },
  { label: '已驳回', value: 'rejected' },
  { label: '已关闭', value: 'closed' }
]

const resolutionOptions = [
  { label: '部分退款', value: 'refund' },
  { label: '优惠补偿', value: 'coupon' },
  { label: '解释说明', value: 'explain' },
  { label: '驳回诉求', value: 'reject' }
]

function decorate(detail = {}) {
  const incident = detail.incident || {}
  return {
    ...detail,
    incident: withIncidentText({
      ...incident,
      mediaFileIds: Array.isArray(incident.mediaFileIds) ? incident.mediaFileIds : [],
      frozenEarningIds: Array.isArray(incident.frozenEarningIds) ? incident.frozenEarningIds : []
    }),
    comments: (detail.comments || []).map((item) => ({ ...item, mediaFileIds: Array.isArray(item.mediaFileIds) ? item.mediaFileIds : [] })),
    actions: detail.actions || []
  }
}

Page({
  data: {
    id: '',
    detail: null,
    statusOptions,
    resolutionOptions,
    statusIndex: 0,
    resolutionIndex: 0,
    statusRemark: '',
    resolutionContent: '',
    refundAmount: '',
    comment: '',
    payRemark: '',
    submitting: false,
    sectionHomeUrl: '',
    canGoBack: false
  },

  onLoad(q) {
    this.setData({ ...createPageNav(q), id: q.id || q.incidentId || '' })
    this.load()
  },

  load() {
    callFunction('incident', 'getIncidentDetail', { incidentId: this.data.id })
      .then((detail) => {
        const decorated = decorate(detail)
        const statusIndex = this.data.statusOptions.findIndex((item) => item.value === decorated.incident.status)
        this.setData({ detail: decorated, statusIndex: statusIndex >= 0 ? statusIndex : 0 })
      })
      .catch(showError)
  },

  chooseStatus(e) {
    this.setData({ statusIndex: Number(e.detail.value || 0) })
  },

  chooseResolution(e) {
    this.setData({ resolutionIndex: Number(e.detail.value || 0) })
  },

  inputStatusRemark(e) {
    this.setData({ statusRemark: e.detail.value || '' })
  },

  inputResolution(e) {
    this.setData({ resolutionContent: e.detail.value || '' })
  },

  inputRefundAmount(e) {
    this.setData({ refundAmount: e.detail.value || '' })
  },

  inputComment(e) {
    this.setData({ comment: e.detail.value || '' })
  },

  setStatus() {
    const option = this.data.statusOptions[this.data.statusIndex] || this.data.statusOptions[0]
    callFunction('incident', 'updateIncidentStatus', { incidentId: this.data.id, status: option.value, remark: this.data.statusRemark })
      .then(() => {
        wx.showToast({ title: '状态已更新', icon: 'none' })
        this.setData({ statusRemark: '' })
        this.load()
      })
      .catch(showError)
  },

  proposeResolution() {
    const option = this.data.resolutionOptions[this.data.resolutionIndex] || this.data.resolutionOptions[0]
    callFunction('incident', 'proposeResolution', {
      incidentId: this.data.id,
      resolutionType: option.value,
      content: this.data.resolutionContent,
      refundAmount: Number(this.data.refundAmount || 0)
    })
      .then(() => {
        wx.showToast({ title: '方案已保存', icon: 'none' })
        this.setData({ resolutionContent: '', refundAmount: '' })
        this.load()
      })
      .catch(showError)
  },

  freezeEarning() {
    wx.showModal({
      title: '冻结收益',
      content: '确认冻结该订单关联的宠托师收益？',
      success: (res) => {
        if (!res.confirm) return
        callFunction('incident', 'freezeStaffEarning', { incidentId: this.data.id })
          .then(() => {
            wx.showToast({ title: '已冻结', icon: 'none' })
            this.load()
          })
          .catch(showError)
      }
    })
  },

  submitComment() {
    if (this.data.submitting) return
    this.setData({ submitting: true })
    callFunction('incident', 'appendIncidentComment', { incidentId: this.data.id, content: this.data.comment })
      .then(() => {
        wx.showToast({ title: '已留言', icon: 'none' })
        this.setData({ comment: '', submitting: false })
        this.load()
      })
      .catch((error) => {
        this.setData({ submitting: false })
        showError(error)
      })
  },

  closeResolved() {
    this.closeIncident('resolved')
  },

  closeRejected() {
    this.closeIncident('rejected')
  },

  closeIncident(status) {
    callFunction('incident', 'closeIncident', { incidentId: this.data.id, status, closeRemark: this.data.statusRemark })
      .then(() => {
        wx.showToast({ title: '已结案', icon: 'none' })
        this.load()
      })
      .catch(showError)
  },

  goOrder() {
    if (!this.data.detail || !this.data.detail.incident.orderId) return
    wx.navigateTo({ url: `/pages/admin/orders/detail/index?id=${this.data.detail.incident.orderId}` })
  },

  ...navMethods()
})
