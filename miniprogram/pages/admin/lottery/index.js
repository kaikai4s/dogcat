const { callFunction, showError } = require('../../../utils/cloud')

function emptyActivity() {
  return { name: '', description: '', enabled: false, prizes: [] }
}

function emptyPrize() {
  return { templateId: '', name: '', probability: 10, stockLeft: 100 }
}

Page({
  data: {
    activities: [],
    templates: [],
    form: emptyActivity(),
    newPrize: emptyPrize()
  },

  onShow() {
    this.load()
  },

  load() {
    callFunction('admin', 'listLotteryActivities')
      .then((activities) => this.setData({ activities }))
      .catch(showError)
    callFunction('admin', 'listCouponTemplates')
      .then((templates) => this.setData({ templates }))
      .catch(showError)
  },

  input(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ ['form.' + field]: e.detail.value })
  },

  prizeInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ ['newPrize.' + field]: e.detail.value })
  },

  chooseActivity(e) {
    const activity = this.data.activities[e.currentTarget.dataset.index]
    if (!activity) return
    this.setData({ form: { ...activity, prizes: activity.prizes.map((p) => ({ ...p })) } })
  },

  resetForm() {
    this.setData({ form: emptyActivity(), newPrize: emptyPrize() })
  },

  choosePrizeTemplate(e) {
    const template = this.data.templates[e.detail.value]
    if (template) this.setData({ ['newPrize.templateId']: template._id, ['newPrize.name']: template.name })
  },

  addPrize() {
    const prize = this.data.newPrize
    if (!prize.name) return wx.showToast({ title: '请填写奖品名称', icon: 'none' })
    const prizes = [...this.data.form.prizes, {
      ...prize,
      probability: Number(prize.probability || 0),
      stockLeft: Math.round(Number(prize.stockLeft || 0))
    }]
    this.setData({ ['form.prizes']: prizes, newPrize: emptyPrize() })
  },

  removePrize(e) {
    const prizes = this.data.form.prizes.filter((_, i) => i !== e.currentTarget.dataset.index)
    this.setData({ ['form.prizes']: prizes })
  },

  save() {
    if (!this.data.form.name) return wx.showToast({ title: '请填写活动名称', icon: 'none' })
    const prizes = this.data.form.prizes
    if (prizes.length > 0) {
      const total = prizes.reduce((sum, p) => sum + Number(p.probability || 0), 0)
      if (total !== 100) return wx.showToast({ title: `概率合计 ${total}%，需等于 100%`, icon: 'none' })
    }
    callFunction('admin', 'saveLotteryActivity', this.data.form)
      .then(() => {
        wx.showToast({ title: '已保存' })
        this.resetForm()
        this.load()
      })
      .catch(showError)
  },

  toggle(e) {
    const activity = this.data.activities[e.currentTarget.dataset.index]
    if (!activity) return
    callFunction('admin', 'toggleLotteryActivity', { _id: activity._id })
      .then(() => this.load())
      .catch(showError)
  }
})
