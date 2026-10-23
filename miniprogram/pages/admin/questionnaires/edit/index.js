const { optionalAdminRead } = require('../../utils/admin-page-read')
const { callFunction, showError } = require('../../../../utils/cloud')

const TYPE_MAP = {
  single: '单选',
  multiple: '多选',
  rating: '评分',
  short_text: '短文本',
  long_text: '长文本'
}

const OPTION_PRESETS = {
  satisfaction: '非常满意\n满意\n一般\n不满意\n非常不满意',
  nps: '强烈推荐\n比较推荐\n中立观望\n不太推荐\n绝不推荐',
  yesno: '是\n否'
}

function emptyQuestion(index = 0) {
  return {
    id: `q_${Date.now()}_${index}`,
    type: 'single',
    typeName: '单选',
    title: '',
    required: true,
    optionsText: '非常满意\n满意\n一般\n不满意',
    max: 5,
    placeholder: ''
  }
}

function emptyForm() {
  return {
    title: '',
    description: '',
    targetClient: true,
    targetStaff: false,
    rewardEnabled: false,
    rewardPoints: 0,
    couponTemplateId: '',
    questions: [emptyQuestion(1)]
  }
}

function toForm(item) {
  const roles = new Set(item.targetRoles || [])
  const reward = item.rewardConfig || {}
  return {
    title: item.title || '',
    description: item.description || '',
    targetClient: roles.has('client'),
    targetStaff: roles.has('staff'),
    rewardEnabled: !!reward.enabled,
    rewardPoints: Number(reward.points || 0),
    couponTemplateId: reward.couponTemplateId || '',
    questions: (item.questions || []).map(q => ({
      ...q,
      typeName: TYPE_MAP[q.type] || q.type || '单选',
      optionsText: (q.options || []).join('\n')
    }))
  }
}

function buildPayload(form) {
  const targetRoles = []
  if (form.targetClient) targetRoles.push('client')
  if (form.targetStaff) targetRoles.push('staff')
  return {
    title: form.title,
    description: form.description,
    targetRoles,
    rewardConfig: {
      enabled: form.rewardEnabled,
      points: Number(form.rewardPoints || 0),
      couponTemplateId: form.couponTemplateId
    },
    questions: (form.questions || []).map((q, index) => ({
      id: q.id || `q_${index + 1}`,
      type: q.type,
      title: q.title,
      required: q.required !== false,
      options: String(q.optionsText || '').split('\n').map(item => item.trim()).filter(Boolean),
      max: Number(q.max || 5),
      placeholder: q.placeholder || ''
    }))
  }
}

Page({
  data: {
    id: '',
    form: emptyForm(),
    couponTemplates: [],
    couponNames: ['不发放优惠券'],
    couponIndex: 0,
    typeNames: ['单选', '多选', '评分', '短文本', '长文本'],
    typeValues: ['single', 'multiple', 'rating', 'short_text', 'long_text'],
    savingDraft: false,
    publishing: false
  },

  onLoad(query) {
    const id = query.id || ''
    this.setData({ id })
    this.loadCoupons()
    if (id) this.loadDetail(id)
  },

  loadCoupons() {
    optionalAdminRead(this, 'admin', 'listCouponTemplates')
      .then((list) => {
        const templates = list || []
        const names = ['不发放优惠券'].concat(templates.map(item => {
          const discountDesc = item.discountType === 'fixed' ? `减¥${item.discountValue}` : `${item.discountValue}折`
          return `${item.name || '优惠券'} (${discountDesc})`
        }))
        this.setData({ couponTemplates: templates, couponNames: names })
        this.syncCouponIndex()
      })
      .catch(() => {})
  },

  loadDetail(id) {
    callFunction('questionnaire', 'detailAdmin', { id })
      .then((item) => {
        this.setData({ form: toForm(item) })
        this.syncCouponIndex()
      })
      .catch(showError)
  },

  syncCouponIndex() {
    const id = this.data.form.couponTemplateId
    const idx = this.data.couponTemplates.findIndex(item => item._id === id)
    this.setData({ couponIndex: idx >= 0 ? idx + 1 : 0 })
  },

  input(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [`form.${field}`]: e.detail.value })
  },

  toggle(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [`form.${field}`]: e.detail.value })
  },

  inputQuestion(e) {
    const index = e.currentTarget.dataset.index
    const field = e.currentTarget.dataset.field
    this.setData({ [`form.questions[${index}].${field}`]: e.detail.value })
  },

  toggleQuestion(e) {
    const index = e.currentTarget.dataset.index
    this.setData({ [`form.questions[${index}].required`]: e.detail.value })
  },

  changeType(e) {
    const index = e.currentTarget.dataset.index
    const type = this.data.typeValues[Number(e.detail.value || 0)]
    this.setData({
      [`form.questions[${index}].type`]: type,
      [`form.questions[${index}].typeName`]: TYPE_MAP[type] || type
    })
  },

  selectQuestionType(e) {
    const index = Number(e.currentTarget.dataset.index)
    const type = e.currentTarget.dataset.type
    this.setData({
      [`form.questions[${index}].type`]: type,
      [`form.questions[${index}].typeName`]: TYPE_MAP[type] || type
    })
  },

  appendOtherOption(e) {
    const index = Number(e.currentTarget.dataset.index)
    const q = this.data.form.questions[index]
    const currentText = String(q.optionsText || '').trim()
    const lines = currentText ? currentText.split('\n').map(s => s.trim()).filter(Boolean) : []
    if (lines.includes('其他')) {
      wx.showToast({ title: '选项中已包含「其他」', icon: 'none' })
      return
    }
    lines.push('其他')
    this.setData({
      [`form.questions[${index}].optionsText`]: lines.join('\n')
    })
    wx.showToast({ title: '已追加「其他」选项', icon: 'success' })
  },

  changeCoupon(e) {
    const index = Number(e.detail.value || 0)
    const template = this.data.couponTemplates[index - 1]
    this.setData({ couponIndex: index, 'form.couponTemplateId': template ? template._id : '' })
  },

  applyPreset(e) {
    const index = e.currentTarget.dataset.index
    const presetKey = e.currentTarget.dataset.preset
    const text = OPTION_PRESETS[presetKey]
    if (text) {
      this.setData({ [`form.questions[${index}].optionsText`]: text })
      wx.showToast({ title: '已应用选项预设', icon: 'none' })
    }
  },

  addQuestion() {
    const questions = this.data.form.questions.concat(emptyQuestion(this.data.form.questions.length + 1))
    this.setData({ 'form.questions': questions })
    wx.pageScrollTo({ scrollTop: 99999, duration: 300 })
  },

  cloneQuestion(e) {
    const index = Number(e.currentTarget.dataset.index)
    const original = this.data.form.questions[index]
    const cloned = {
      ...original,
      id: `q_${Date.now()}_${index + 1}`,
      title: original.title ? `${original.title} (副本)` : ''
    }
    const questions = [...this.data.form.questions]
    questions.splice(index + 1, 0, cloned)
    this.setData({ 'form.questions': questions })
    wx.showToast({ title: '已复制题目', icon: 'none' })
  },

  moveUp(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (index <= 0) return
    const questions = [...this.data.form.questions]
    const temp = questions[index]
    questions[index] = questions[index - 1]
    questions[index - 1] = temp
    this.setData({ 'form.questions': questions })
  },

  moveDown(e) {
    const index = Number(e.currentTarget.dataset.index)
    const questions = [...this.data.form.questions]
    if (index >= questions.length - 1) return
    const temp = questions[index]
    questions[index] = questions[index + 1]
    questions[index + 1] = temp
    this.setData({ 'form.questions': questions })
  },

  removeQuestion(e) {
    const index = Number(e.currentTarget.dataset.index)
    const questions = this.data.form.questions.filter((_, idx) => idx !== index)
    this.setData({ 'form.questions': questions.length ? questions : [emptyQuestion(1)] })
  },

  validate() {
    const { form } = this.data
    if (!form.title || !form.title.trim()) {
      wx.showToast({ title: '请填写问卷标题', icon: 'none' })
      return false
    }
    if (!form.targetClient && !form.targetStaff) {
      wx.showToast({ title: '请至少选择一个发布对象', icon: 'none' })
      return false
    }
    if (!form.questions.length) {
      wx.showToast({ title: '请至少添加一道题目', icon: 'none' })
      return false
    }
    for (let i = 0; i < form.questions.length; i++) {
      const q = form.questions[i]
      if (!q.title || !q.title.trim()) {
        wx.showToast({ title: `请填写第 ${i + 1} 题题目`, icon: 'none' })
        return false
      }
      if (['single', 'multiple'].includes(q.type)) {
        const opts = String(q.optionsText || '').split('\n').map(o => o.trim()).filter(Boolean)
        if (opts.length < 2) {
          wx.showToast({ title: `第 ${i + 1} 题至少需要 2 个选项`, icon: 'none' })
          return false
        }
      }
    }
    return true
  },

  saveDraft() {
    this.save(false)
  },

  saveAndPublish() {
    wx.showModal({
      title: '确认立即发布？',
      content: '发布后将向指定受众开放填写，并自动向目标用户/宠托师发送调研通知。',
      confirmText: '立即发布',
      cancelText: '再看看'
    }).then(res => {
      if (res.confirm) {
        this.save(true)
      }
    })
  },

  save(publishImmediately = false) {
    if (this.data.savingDraft || this.data.publishing) return
    if (!this.validate()) return
    this.setData({
      savingDraft: !publishImmediately,
      publishing: publishImmediately
    })
    const payload = buildPayload(this.data.form)
    const action = this.data.id ? 'update' : 'create'
    callFunction('questionnaire', action, {
      ...payload,
      id: this.data.id,
      publishImmediately
    })
      .then(() => {
        wx.showToast({
          title: publishImmediately ? '问卷已发布上线！' : '草稿保存成功',
          icon: 'success'
        })
        setTimeout(() => wx.navigateBack(), 800)
      })
      .catch(showError)
      .finally(() => this.setData({ savingDraft: false, publishing: false }))
  }
})
