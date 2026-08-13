const { callFunction, showError } = require('../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../utils/nav')

function money(value) {
  return Number(value || 0).toFixed(2)
}

function today() {
  const d = new Date()
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function monthStart() {
  const d = new Date()
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  return `${year}-${month}-01`
}

function decorate(item) {
  return { ...item, amountText: money(item.amount), actionLoading: false }
}

function metricCards(metrics = {}) {
  return [
    { label: 'GMV', value: `¥${money(metrics.gmv)}`, highlight: true },
    { label: '实收', value: `¥${money(metrics.received)}` },
    { label: '退款', value: `¥${money(metrics.refundAmount)}` },
    { label: '净收入', value: `¥${money(metrics.netRevenue)}`, highlight: true },
    { label: '宠托师收益', value: `¥${money(metrics.staffEarningAmount)}` },
    { label: '平台毛利', value: `¥${money(metrics.platformGrossProfit)}`, highlight: true },
    { label: '待审核提现', value: `¥${money(metrics.pendingWithdrawAmount)}` },
    { label: '待打款提现', value: `¥${money(metrics.withdrawingAmount)}` }
  ]
}

Page({
  data: {
    dashboard: null,
    metricCards: [],
    payments: [],
    refunds: [],
    earnings: [],
    logs: [],
    requests: [],
    status: '',
    activeTab: 'withdraws',
    startDate: monthStart(),
    endDate: today(),
    sectionHomeUrl: '',
    canGoBack: false
  },

  onLoad(q) {
    this.setData({ ...createPageNav(q) })
  },

  onShow() {
    this.load()
  },

  query() {
    return { startDate: this.data.startDate, endDate: this.data.endDate }
  },

  load() {
    const query = this.query()
    Promise.all([
      callFunction('admin', 'financeDashboard', query),
      callFunction('admin', 'listWithdrawRequests', { ...query, status: this.data.status }),
      callFunction('admin', 'listPayments', query),
      callFunction('admin', 'listRefunds', query),
      callFunction('admin', 'listStaffEarnings', query),
      callFunction('admin', 'listFinanceLogs', query)
    ])
      .then(([dashboard, requests, payments, refunds, earnings, logs]) => this.setData({
        dashboard,
        metricCards: metricCards(dashboard.metrics),
        requests: (requests || []).map(decorate),
        payments: (payments || []).map(decorate),
        refunds: (refunds || []).map(decorate),
        earnings: (earnings || []).map(decorate),
        logs: logs || []
      }))
      .catch(showError)
  },

  chooseStartDate(e) {
    this.setData({ startDate: e.detail.value }, this.load)
  },

  chooseEndDate(e) {
    this.setData({ endDate: e.detail.value }, this.load)
  },

  switchTab(e) {
    this.setData({ activeTab: e.currentTarget.dataset.tab })
  },

  filter(e) {
    this.setData({ status: e.currentTarget.dataset.status || '' }, this.load)
  },

  audit(e) {
    const id = e.currentTarget.dataset.id
    const approved = e.currentTarget.dataset.approved === true || e.currentTarget.dataset.approved === 'true'
    callFunction('admin', 'auditWithdrawRequest', { id, approved, auditRemark: approved ? '审核通过' : '审核驳回' })
      .then(() => {
        wx.showToast({ title: approved ? '已通过' : '已驳回' })
        this.load()
      })
      .catch(showError)
  },

  markPaid(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '标记已打款',
      content: '确认已线下完成打款？',
      success: (res) => {
        if (!res.confirm) return
        callFunction('admin', 'markWithdrawPaid', { id, payRemark: '人工打款完成' })
          .then(() => {
            wx.showToast({ title: '已打款' })
            this.load()
          })
          .catch(showError)
      }
    })
  },

  ...navMethods()
})
