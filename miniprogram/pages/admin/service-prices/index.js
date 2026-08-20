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

function groupRules(rules) {
  return (rules || []).reduce((groups, rule) => {
    const key = rule.serviceType
    const group = groups.find((item) => item.serviceType === key)
    if (group) group.rules.push(rule)
    else groups.push({ serviceType: key, title: key, rules: [rule] })
    return groups
  }, [])
}

Page({
  data: {
    prices: [],
    eventOptions,
    ruleGroups: []
  },

  onShow() {
    this.load()
  },

  load() {
    Promise.all([
      callFunction('admin', 'listServicePrices'),
      callFunction('admin', 'listServiceCheckinRules')
    ])
      .then(([prices, rules]) => this.setData({ prices, ruleGroups: groupRules(rules) }))
      .catch(showError)
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
        this.setData({ ruleGroups: groupRules(saved) })
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
            this.setData({ ruleGroups: groupRules(rules) })
            wx.showToast({ title: '已恢复' })
          })
          .catch(showError)
      }
    })
  },

  input(e) {
    const index = e.currentTarget.dataset.index
    const field = e.currentTarget.dataset.field
    this.setData({ [`prices[${index}].${field}`]: e.detail.value })
  },

  toggleEnabled(e) {
    const index = e.currentTarget.dataset.index
    this.setData({ [`prices[${index}].enabled`]: e.detail.value })
  },

  save(e) {
    const item = this.data.prices[e.currentTarget.dataset.index]
    callFunction('admin', 'saveServicePrice', item)
      .then(() => {
        wx.showToast({ title: '已保存' })
        this.load()
      })
      .catch(showError)
  },

  resetDefaults() {
    wx.showModal({
      title: '恢复默认价格',
      content: '将把所有服务价格恢复为默认配置，是否继续？',
      success: (res) => {
        if (!res.confirm) return
        callFunction('admin', 'resetDefaultServicePrices')
          .then((prices) => {
            this.setData({ prices })
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
