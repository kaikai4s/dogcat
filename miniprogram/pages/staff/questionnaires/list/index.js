const { callFunction, showError, ensureLogin } = require('../../../../utils/cloud')

Page({
  data: {
    rawList: [],
    displayList: [],
    activeTab: 'todo', // 'todo' | 'done'
    loading: false
  },

  onShow() {
    ensureLogin({ content: '登录后可参与宠托师调研领取奖励。' })
      .then(() => this.load())
      .catch(() => {})
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  switchTab(e) {
    const activeTab = e.currentTarget.dataset.tab
    this.setData({ activeTab }, () => this.applyFilter())
  },

  load() {
    this.setData({ loading: true })
    return callFunction('questionnaire', 'listAvailable', { role: 'staff' })
      .then(list => {
        const formatted = (list || []).map(item => {
          const reward = item.rewardConfig || {}
          let rewardDesc = ''
          if (reward.enabled) {
            const parts = []
            if (reward.points > 0) parts.push(`+${reward.points}积分`)
            if (reward.couponTemplateId) parts.push('送优惠券')
            rewardDesc = parts.join(' ')
          }
          return {
            ...item,
            rewardDesc
          }
        })
        this.setData({ loading: false, rawList: formatted }, () => this.applyFilter())
      })
      .catch(err => {
        this.setData({ loading: false })
        showError(err)
      })
  },

  applyFilter() {
    const { rawList, activeTab } = this.data
    const displayList = rawList.filter(item => {
      if (activeTab === 'todo') return !item.answered
      return !!item.answered
    })
    this.setData({ displayList })
  },

  open(e) {
    wx.navigateTo({ url: `/pages/staff/questionnaires/detail/index?id=${e.currentTarget.dataset.id}` })
  }
})
