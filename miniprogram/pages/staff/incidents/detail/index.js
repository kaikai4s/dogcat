const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { withIncidentText } = require('../../../../utils/format')
const { applyTheme, getThemeState } = require('../../../../utils/theme')

function uploadEvidence(filePath) {
  const ext = filePath.includes('.') ? filePath.substring(filePath.lastIndexOf('.')) : '.jpg'
  return new Promise((resolve, reject) => {
    wx.cloud.uploadFile({
      cloudPath: `incidents/${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`,
      filePath,
      success: (res) => resolve(res.fileID),
      fail: reject
    })
  })
}

function decorate(detail = {}) {
  const incident = detail.incident || {}
  return {
    ...detail,
    incident: withIncidentText({ ...incident, mediaFileIds: Array.isArray(incident.mediaFileIds) ? incident.mediaFileIds : [] }),
    comments: (detail.comments || []).map((item) => ({ ...item, mediaFileIds: Array.isArray(item.mediaFileIds) ? item.mediaFileIds : [] }))
  }
}

Page({
  data: {
    themeClass: 'theme-day',
    id: '',
    detail: null,
    comment: '',
    mediaFileIds: [],
    submitting: false,
    sectionHomeUrl: '',
    canGoBack: false
  },

  onLoad(q) {
    this.setData({ ...createPageNav(q), id: q.id || q.incidentId || '' })
  },

  onShow() {
    this.applyCurrentTheme()
    this.load()
  },

  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },

  load() {
    callFunction('incident', 'getIncidentDetail', { incidentId: this.data.id })
      .then((detail) => this.setData({ detail: decorate(detail) }))
      .catch(showError)
  },

  inputComment(e) { this.setData({ comment: e.detail.value || '' }) },

  chooseEvidence() {
    wx.chooseMedia({
      count: Math.max(1, 9 - this.data.mediaFileIds.length),
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const files = (res.tempFiles || []).map((item) => item.tempFilePath).filter(Boolean)
        this.setData({ mediaFileIds: this.data.mediaFileIds.concat(files).slice(0, 9) })
      }
    })
  },

  removeEvidence(e) {
    const index = Number(e.currentTarget.dataset.index)
    this.setData({ mediaFileIds: this.data.mediaFileIds.filter((_, i) => i !== index) })
  },

  submitComment() {
    if (this.data.submitting) return
    this.setData({ submitting: true })
    Promise.all(this.data.mediaFileIds.map(uploadEvidence))
      .then((mediaFileIds) => callFunction('incident', 'appendIncidentComment', {
        incidentId: this.data.id,
        content: this.data.comment,
        mediaFileIds
      }))
      .then(() => {
        wx.showToast({ title: '已提交', icon: 'none' })
        this.setData({ comment: '', mediaFileIds: [], submitting: false })
        this.load()
      })
      .catch((error) => {
        this.setData({ submitting: false })
        showError(error)
      })
  },

  goOrder() {
    if (!this.data.detail || !this.data.detail.incident.orderId) return
    wx.navigateTo({ url: `/pages/staff/orders/detail/index?id=${this.data.detail.incident.orderId}` })
  },

  ...navMethods()
})
