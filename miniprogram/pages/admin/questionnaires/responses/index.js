const { callFunction, showError } = require('../../../../utils/cloud')
const { formatDateTime } = require('../../../../utils/format')

function answerText(answer) {
  if (Array.isArray(answer.value)) return answer.value.join('、')
  return String(answer.value || '')
}

function rewardText(status, verdict) {
  if (status === 'sent') return '已通过邮件发放'
  if (status === 'failed') return '发放失败（可重试）'
  if (status === 'skipped') {
    if (verdict === 'fake') return '已自动拦截（AI判定乱填）'
    return '未设奖励或跳过'
  }
  return '处理中'
}

Page({
  data: {
    id: '',
    detail: null,
    allResponses: [],
    displayResponses: [],
    loading: false,
    qualityFilter: 'all',
    searchKeyword: '',
    counts: {
      all: 0,
      valid: 0,
      suspicious: 0,
      fake: 0
    },
    validRate: 100,
    retryingAll: false
  },

  onLoad(query) {
    this.setData({ id: query.id || '' })
    this.load()
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  load() {
    const id = this.data.id
    if (!id) return Promise.resolve()
    this.setData({ loading: true })
    return Promise.all([
      callFunction('questionnaire', 'detailAdmin', { id }),
      callFunction('questionnaire', 'responses', { id })
    ]).then(([detail, responses]) => {
      const list = (responses || []).map(item => {
        const verdict = item.aiQuality && item.aiQuality.verdict ? item.aiQuality.verdict : 'valid'
        const qualityText = verdict === 'fake' ? '无效乱填' : (verdict === 'suspicious' ? '疑似敷衍' : '有效作答')
        const qualityReasons = (item.aiQuality && item.aiQuality.reasons && item.aiQuality.reasons.length)
          ? item.aiQuality.reasons.join('；')
          : ''
        return {
          ...item,
          verdict,
          createdAtText: formatDateTime(item.createdAt),
          qualityText,
          qualityReasons,
          rewardText: rewardText(item.rewardStatus, verdict),
          answerRows: (item.answers || []).map(answer => ({ ...answer, displayValue: answerText(answer) }))
        }
      })

      const counts = {
        all: list.length,
        valid: list.filter(i => i.verdict === 'valid').length,
        suspicious: list.filter(i => i.verdict === 'suspicious').length,
        fake: list.filter(i => i.verdict === 'fake').length
      }
      const validRate = list.length > 0 ? Math.round(counts.valid / list.length * 100) : 100

      this.setData({
        loading: false,
        detail,
        allResponses: list,
        counts,
        validRate
      }, () => this.applyFilter())
    }).catch((err) => {
      this.setData({ loading: false })
      showError(err)
    })
  },

  setFilter(e) {
    const qualityFilter = e.currentTarget.dataset.filter
    this.setData({ qualityFilter }, () => this.applyFilter())
  },

  onSearchInput(e) {
    this.setData({ searchKeyword: e.detail.value.trim() }, () => this.applyFilter())
  },

  applyFilter() {
    const { allResponses, qualityFilter, searchKeyword } = this.data
    let filtered = allResponses

    if (qualityFilter !== 'all') {
      filtered = filtered.filter(item => item.verdict === qualityFilter)
    }

    if (searchKeyword) {
      const kw = searchKeyword.toLowerCase()
      filtered = filtered.filter(item => {
        const matchRole = (item.role === 'staff' ? '宠托师' : '用户').includes(kw)
        const matchAnswers = item.answerRows.some(a => (a.title && a.title.toLowerCase().includes(kw)) || (a.displayValue && a.displayValue.toLowerCase().includes(kw)))
        return matchRole || matchAnswers
      })
    }

    this.setData({ displayResponses: filtered })
  },

  analysis() {
    wx.navigateTo({ url: `/pages/admin/questionnaires/analysis/index?id=${this.data.id}` })
  },

  retryReward(e) {
    const responseId = e.currentTarget.dataset.id
    wx.showLoading({ title: '补发奖励中...' })
    callFunction('questionnaire', 'retryReward', { responseId })
      .then(() => {
        wx.hideLoading()
        wx.showToast({ title: '补发成功', icon: 'success' })
        this.load()
      })
      .catch((err) => {
        wx.hideLoading()
        showError(err)
      })
  },

  retryAll() {
    const id = this.data.id
    wx.showModal({
      title: '批量补发奖励',
      content: '确定为所有被拦截（判定乱填）或发放失败的回答重新发送奖励邮件吗？',
      confirmText: '确认补发'
    }).then(res => {
      if (!res.confirm) return null
      this.setData({ retryingAll: true })
      return callFunction('questionnaire', 'retryAllRewards', { questionnaireId: id })
    }).then(res => {
      if (!res) return
      this.setData({ retryingAll: false })
      wx.showToast({ title: `已补发 ${res.retriedCount || 0} 份`, icon: 'success' })
      this.load()
    }).catch(err => {
      this.setData({ retryingAll: false })
      showError(err)
    })
  }
})
