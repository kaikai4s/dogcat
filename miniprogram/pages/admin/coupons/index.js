const { callFunction, showError } = require('../../../utils/cloud')

function emptyTemplate() {
  return { name: '', description: '', discountAmount: 20, minOrderAmount: 80, validDays: 30, perUserLimit: 1, totalIssueLimit: 0, enabled: true, sortOrder: 100, applicableServiceTypes: [] }
}

Page({
  data: {
    templates: [],
    form: emptyTemplate(),
    issue: { templateId: '', openid: '' }
  },

  onShow() {
    this.load()
  },

  load() {
    callFunction('admin', 'listCouponTemplates')
      .then((templates) => this.setData({ templates, ['issue.templateId']: this.data.issue.templateId || templates[0]?._id || '' }))
      .catch(showError)
  },

  input(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ ['form.' + field]: e.detail.value })
  },

  issueInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ ['issue.' + field]: e.detail.value })
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
    if (template) this.setData({ ['issue.templateId']: template._id })
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
    callFunction('admin', 'issueCouponToUser', this.data.issue)
      .then(() => {
        wx.showToast({ title: '已发券' })
        this.setData({ ['issue.openid']: '' })
        this.load()
      })
      .catch(showError)
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  }
})
