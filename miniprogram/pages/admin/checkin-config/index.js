const { callFunction, showError } = require('../../../utils/cloud')

const rewardTypeOptions = ['points', 'coupon', 'none']
const rewardTypeLabels = {
  points: '积分',
  coupon: '优惠券',
  none: '无奖励'
}

function getCurrentMonthKey() {
  const date = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

Page({
  data: {
    monthKey: getCurrentMonthKey(),
    templates: [],
    rewardTypeChoices: ['积分', '优惠券', '无奖励'],
    days: [],
    loading: false
  },

  onShow() {
    this.loadTemplates()
    this.loadConfig()
  },

  loadTemplates() {
    callFunction('admin', 'listCouponTemplates')
      .then((templates) => this.setData({ templates }))
      .catch(showError)
  },

  monthInput(e) {
    this.setData({ monthKey: e.detail.value })
  },

  loadConfig() {
    this.setData({ loading: true })
    callFunction('admin', 'getCheckinMonthConfig', { monthKey: this.data.monthKey })
      .then((res) => {
        this.setData({
          monthKey: res.monthKey,
          days: (res.days || []).map((item) => ({
            ...item,
            rewardTypeLabel: rewardTypeLabels[item.rewardType] || '积分'
          })),
          loading: false
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        showError(err)
      })
  },

  changeRewardType(e) {
    const index = Number(e.currentTarget.dataset.index)
    const rewardType = rewardTypeOptions[Number(e.detail.value)] || 'points'
    const days = this.data.days.slice()
    days[index] = {
      ...days[index],
      rewardType,
      rewardTypeLabel: rewardTypeLabels[rewardType] || '积分',
      points: rewardType === 'points' ? Number(days[index].points || 5) : 0,
      couponTemplateId: rewardType === 'coupon' ? days[index].couponTemplateId : ''
    }
    this.setData({ days })
  },

  inputDayField(e) {
    const index = Number(e.currentTarget.dataset.index)
    const field = e.currentTarget.dataset.field
    const days = this.data.days.slice()
    days[index] = { ...days[index], [field]: e.detail.value }
    this.setData({ days })
  },

  chooseCoupon(e) {
    const index = Number(e.currentTarget.dataset.index)
    const template = this.data.templates[Number(e.detail.value)]
    if (!template) return
    const days = this.data.days.slice()
    days[index] = { ...days[index], couponTemplateId: template._id, couponSnapshot: template }
    this.setData({ days })
  },

  save() {
    const payload = {
      monthKey: this.data.monthKey,
      status: 'active',
      days: this.data.days.map((item) => ({
        day: Number(item.day),
        rewardType: item.rewardType,
        points: Number(item.points || 0),
        couponTemplateId: item.couponTemplateId || '',
        title: item.title || '',
        desc: item.desc || ''
      }))
    }
    callFunction('admin', 'saveCheckinMonthConfig', payload)
      .then(() => wx.showToast({ title: '已保存' }))
      .catch(showError)
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.navigateTo({ url })
  }
})
