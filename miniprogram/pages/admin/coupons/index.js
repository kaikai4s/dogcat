const { callFunction, showError } = require('../../../utils/cloud')

function emptyTemplate() {
  return { name: '', description: '', discountAmount: 20, minOrderAmount: 80, validDays: 30, perUserLimit: 1, totalIssueLimit: 0, enabled: true, sortOrder: 100, applicableServiceTypes: [] }
}

Page({
  data: {
    templates: [],
    levels: [],
    form: emptyTemplate(),
    issueByLevel: { templateId: '', targetLevels: [] },
    issueByOpenid: { templateId: '', openid: '' },
    issueMode: 'level'
  },

  onShow() {
    this.load()
  },

  load() {
    callFunction('admin', 'listCouponTemplates')
      .then((templates) => {
        const first = templates[0]?._id || ''
        this.setData({
          templates,
          ['issueByLevel.templateId']: this.data.issueByLevel.templateId || first,
          ['issueByOpenid.templateId']: this.data.issueByOpenid.templateId || first
        })
      })
      .catch(showError)
    callFunction('admin', 'listMemberLevels')
      .then((levels) => this.setData({ levels }))
      .catch(showError)
  },

  input(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ ['form.' + field]: e.detail.value })
  },

  toggleEnabled(e) {
    this.setData({ ['form.enabled']: e.detail.value })
  },

  chooseTemplate(e) {
    const template = this.data.templates[e.currentTarget.dataset.index]
    if (!template) return
    this.setData({ form: { ...template } })
  },

  chooseIssueTemplate(e) {
    const template = this.data.templates[e.detail.value]
    if (!template) return
    const mode = this.data.issueMode
    if (mode === 'level') this.setData({ ['issueByLevel.templateId']: template._id })
    else this.setData({ ['issueByOpenid.templateId']: template._id })
  },

  switchIssueMode(e) {
    this.setData({ issueMode: e.currentTarget.dataset.mode })
  },

  toggleLevel(e) {
    const levelName = e.currentTarget.dataset.name
    const current = this.data.issueByLevel.targetLevels || []
    const next = current.includes(levelName)
      ? current.filter((n) => n !== levelName)
      : [...current, levelName]
    this.setData({ ['issueByLevel.targetLevels']: next })
  },

  openidInput(e) {
    this.setData({ ['issueByOpenid.openid']: e.detail.value })
  },

  resetForm() {
    this.setData({ form: emptyTemplate() })
  },

  saveTemplate() {
    callFunction('admin', 'saveCouponTemplate', this.data.form)
      .then(() => {
        wx.showToast({ title: '已保存' })
        this.resetForm()
        this.load()
      })
      .catch(showError)
  },

  issueCoupon() {
    if (this.data.issueMode === 'level') {
      const { templateId, targetLevels } = this.data.issueByLevel
      if (!templateId) return wx.showToast({ title: '请选择模板', icon: 'none' })
      if (!targetLevels.length) return wx.showToast({ title: '请选择会员段位', icon: 'none' })
      callFunction('admin', 'issueCouponByLevels', { templateId, targetLevels })
        .then((res) => {
          wx.showToast({ title: `已发放 ${res.issued} 张，跳过 ${res.skipped}` , icon: 'none' })
          this.setData({ ['issueByLevel.targetLevels']: [] })
          this.load()
        })
        .catch(showError)
    } else {
      const { templateId, openid } = this.data.issueByOpenid
      if (!templateId) return wx.showToast({ title: '请选择模板', icon: 'none' })
      if (!openid) return wx.showToast({ title: '请输入 openid', icon: 'none' })
      callFunction('admin', 'issueCouponToUser', { templateId, openid })
        .then(() => {
          wx.showToast({ title: '已发券' })
          this.setData({ ['issueByOpenid.openid']: '' })
          this.load()
        })
        .catch(showError)
    }
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.navigateTo({ url })
  }
})
