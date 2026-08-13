const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')

const typeOptions = [
  { label: '服务问题', value: 'service_issue' },
  { label: '退款争议', value: 'refund_dispute' },
  { label: '安全问题', value: 'safety' },
  { label: '其他投诉', value: 'complaint' }
]

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

Page({
  data: {
    orderId: '',
    typeOptions,
    typeIndex: 0,
    title: '',
    description: '',
    mediaFileIds: [],
    submitting: false,
    sectionHomeUrl: '',
    canGoBack: false
  },

  onLoad(q) {
    this.setData({ ...createPageNav(q), orderId: q.id || q.orderId || '' })
  },

  chooseType(e) {
    this.setData({ typeIndex: Number(e.detail.value || 0) })
  },

  inputTitle(e) {
    this.setData({ title: e.detail.value || '' })
  },

  inputDescription(e) {
    this.setData({ description: e.detail.value || '' })
  },

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

  submit() {
    if (this.data.submitting) return
    const option = this.data.typeOptions[this.data.typeIndex] || this.data.typeOptions[0]
    this.setData({ submitting: true })
    Promise.all(this.data.mediaFileIds.map(uploadEvidence))
      .then((mediaFileIds) => callFunction('incident', 'createComplaint', {
        orderId: this.data.orderId,
        incidentType: option.value,
        title: this.data.title,
        description: this.data.description,
        mediaFileIds
      }))
      .then((incident) => {
        wx.showToast({ title: '已提交', icon: 'none' })
        wx.redirectTo({ url: `/pages/client/incidents/detail/index?id=${incident._id}` })
      })
      .catch((error) => {
        this.setData({ submitting: false })
        showError(error)
      })
  },

  ...navMethods()
})
