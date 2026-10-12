const { callFunction, showError } = require('../../../../utils/cloud')
const { formatDateTime } = require('../../../../utils/format')

function statusText(status) {
  return { draft: '草稿', published: '已发布', closed: '已关闭' }[status] || '未知'
}

function roleText(roles) {
  const set = new Set(roles || [])
  if (set.has('client') && set.has('staff')) return '用户+宠托师'
  if (set.has('staff')) return '仅宠托师'
  return '仅普通用户'
}

Page({
  data: {
    rawList: [],
    displayList: [],
    loading: false,
    activeTab: 'all',
    tabs: [
      { key: 'all', label: '全部' },
      { key: 'published', label: '进行中' },
      { key: 'draft', label: '草稿箱' },
      { key: 'closed', label: '已关闭' }
    ],
    stats: {
      total: 0,
      publishedCount: 0,
      responseCount: 0,
      validCount: 0
    }
  },

  onShow() {
    this.load()
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  switchTab(e) {
    const activeTab = e.currentTarget.dataset.key
    this.setData({ activeTab }, () => this.applyFilter())
  },

  load() {
    this.setData({ loading: true })
    return callFunction('questionnaire', 'listAdmin')
      .then((rawList) => {
        const formatted = (rawList || []).map(item => {
          const reward = item.rewardConfig || {}
          let rewardDesc = ''
          if (reward.enabled) {
            const parts = []
            if (reward.points > 0) parts.push(`+${reward.points}积分`)
            if (reward.couponTemplateId) parts.push('送优惠券')
            rewardDesc = parts.join(' ') || '有奖励'
          }
          const publishedAtText = item.publishedAt ? formatDateTime(item.publishedAt) : ''
            const createdAtText = formatDateTime(item.createdAt)
            const displayTimeText = item.status === 'published' && publishedAtText
              ? `发布于 ${publishedAtText}`
              : (item.status === 'closed' ? `关闭于 ${formatDateTime(item.closedAt || item.updatedAt)}` : `创建于 ${createdAtText}`)
            return {
              ...item,
              statusText: statusText(item.status),
              roleText: roleText(item.targetRoles),
              rewardDesc,
              questionCount: (item.questions || []).length,
              createdAtText,
              publishedAtText,
              displayTimeText
            }
          })

        const publishedCount = formatted.filter(i => i.status === 'published').length
        const responseCount = formatted.reduce((acc, cur) => acc + (cur.responseCount || 0), 0)
        const validCount = formatted.reduce((acc, cur) => acc + (cur.validResponseCount || 0), 0)

        this.setData({
          loading: false,
          rawList: formatted,
          stats: {
            total: formatted.length,
            publishedCount,
            responseCount,
            validCount
          }
        }, () => this.applyFilter())
      })
      .catch((err) => {
        this.setData({ loading: false })
        showError(err)
      })
  },

  applyFilter() {
    const { rawList, activeTab } = this.data
    let displayList = rawList
    if (activeTab !== 'all') {
      displayList = rawList.filter(item => item.status === activeTab)
    }
    this.setData({ displayList })
  },

  create() {
    wx.navigateTo({ url: '/pages/admin/questionnaires/edit/index' })
  },

  edit(e) {
    wx.navigateTo({ url: `/pages/admin/questionnaires/edit/index?id=${e.currentTarget.dataset.id}` })
  },

  responses(e) {
    wx.navigateTo({ url: `/pages/admin/questionnaires/responses/index?id=${e.currentTarget.dataset.id}` })
  },

  analysis(e) {
    wx.navigateTo({ url: `/pages/admin/questionnaires/analysis/index?id=${e.currentTarget.dataset.id}` })
  },

  clone(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({ title: '复制问卷', content: '确定基于此问卷快速克隆一份新草稿吗？', confirmText: '复制' })
      .then(res => {
        if (!res.confirm) return null
        return callFunction('questionnaire', 'clone', { id })
      })
      .then(res => {
        if (!res) return
        wx.showToast({ title: '已复制草稿', icon: 'success' })
        this.load()
      })
      .catch(showError)
  },

  deleteDraft(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({ title: '删除问卷', content: '确定彻底删除该问卷吗？', confirmText: '删除', confirmColor: '#f53f3f' })
      .then(res => {
        if (!res.confirm) return null
        return callFunction('questionnaire', 'delete', { id })
      })
      .then(res => {
        if (!res) return
        wx.showToast({ title: '已删除', icon: 'none' })
        this.load()
      })
      .catch(showError)
  },

  publish(e) {
    const id = e.currentTarget.dataset.id
    callFunction('questionnaire', 'publish', { id }).then(() => {
      wx.showToast({ title: '已成功发布', icon: 'success' })
      this.load()
    }).catch(showError)
  },

  close(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({ title: '关闭问卷', content: '关闭后用户将无法继续作答。', confirmText: '确认关闭' })
      .then(res => {
        if (!res.confirm) return null
        return callFunction('questionnaire', 'close', { id })
      })
      .then(res => {
        if (!res) return
        wx.showToast({ title: '已关闭问卷', icon: 'none' })
        this.load()
      })
      .catch(showError)
  }
})
