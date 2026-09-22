const { callFunction, showError } = require('../../../utils/cloud')

function emptyActivity() {
  return { _id: '', name: '', description: '', enabled: true, prizes: [] }
}

function emptyPrize(type = 'text', defaultTemplate = null) {
  if (type === 'points') {
    return {
      type: 'points',
      name: '20 积分',
      text: '',
      points: 20,
      templateId: '',
      couponName: '',
      probability: 20,
      stockLeft: 100
    }
  }
  if (type === 'coupon') {
    return {
      type: 'coupon',
      name: defaultTemplate ? defaultTemplate.name : '',
      text: '',
      points: 0,
      templateId: defaultTemplate ? defaultTemplate._id : '',
      couponName: defaultTemplate ? defaultTemplate.name : '',
      probability: 20,
      stockLeft: 100
    }
  }
  return {
    type: 'text',
    name: '谢谢参与',
    text: '谢谢参与',
    points: 0,
    templateId: '',
    couponName: '',
    probability: 20,
    stockLeft: 9999
  }
}

function normalizePrizeItem(p = {}) {
  const type = ['text', 'points', 'coupon'].includes(p.type)
    ? p.type
    : (p.templateId ? 'coupon' : (Number(p.points) > 0 ? 'points' : 'text'))
  const points = type === 'points' ? Math.max(Math.round(Number(p.points || 0)), 0) : 0
  const templateId = type === 'coupon' ? String(p.templateId || '').trim() : ''
  const text = type === 'text' ? String(p.text || p.name || '谢谢参与').trim() : ''
  let name = String(p.name || '').trim()
  if (!name) {
    if (type === 'points') name = `${points} 积分`
    else if (type === 'text') name = text || '谢谢参与'
    else name = '优惠券'
  }
  return {
    type,
    name,
    text,
    points,
    templateId,
    couponName: String(p.couponName || '').trim(),
    probability: Number(p.probability || 0),
    stockLeft: Math.max(Math.round(Number(p.stockLeft || 0)), 0)
  }
}

function calcTotalProbability(prizes = []) {
  return (prizes || []).reduce((sum, item) => sum + Number(item.probability || 0), 0)
}

Page({
  data: {
    activities: [],
    templates: [],
    showModal: false,
    modalTitle: '新建抽奖活动',
    form: emptyActivity(),
    newPrize: emptyPrize('text'),
    totalProbability: 0,
    selectedTemplateIndex: 0
  },

  onShow() {
    this.load()
  },

  load() {
    callFunction('admin', 'listLotteryActivities')
      .then((activities) => {
        const list = (activities || []).map((act) => ({
          ...act,
          prizes: (act.prizes || []).map(normalizePrizeItem)
        }))
        this.setData({ activities: list })
      })
      .catch(showError)
    callFunction('admin', 'listCouponTemplates')
      .then((templates) => this.setData({ templates: templates || [] }))
      .catch(showError)
  },

  input(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ ['form.' + field]: e.detail.value })
  },

  toggleFormEnabled(e) {
    this.setData({ ['form.enabled']: e.detail.value })
  },

  openCreateModal() {
    const defaultTmpl = this.data.templates[0] || null
    const form = emptyActivity()
    this.setData({
      showModal: true,
      modalTitle: '新建抽奖活动',
      form,
      newPrize: emptyPrize('text', defaultTmpl),
      totalProbability: 0,
      selectedTemplateIndex: 0
    })
  },

  openEditModal(e) {
    const index = Number(e.currentTarget.dataset.index)
    const activity = this.data.activities[index]
    if (!activity) return
    const prizes = (activity.prizes || []).map(normalizePrizeItem)
    const form = {
      _id: activity._id,
      name: activity.name || '',
      description: activity.description || '',
      enabled: activity.enabled !== false,
      prizes
    }
    const defaultTmpl = this.data.templates[0] || null
    this.setData({
      showModal: true,
      modalTitle: '编辑抽奖活动',
      form,
      newPrize: emptyPrize('text', defaultTmpl),
      totalProbability: calcTotalProbability(prizes),
      selectedTemplateIndex: 0
    })
  },

  // 兼容原有事件绑定名称
  chooseActivity(e) {
    this.openEditModal(e)
  },

  closeModal() {
    this.setData({ showModal: false })
  },

  setPrizeType(e) {
    const type = e.currentTarget.dataset.type || 'text'
    const defaultTmpl = this.data.templates[0] || null
    const base = emptyPrize(type, defaultTmpl)
    this.setData({ newPrize: base })
  },

  prizeInput(e) {
    const field = e.currentTarget.dataset.field
    const val = e.detail.value
    const updates = { ['newPrize.' + field]: val }
    if (field === 'points' && this.data.newPrize.type === 'points') {
      updates['newPrize.name'] = `${val || 0} 积分`
    } else if (field === 'text' && this.data.newPrize.type === 'text') {
      updates['newPrize.name'] = val || '谢谢参与'
    }
    this.setData(updates)
  },

  choosePrizeTemplate(e) {
    const index = Number(e.detail.value)
    const template = this.data.templates[index]
    if (template) {
      this.setData({
        selectedTemplateIndex: index,
        ['newPrize.templateId']: template._id,
        ['newPrize.couponName']: template.name,
        ['newPrize.name']: template.name
      })
    }
  },

  addPrize() {
    const prize = this.data.newPrize
    const name = String(prize.name || '').trim()
    if (!name) {
      return wx.showToast({ title: '请填写奖品名称', icon: 'none' })
    }
    const prob = Number(prize.probability || 0)
    if (prob <= 0 || prob > 100) {
      return wx.showToast({ title: '概率需在 1% ~ 100% 之间', icon: 'none' })
    }
    if (prize.type === 'coupon' && !prize.templateId) {
      return wx.showToast({ title: '请选择关联的优惠券', icon: 'none' })
    }
    if (prize.type === 'points' && Number(prize.points || 0) <= 0) {
      return wx.showToast({ title: '赠送积分需大于 0', icon: 'none' })
    }

    const item = normalizePrizeItem({
      ...prize,
      name,
      probability: prob,
      stockLeft: Math.max(Math.round(Number(prize.stockLeft || 0)), 0)
    })

    const prizes = [...(this.data.form.prizes || []), item]
    const total = calcTotalProbability(prizes)
    const defaultTmpl = this.data.templates[0] || null
    this.setData({
      ['form.prizes']: prizes,
      totalProbability: total,
      newPrize: emptyPrize(prize.type, defaultTmpl)
    })
    wx.showToast({ title: '奖品已添加', icon: 'success' })
  },

  removePrize(e) {
    const index = Number(e.currentTarget.dataset.index)
    const prizes = this.data.form.prizes.filter((_, i) => i !== index)
    this.setData({
      ['form.prizes']: prizes,
      totalProbability: calcTotalProbability(prizes)
    })
  },

  save() {
    const form = this.data.form
    const name = String(form.name || '').trim()
    if (!name) return wx.showToast({ title: '请填写活动名称', icon: 'none' })
    const prizes = form.prizes || []
    if (!prizes.length) return wx.showToast({ title: '请至少添加一个奖品', icon: 'none' })

    const total = calcTotalProbability(prizes)
    if (total !== 100) {
      return wx.showToast({ title: `概率合计 ${total}%，需等于 100%`, icon: 'none' })
    }

    wx.showLoading({ title: '保存中...', mask: true })
    callFunction('admin', 'saveLotteryActivity', form)
      .then(() => {
        wx.hideLoading()
        wx.showToast({ title: '已保存活动' })
        this.closeModal()
        this.load()
      })
      .catch((err) => {
        wx.hideLoading()
        showError(err)
      })
  },

  toggle(e) {
    const index = Number(e.currentTarget.dataset.index)
    const activity = this.data.activities[index]
    if (!activity) return
    callFunction('admin', 'toggleLotteryActivity', { _id: activity._id })
      .then(() => this.load())
      .catch(showError)
  },

  deleteActivity(e) {
    const index = Number(e.currentTarget.dataset.index)
    const activity = this.data.activities[index]
    if (!activity) return
    wx.showModal({
      title: '确认删除抽奖活动',
      content: `确定删除抽奖活动「${activity.name}」吗？\n删除后用户将无法再参与该抽奖，历史中奖记录与已发放资产不受影响。`,
      confirmColor: '#ef4444',
      confirmText: '确认删除',
      success: (res) => {
        if (!res.confirm) return
        wx.showLoading({ title: '删除中...', mask: true })
        callFunction('admin', 'deleteLotteryActivity', { _id: activity._id })
          .then(() => {
            wx.hideLoading()
            wx.showToast({ title: '已删除活动' })
            if (this.data.form._id === activity._id) {
              this.closeModal()
            }
            this.load()
          })
          .catch((err) => {
            wx.hideLoading()
            showError(err)
          })
      }
    })
  }
})
