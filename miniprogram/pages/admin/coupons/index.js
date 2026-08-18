const { callFunction, showError } = require('../../../utils/cloud')

function emptyTemplate() {
  return {
    name: '',
    description: '',
    discountAmount: 20,
    minOrderAmount: 80,
    validType: 'relative_days',
    validDays: 30,
    validFromFixed: '',
    validToFixed: '',
    displayTag: '',
    claimNotice: '',
    useNotice: '',
    perUserLimit: 1,
    totalIssueLimit: 0,
    newbieOnly: false,
    enabled: true,
    sortOrder: 100,
    applicableServiceTypes: []
  }
}

function emptyRewardMail() {
  return {
    title: '会员奖励到账',
    content: '你有一份新的会员奖励，请及时领取。',
    rewardType: 'coupon',
    couponTemplateId: '',
    points: 20,
    targetLevelIds: []
  }
}

function getTemplateName(templates, templateId) {
  const template = (templates || []).find((item) => item._id === templateId)
  return template ? template.name : ''
}

function buildLevelMeta(levels) {
  const nameCount = {}
  ;(levels || []).forEach((item) => {
    const name = item.name || '未命名等级'
    nameCount[name] = (nameCount[name] || 0) + 1
  })
  const labelMap = {}
  ;(levels || []).forEach((item) => {
    const name = item.name || '未命名等级'
    const duplicate = nameCount[name] > 1
    labelMap[item._id] = duplicate
      ? `${name}（≥${Number(item.minPoints || 0)}积分，ID:${String(item._id || '').slice(-4)}）`
      : `${name}（≥${Number(item.minPoints || 0)}积分）`
  })
  return { nameCount, labelMap }
}

function getLevelNames(levels, levelIds) {
  const selected = new Set(levelIds || [])
  const { labelMap } = buildLevelMeta(levels)
  return (levels || []).filter((item) => selected.has(item._id)).map((item) => labelMap[item._id] || item.name)
}

function buildLevelRows(levels, levelIds) {
  const selected = new Set(levelIds || [])
  const { labelMap } = buildLevelMeta(levels)
  return (levels || []).map((item) => ({
    ...item,
    labelText: labelMap[item._id] || item.name,
    selected: selected.has(item._id),
    selectedClass: selected.has(item._id) ? 'selected-level-row' : '',
    selectText: selected.has(item._id) ? '已选' : '选择',
    selectClass: selected.has(item._id) ? 'selected' : ''
  }))
}

Page({
  data: {
    templates: [],
    levels: [],
    servicePrices: [],
    form: emptyTemplate(),
    issueByLevel: { templateId: '', targetLevelIds: [] },
    issueByOpenid: { templateId: '', openid: '' },
    publishMail: emptyRewardMail(),
    issueMode: 'level',
    issuing: false,
    issueByLevelTemplateName: '',
    issueByOpenidTemplateName: '',
    publishMailTemplateName: '',
    issueByLevelNamesText: '',
    publishMailLevelNamesText: '',
    levelLabelMap: {},
    issueLevelRows: [],
    publishMailLevelRows: [],
    hasDuplicateLevelNames: false
  },

  onShow() {
    this.load()
  },

  syncDerivedData(nextState = {}) {
    const templates = nextState.templates || this.data.templates
    const levels = nextState.levels || this.data.levels
    const issueByLevel = nextState.issueByLevel || this.data.issueByLevel
    const issueByOpenid = nextState.issueByOpenid || this.data.issueByOpenid
    const publishMail = nextState.publishMail || this.data.publishMail
    const { nameCount, labelMap } = buildLevelMeta(levels)
    this.setData({
      issueByLevelTemplateName: getTemplateName(templates, issueByLevel.templateId) || '请选择',
      issueByOpenidTemplateName: getTemplateName(templates, issueByOpenid.templateId) || '请选择',
      publishMailTemplateName: getTemplateName(templates, publishMail.couponTemplateId) || '请选择',
      issueByLevelNamesText: getLevelNames(levels, issueByLevel.targetLevelIds).join('、') || '未选择',
      publishMailLevelNamesText: getLevelNames(levels, publishMail.targetLevelIds).join('、') || '未选择',
      levelLabelMap: labelMap,
      issueLevelRows: buildLevelRows(levels, issueByLevel.targetLevelIds),
      publishMailLevelRows: buildLevelRows(levels, publishMail.targetLevelIds),
      hasDuplicateLevelNames: Object.values(nameCount).some((count) => count > 1)
    })
  },

  load() {
    callFunction('admin', 'listCouponTemplates')
      .then((templates) => {
        const first = templates[0]?._id || ''
        const issueByLevel = { ...this.data.issueByLevel, templateId: this.data.issueByLevel.templateId || first }
        const issueByOpenid = { ...this.data.issueByOpenid, templateId: this.data.issueByOpenid.templateId || first }
        const publishMail = { ...this.data.publishMail, couponTemplateId: this.data.publishMail.couponTemplateId || first }
        this.setData({ templates, issueByLevel, issueByOpenid, publishMail })
        this.syncDerivedData({ templates, issueByLevel, issueByOpenid, publishMail })
      })
      .catch(showError)
    callFunction('admin', 'listMemberLevels')
      .then((levels) => {
        this.setData({ levels })
        this.syncDerivedData({ levels })
      })
      .catch(showError)
    callFunction('admin', 'listServicePrices')
      .then((servicePrices) => this.setData({ servicePrices }))
      .catch(showError)
  },

  input(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ ['form.' + field]: e.detail.value })
  },

  toggleEnabled(e) {
    this.setData({ ['form.enabled']: e.detail.value })
  },

  toggleNewbieOnly(e) {
    this.setData({ ['form.newbieOnly']: e.detail.value })
  },

  setValidType(e) {
    this.setData({ ['form.validType']: e.currentTarget.dataset.type })
  },

  toggleServiceType(e) {
    const key = e.currentTarget.dataset.key
    const current = this.data.form.applicableServiceTypes || []
    const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
    this.setData({ ['form.applicableServiceTypes']: next })
  },

  chooseTemplate(e) {
    const template = this.data.templates[e.currentTarget.dataset.index]
    if (!template) return
    this.setData({ form: { ...emptyTemplate(), ...template, applicableServiceTypes: template.applicableServiceTypes || [] } })
  },

  chooseIssueTemplate(e) {
    const template = this.data.templates[e.detail.value]
    if (!template) return
    const mode = this.data.issueMode
    if (mode === 'level') {
      const issueByLevel = { ...this.data.issueByLevel, templateId: template._id }
      this.setData({ issueByLevel })
      this.syncDerivedData({ issueByLevel })
      return
    }
    if (mode === 'openid') {
      const issueByOpenid = { ...this.data.issueByOpenid, templateId: template._id }
      this.setData({ issueByOpenid })
      this.syncDerivedData({ issueByOpenid })
      return
    }
    const publishMail = { ...this.data.publishMail, couponTemplateId: template._id }
    this.setData({ publishMail })
    this.syncDerivedData({ publishMail })
  },

  switchIssueMode(e) {
    this.setData({ issueMode: e.currentTarget.dataset.mode })
  },

  toggleLevelById(levelId) {
    if (!levelId) return
    const current = this.data.issueByLevel.targetLevelIds || []
    const next = current.includes(levelId) ? current.filter((id) => id !== levelId) : [...current, levelId]
    const issueByLevel = { ...this.data.issueByLevel, targetLevelIds: next }
    this.setData({ issueByLevel })
    this.syncDerivedData({ issueByLevel })
  },

  toggleMailLevelById(levelId) {
    if (!levelId) return
    const current = this.data.publishMail.targetLevelIds || []
    const next = current.includes(levelId) ? current.filter((id) => id !== levelId) : [...current, levelId]
    const publishMail = { ...this.data.publishMail, targetLevelIds: next }
    this.setData({ publishMail })
    this.syncDerivedData({ publishMail })
  },

  noop() {},

  toggleLevel(e) {
    this.toggleLevelById((e.currentTarget.dataset && e.currentTarget.dataset.id) || '')
  },

  toggleLevelSwitch(e) {
    this.toggleLevelById((e.currentTarget.dataset && e.currentTarget.dataset.id) || '')
  },

  toggleMailLevel(e) {
    this.toggleMailLevelById((e.currentTarget.dataset && e.currentTarget.dataset.id) || '')
  },

  toggleMailLevelSwitch(e) {
    this.toggleMailLevelById((e.currentTarget.dataset && e.currentTarget.dataset.id) || '')
  },

  openidInput(e) {
    this.setData({ ['issueByOpenid.openid']: e.detail.value })
  },

  mailInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ ['publishMail.' + field]: e.detail.value })
  },

  setMailRewardType(e) {
    this.setData({ ['publishMail.rewardType']: e.currentTarget.dataset.type })
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
    if (this.data.issuing) return
    if (this.data.issueMode === 'level') {
      const { templateId, targetLevelIds } = this.data.issueByLevel
      if (!templateId) return wx.showToast({ title: '请选择模板', icon: 'none' })
      if (!targetLevelIds.length) return wx.showToast({ title: '请选择会员段位', icon: 'none' })
      this.setData({ issuing: true })
      callFunction('admin', 'issueCouponByLevels', { templateId, targetLevelIds })
        .then((res) => {
          const issueByLevel = { ...this.data.issueByLevel, targetLevelIds: [] }
          const title = res.issued
            ? `已发 ${res.issued}，跳过 ${res.skipped}`
            : (res.skipped ? `全部跳过 ${res.skipped}` : '未命中用户')
          wx.showToast({ title, icon: 'none' })
          if (res.skippedReasonText) {
            wx.showModal({ title: '发放结果', content: res.skippedReasonText, showCancel: false })
          }
          this.setData({ issueByLevel, issuing: false })
          this.syncDerivedData({ issueByLevel })
          this.load()
        })
        .catch((err) => {
          this.setData({ issuing: false })
          showError(err)
        })
      return
    }
    if (this.data.issueMode === 'openid') {
      const { templateId, openid } = this.data.issueByOpenid
      if (!templateId) return wx.showToast({ title: '请选择模板', icon: 'none' })
      if (!openid) return wx.showToast({ title: '请输入 openid', icon: 'none' })
      this.setData({ issuing: true })
      callFunction('admin', 'issueCouponToUser', { templateId, openid })
        .then(() => {
          wx.showToast({ title: '已发券' })
          this.setData({ ['issueByOpenid.openid']: '', issuing: false })
          this.load()
        })
        .catch((err) => {
          this.setData({ issuing: false })
          showError(err)
        })
      return
    }
    const payload = {
      ...this.data.publishMail,
      points: Number(this.data.publishMail.points || 0)
    }
    if (!payload.targetLevelIds.length) return wx.showToast({ title: '请选择会员段位', icon: 'none' })
    if (payload.rewardType === 'coupon' && !payload.couponTemplateId) return wx.showToast({ title: '请选择奖励券', icon: 'none' })
    if (payload.rewardType === 'points' && !payload.points) return wx.showToast({ title: '请填写奖励积分', icon: 'none' })
    this.setData({ issuing: true })
    callFunction('admin', 'publishRewardMailByLevels', payload)
      .then((res) => {
        const publishMail = { ...emptyRewardMail(), couponTemplateId: this.data.templates[0]?._id || '' }
        wx.showToast({ title: `已投递 ${res.issued} 封`, icon: 'none' })
        this.setData({ publishMail, issuing: false })
        this.syncDerivedData({ publishMail })
      })
      .catch((err) => {
        this.setData({ issuing: false })
        showError(err)
      })
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.navigateTo({ url })
  }
})
