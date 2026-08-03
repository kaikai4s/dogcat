const { callFunction, showError } = require('../../../utils/cloud')

function emptyLevel() {
  return { name: '', minPoints: 0, icon: '', pointMultiplier: 1, description: '', benefitsText: '', sortOrder: 0 }
}

Page({
  data: {
    levels: [],
    form: emptyLevel()
  },

  onShow() {
    this.load()
  },

  load() {
    callFunction('admin', 'listMemberLevels')
      .then((levels) => this.setData({ levels }))
      .catch(showError)
  },

  input(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ ['form.' + field]: e.detail.value })
  },

  chooseLevel(e) {
    const level = this.data.levels[e.currentTarget.dataset.index]
    if (!level) return
    this.setData({
      form: {
        ...level,
        pointMultiplier: Number(level.pointMultiplier || 1),
        description: level.description || '',
        benefitsText: Array.isArray(level.benefits) ? level.benefits.join('\n') : ''
      }
    })
  },

  resetForm() {
    this.setData({ form: emptyLevel() })
  },

  save() {
    const form = this.data.form
    if (!form.name) return wx.showToast({ title: '请填写等级名称', icon: 'none' })
    callFunction('admin', 'saveMemberLevel', {
      ...form,
      minPoints: Number(form.minPoints || 0),
      pointMultiplier: Number(form.pointMultiplier || 1),
      benefits: String(form.benefitsText || '').split(/\n+/).map((item) => item.trim()).filter(Boolean),
      sortOrder: Number(form.sortOrder || 0)
    })
      .then(() => {
        wx.showToast({ title: '已保存' })
        this.resetForm()
        this.load()
      })
      .catch(showError)
  },

  deleteLevel(e) {
    const level = this.data.levels[e.currentTarget.dataset.index]
    if (!level) return
    wx.showModal({
      title: '确认删除',
      content: `删除等级「${level.name}」？`,
      success: (res) => {
        if (!res.confirm) return
        callFunction('admin', 'deleteMemberLevel', { _id: level._id })
          .then(() => this.load())
          .catch(showError)
      }
    })
  },

  go(e) {
    wx.navigateTo({ url: e.currentTarget.dataset.url })
  }
})
