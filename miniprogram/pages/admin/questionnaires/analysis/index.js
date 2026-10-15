const { callFunction, showError } = require('../../../../utils/cloud')

function chartRows(chart) {
  const values = chart.values || []
  const max = Math.max(...values.map(v => Number(v || 0)), 1)
  const total = values.reduce((a, b) => a + Number(b || 0), 0)
  return (chart.labels || []).map((label, index) => {
    const value = Number(values[index] || 0)
    return {
      label,
      value,
      percentage: total > 0 ? Math.round(value / total * 100) : 0,
      width: Math.round(value / max * 100)
    }
  })
}

Page({
  data: {
    id: '',
    detail: null,
    report: null,
    charts: [],
    loading: false,
    activeTab: 'insights', // 'insights' | 'charts'
    sampleTextMap: {}
  },

  onLoad(query) {
    this.setData({ id: query.id || '' })
    this.loadDetail()
  },

  onPullDownRefresh() {
    this.loadDetail().finally(() => wx.stopPullDownRefresh())
  },

  switchTab(e) {
    this.setData({ activeTab: e.currentTarget.dataset.tab })
  },

  loadDetail() {
    if (!this.data.id) return Promise.resolve()
    return callFunction('questionnaire', 'detailAdmin', { id: this.data.id })
      .then(detail => {
        this.setData({ detail })
        return callFunction('questionnaire', 'getAiReport', { id: this.data.id })
      })
      .then(report => {
        if (report) {
          this.setData({
            report,
            charts: (report.charts || []).map(chart => ({
              ...chart,
              rows: chart.rows || chartRows(chart)
            }))
          })
        }
      })
      .catch(showError)
  },

  analyze() {
    if (this.data.loading) return
    this.setData({ loading: true })
    wx.showLoading({ title: '混元 hy3 深度分析中...' })
    callFunction('questionnaire', 'analyzeAI', { id: this.data.id })
      .then((report) => {
        wx.hideLoading()
        wx.showToast({ title: 'hy3 分析完成', icon: 'success' })
        this.setData({
          loading: false,
          report,
          charts: (report.charts || []).map(chart => ({
            ...chart,
            rows: chart.rows || chartRows(chart)
          }))
        })
      })
      .catch((err) => {
        wx.hideLoading()
        this.setData({ loading: false })
        showError(err)
      })
  }
})
