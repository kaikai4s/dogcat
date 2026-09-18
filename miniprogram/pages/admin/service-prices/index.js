const { callFunction, showError } = require('../../../utils/cloud')

const eventOptions = [
  { eventType: 'enter_door', label: '到达入户' },
  { eventType: 'leash_on', label: '牵引准备' },
  { eventType: 'feed', label: '喂食' },
  { eventType: 'water', label: '换水' },
  { eventType: 'pet_status', label: '宠物状态' },
  { eventType: 'return_home', label: '返家确认' },
  { eventType: 'leave_door', label: '离户检查' },
  { eventType: 'clean', label: '清洁' },
  { eventType: 'medicine', label: '喂药' },
  { eventType: 'video_checkin', label: '视频打卡' }
]

const extraPetRuleOptions = [
  { value: 'none', label: '不加价' },
  { value: 'all', label: '多一只宠物加价' },
  { value: 'dog', label: '多一只狗狗加价' }
]

function extraPetRuleText(value) {
  const item = extraPetRuleOptions.find((option) => option.value === value)
  return item ? item.label : extraPetRuleOptions[0].label
}

function decoratePrice(item = {}) {
  const key = String(item.key || '').trim()
  const enabled = item.enabled !== false
  const caseImageFileIds = Array.isArray(item.caseImageFileIds) ? item.caseImageFileIds.filter(Boolean).slice(0, 9) : []
  return {
    ...item,
    key,
    enabled,
    extraHalfHourFee: item.extraHalfHourFee || 0,
    internExtraHalfHourFee: item.internExtraHalfHourFee || 0,
    detailDescription: item.detailDescription || '',
    caseImageFileIds,
    caseImageUrls: item.caseImageUrls || caseImageFileIds,
    showOnHome: key !== 'visit_fee' && enabled && item.showOnHome === true,
    extraPetRuleText: extraPetRuleText(item.extraPetRule),
    keyReadonly: !item.isNew,
    canDelete: key !== 'visit_fee'
  }
}

function groupRules(rules, prices = []) {
  const groups = prices
    .filter((price) => price.key && price.key !== 'visit_fee')
    .map((price) => ({ serviceType: price.key, title: price.label || price.key, rules: [], expanded: false }))
  ;(rules || []).forEach((rule) => {
    let group = groups.find((item) => item.serviceType === rule.serviceType)
    if (!group) {
      group = { serviceType: rule.serviceType, title: rule.serviceType, rules: [] }
      groups.push(group)
    }
    group.rules.push(rule)
  })
  return groups
}

Page({
  data: {
    prices: [],
    eventOptions,
    extraPetRuleOptions,
    ruleGroups: [],
    expandedRuleGroups: {},
    showPriceModal: false,
    priceForm: {},
    priceFormIndex: -1,
    uploadingServiceCase: false
  },

  onShow() {
    this.load()
  },

  load() {
    Promise.all([
      callFunction('admin', 'listServicePrices'),
      callFunction('admin', 'listServiceCheckinRules')
    ])
      .then(([prices, rules]) => {
        const decorated = (prices || []).map(decoratePrice)
        this.setData({ prices: decorated, ruleGroups: groupRules(rules, decorated) })
      })
      .catch(showError)
  },

  noop() {},

  toggleRuleGroup(e) {
    const groupIndex = Number(e.currentTarget.dataset.groupIndex)
    const group = this.data.ruleGroups[groupIndex]
    if (!group) return
    this.setData({ [`ruleGroups[${groupIndex}].expanded`]: !group.expanded })
  },

  ruleInput(e) {
    const groupIndex = Number(e.currentTarget.dataset.groupIndex)
    const ruleIndex = Number(e.currentTarget.dataset.ruleIndex)
    const field = e.currentTarget.dataset.field
    this.setData({ [`ruleGroups[${groupIndex}].rules[${ruleIndex}].${field}`]: e.detail.value })
  },

  toggleRuleRequired(e) {
    const groupIndex = Number(e.currentTarget.dataset.groupIndex)
    const ruleIndex = Number(e.currentTarget.dataset.ruleIndex)
    this.setData({ [`ruleGroups[${groupIndex}].rules[${ruleIndex}].required`]: e.detail.value })
  },

  toggleRuleEnabled(e) {
    const groupIndex = Number(e.currentTarget.dataset.groupIndex)
    const ruleIndex = Number(e.currentTarget.dataset.ruleIndex)
    this.setData({ [`ruleGroups[${groupIndex}].rules[${ruleIndex}].enabled`]: e.detail.value })
  },

  addRule(e) {
    const groupIndex = Number(e.currentTarget.dataset.groupIndex)
    const group = this.data.ruleGroups[groupIndex]
    const first = this.data.eventOptions[0]
    const rules = group.rules.concat({ serviceType: group.serviceType, eventType: first.eventType, label: first.label, required: true, enabled: true, sortOrder: (group.rules.length + 1) * 10, description: '' })
    this.setData({ [`ruleGroups[${groupIndex}].rules`]: rules })
  },

  chooseRuleEvent(e) {
    const groupIndex = Number(e.currentTarget.dataset.groupIndex)
    const ruleIndex = Number(e.currentTarget.dataset.ruleIndex)
    const option = this.data.eventOptions[Number(e.detail.value)] || this.data.eventOptions[0]
    this.setData({
      [`ruleGroups[${groupIndex}].rules[${ruleIndex}].eventType`]: option.eventType,
      [`ruleGroups[${groupIndex}].rules[${ruleIndex}].label`]: option.label
    })
  },

  removeRule(e) {
    const groupIndex = Number(e.currentTarget.dataset.groupIndex)
    const ruleIndex = Number(e.currentTarget.dataset.ruleIndex)
    const rules = this.data.ruleGroups[groupIndex].rules.filter((_, index) => index !== ruleIndex)
    this.setData({ [`ruleGroups[${groupIndex}].rules`]: rules })
  },

  saveRules() {
    const rules = this.data.ruleGroups.reduce((list, group) => list.concat(group.rules), [])
    callFunction('admin', 'saveServiceCheckinRules', { rules })
      .then((saved) => {
        this.setData({ ruleGroups: groupRules(saved, this.data.prices) })
        wx.showToast({ title: '已保存' })
      })
      .catch(showError)
  },

  resetRuleDefaults() {
    wx.showModal({
      title: '恢复默认打卡规则',
      content: '将重置所有服务的打卡证据规则，是否继续？',
      success: (res) => {
        if (!res.confirm) return
        callFunction('admin', 'resetDefaultServiceCheckinRules')
          .then((rules) => {
            this.setData({ ruleGroups: groupRules(rules, this.data.prices) })
            wx.showToast({ title: '已恢复' })
          })
          .catch(showError)
      }
    })
  },

  input(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [`priceForm.${field}`]: e.detail.value })
  },

  resolveCaseImageUrls(fileIds = []) {
    const ids = (fileIds || []).filter(Boolean)
    if (!ids.length) {
      this.setData({ 'priceForm.caseImageUrls': [] })
      return
    }
    wx.cloud.getTempFileURL({
      fileList: ids,
      success: (res) => {
        const map = {}
        ;(res.fileList || []).forEach((item) => { map[item.fileID] = item.tempFileURL || item.fileID })
        this.setData({ 'priceForm.caseImageUrls': ids.map((id) => map[id] || id) })
      },
      fail: () => this.setData({ 'priceForm.caseImageUrls': ids })
    })
  },

  toggleEnabled(e) {
    this.setData({ 'priceForm.enabled': e.detail.value })
  },

  toggleShowOnHome(e) {
    this.setData({ 'priceForm.showOnHome': e.detail.value })
  },

  chooseExtraPetRule(e) {
    const option = this.data.extraPetRuleOptions[Number(e.detail.value)] || this.data.extraPetRuleOptions[0]
    this.setData({
      'priceForm.extraPetRule': option.value,
      'priceForm.extraPetRuleText': option.label
    })
  },

  openPriceModal(e) {
    const index = Number(e.currentTarget.dataset.index)
    const item = this.data.prices[index]
    if (!item) return
    const priceForm = decoratePrice({ ...item })
    this.setData({ priceForm, priceFormIndex: index, showPriceModal: true }, () => this.resolveCaseImageUrls(priceForm.caseImageFileIds))
  },

  closePriceModal() {
    if (this.data.uploadingServiceCase) return
    this.setData({ showPriceModal: false, priceForm: {}, priceFormIndex: -1 })
  },

  addService() {
    const sortOrder = this.data.prices.reduce((max, item) => Math.max(max, Number(item.sortOrder || 0)), 0) + 10
    const draft = decoratePrice({ key: '', label: '', price: 0, internPrice: 0, extraPetFee: 0, internExtraPetFee: 0, extraHalfHourFee: 0, internExtraHalfHourFee: 0, extraPetRule: 'none', showOnHome: true, enabled: true, sortOrder, description: '', detailDescription: '', caseImageFileIds: [], isPreset: false, isNew: true })
    this.setData({ priceForm: draft, priceFormIndex: -1, showPriceModal: true })
  },

  chooseServiceCaseImages() {
    if (this.data.uploadingServiceCase) return
    const current = this.data.priceForm.caseImageFileIds || []
    const remain = 9 - current.length
    if (remain <= 0) {
      wx.showToast({ title: '最多上传9张案例图', icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const files = res.tempFiles || []
        if (!files.length) return
        this.setData({ uploadingServiceCase: true })
        wx.showLoading({ title: '上传图片中...' })
        files.reduce((chain, file) => chain.then(() => this.uploadServiceCaseImage(file.tempFilePath)), Promise.resolve())
          .then(() => {
            wx.hideLoading()
            this.setData({ uploadingServiceCase: false })
            this.resolveCaseImageUrls(this.data.priceForm.caseImageFileIds)
            wx.showToast({ title: '图片已上传，请保存服务', icon: 'none' })
          })
          .catch((error) => {
            wx.hideLoading()
            this.setData({ uploadingServiceCase: false })
            this.resolveCaseImageUrls(this.data.priceForm.caseImageFileIds)
            showError(error)
          })
      },
      fail: (error) => { if (error && error.errMsg && !error.errMsg.includes('cancel')) showError(error) }
    })
  },

  uploadServiceCaseImage(filePath) {
    const key = String(this.data.priceForm.key || 'new_service').replace(/[^a-zA-Z0-9_]/g, '') || 'new_service'
    const ext = filePath.includes('.') ? filePath.substring(filePath.lastIndexOf('.')) : '.jpg'
    const cloudPath = `service_cases/${key}/${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`
    return new Promise((resolve, reject) => {
      wx.cloud.uploadFile({
        cloudPath,
        filePath,
        success: (upload) => {
          const fileID = upload.fileID
          const ids = (this.data.priceForm.caseImageFileIds || []).concat(fileID).slice(0, 9)
          this.setData({ 'priceForm.caseImageFileIds': ids })
          resolve(fileID)
        },
        fail: reject
      })
    })
  },

  removeServiceCaseImage(e) {
    const index = Number(e.currentTarget.dataset.index)
    const ids = (this.data.priceForm.caseImageFileIds || []).slice()
    ids.splice(index, 1)
    this.setData({ 'priceForm.caseImageFileIds': ids }, () => this.resolveCaseImageUrls(ids))
  },

  previewServiceCaseImage(e) {
    const current = e.currentTarget.dataset.url
    const urls = (this.data.priceForm.caseImageUrls || []).filter(Boolean)
    if (current && urls.length) wx.previewImage({ current, urls })
  },

  savePriceForm() {
    if (this.data.uploadingServiceCase) return
    const item = decoratePrice(this.data.priceForm)
    const doSave = () => {
      callFunction('admin', 'saveServicePrice', item)
        .then(() => Promise.all([
          callFunction('admin', 'listServicePrices'),
          callFunction('admin', 'listServiceCheckinRules')
        ]))
        .then(([prices, rules]) => {
          const decorated = (prices || []).map(decoratePrice)
          this.setData({ prices: decorated, ruleGroups: groupRules(rules, decorated) })
          this.closePriceModal()
          wx.showToast({ title: '服务已保存' })
        })
        .catch(showError)
    }
    if ((item.key === 'walk' || item.key === 'play') && (!Number(item.extraHalfHourFee) || !Number(item.internExtraHalfHourFee))) {
      wx.showModal({
        title: '续时费为0元',
        content: '0元表示每只宠物超过30分钟后不额外收费，确认保存当前配置吗？',
        success: (res) => { if (res.confirm) doSave() }
      })
      return
    }
    doSave()
  },


  deleteService(e) {
    const index = Number(e.currentTarget.dataset.index)
    const item = this.data.prices[index]
    if (item.isNew) {
      this.setData({ prices: this.data.prices.filter((_, current) => current !== index) })
      return
    }
    wx.showModal({
      title: item.isPreset ? '停用服务' : '删除服务',
      content: item.isPreset ? `将停用「${item.label}」并从首页隐藏，是否继续？` : `将删除自定义服务「${item.label}」，是否继续？`,
      success: (res) => {
        if (!res.confirm) return
        callFunction('admin', 'deleteServicePrice', { key: item.key })
          .then((prices) => {
            const decorated = (prices || []).map(decoratePrice)
            this.setData({ prices: decorated, ruleGroups: groupRules([], decorated) })
            this.load()
            wx.showToast({ title: item.isPreset ? '已停用' : '已删除' })
          })
          .catch(showError)
      }
    })
  },

  resetDefaults() {
    wx.showModal({
      title: '恢复默认价格',
      content: '将把所有预设服务价格恢复为默认配置，自定义服务不会被删除，是否继续？',
      success: (res) => {
        if (!res.confirm) return
        callFunction('admin', 'resetDefaultServicePrices')
          .then((prices) => {
            const decorated = (prices || []).map(decoratePrice)
            this.setData({ prices: decorated, ruleGroups: groupRules([], decorated) })
            this.load()
            wx.showToast({ title: '已恢复' })
          })
          .catch(showError)
      }
    })
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  }
})
