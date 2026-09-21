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

function parseAmount(value) {
  const text = String(value).trim()
  const amount = Number(text)
  if (!/^\d+(\.\d{1,2})?$/.test(text) || !Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(Math.round(amount * 100))) return null
  return amount
}

function decorateStaffFinance(item) {
  const result = { ...item, id: item._id || item.id }
  ;['amount', 'paidAmount', 'refundedAmount', 'forfeitedAmount', 'availableRefundAmount', 'approvedAmount'].forEach((key) => {
    result[`${key}Text`] = item[key] === undefined || item[key] === null ? '待核实' : money(item[key])
  })
  result.refundPending = ['pending', 'requested', 'refund_requested', 'refund_pending'].includes(item.refundStatus) || ['refund_requested', 'refund_pending'].includes(item.status)
  result.canForfeit = parseAmount(item.availableRefundAmount) !== null && ['paid', 'partially_refunded'].includes(item.status) && !['requested', 'approved', 'processing', 'refunding', 'success'].includes(item.refundStatus)
  // Unknown states stay visible but never imply successful payment.
  result.transferConfirmed = item.status === 'paid' || item.transferStatus === 'SUCCESS'
  result.mediaFileIds = Array.isArray(item.mediaFileIds) ? item.mediaFileIds : []
  return result
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
    deposits: [],
    supplies: [],
    staffFinanceLoading: false,
    staffFinanceError: '',
    actionBusy: false,
    review: null,
    reviewAmount: '',
    reviewRemark: '',
    eligibilityChecked: false,
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
    this.loadStaffFinance()
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

  reloadAll() {
    this.load()
    this.loadStaffFinance()
  },

  onPullDownRefresh() {
    this.reloadAll()
    setTimeout(() => wx.stopPullDownRefresh(), 500)
  },

  chooseStartDate(e) {
    this.setData({ startDate: e.detail.value }, this.reloadAll)
  },

  chooseEndDate(e) {
    this.setData({ endDate: e.detail.value }, this.reloadAll)
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    this.setData({ activeTab: tab })
    if (tab === 'deposits' || tab === 'supplies') {
      this.loadStaffFinance()
    }
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

  loadStaffFinance() {
    this.setData({ staffFinanceLoading: true, staffFinanceError: '' })
    const query = this.query()
    Promise.all([
      callFunction('admin', 'listStaffDeposits', query),
      callFunction('admin', 'listSupplyReimbursements', query)
    ])
      .then(([deposits, supplies]) => {
        this.setData({
          deposits: (deposits || []).map(decorateStaffFinance),
          supplies: (supplies || []).map(decorateStaffFinance),
          staffFinanceLoading: false
        })
      })
      .catch((err) => {
        this.setData({ staffFinanceLoading: false, staffFinanceError: err.message || '加载宠托师财务失败' })
        showError(err)
      })
  },

  auditDepositRefund(e) {
    const id = e.currentTarget.dataset.id
    const approved = e.currentTarget.dataset.approved === true || e.currentTarget.dataset.approved === 'true'
    wx.showModal({
      title: approved ? '审核通过退还保证金' : '驳回退出退款申请',
      content: approved ? '确认审核通过？审核后进入待实际退款状态。' : '确认驳回该退出退款申请？',
      editable: !approved,
      placeholderText: !approved ? '请输入驳回原因' : '',
      success: (res) => {
        if (!res.confirm) return
        const reason = (!approved && res.content) ? res.content.trim() : (approved ? '审核通过全额退款' : '')
        if (!approved && !reason) {
          wx.showToast({ title: '请填写驳回原因', icon: 'none' })
          return
        }
        wx.showLoading({ title: '处理中...', mask: true })
        callFunction('admin', 'auditDepositRefund', { id, approved, reason })
          .then(() => {
            wx.hideLoading()
            wx.showToast({ title: approved ? '已通过退款' : '已驳回' })
            this.loadStaffFinance()
          })
          .catch((err) => {
            wx.hideLoading()
            showError(err)
          })
      }
    })
  },

  forfeitDeposit(e) {
    if (this.data.actionBusy) return
    const id = e.currentTarget.dataset.id
    const maxAmount = Number(e.currentTarget.dataset.max || 0)
    wx.showModal({
      title: '违规没收保证金',
      content: `输入没收金额（不超过 ¥${maxAmount}）与原因：`,
      editable: true,
      placeholderText: '格式：金额|违规原因（如：100|私单服务）',
      success: (res) => {
        if (!res.confirm || !res.content) return
        const parts = res.content.split('|')
        const amount = Number(parts[0].trim())
        const reason = (parts[1] || '').trim()
        if (!amount || amount <= 0 || amount > maxAmount) {
          wx.showToast({ title: `请输入有效金额（≤${maxAmount}）`, icon: 'none' })
          return
        }
        if (!reason) {
          wx.showToast({ title: '请填写没收原因（如私单/违规）', icon: 'none' })
          return
        }
        wx.showLoading({ title: '处理中...', mask: true })
        if (this.data.actionBusy) return
        this.setData({ actionBusy: true })
        const pendingKey = `deposit_forfeit_${id}`
        const previous = wx.getStorageSync(pendingKey)
        const clientRequestId = previous && previous.amount === amount && previous.reason === reason
          ? previous.clientRequestId : `forfeit_${Date.now()}_${Math.random().toString(36).slice(2)}`
        wx.setStorageSync(pendingKey, { amount, reason, clientRequestId })
        callFunction('admin', 'forfeitStaffDeposit', { id, amount, reason, clientRequestId })
          .then(() => {
            wx.removeStorageSync(pendingKey)
            wx.hideLoading()
            wx.showToast({ title: '已执行没收' })
            this.loadStaffFinance()
          })
          .catch((err) => {
            wx.hideLoading()
            showError(err)
          })
          .finally(() => this.setData({ actionBusy: false }))
      }
    })
  },

  auditSupplyReimbursement(e) {
    const id = e.currentTarget.dataset.id
    const approved = e.currentTarget.dataset.approved === true || e.currentTarget.dataset.approved === 'true'
    const defaultAmount = e.currentTarget.dataset.amount || ''
    wx.showModal({
      title: approved ? '审核通过物资报销' : '驳回物资报销申请',
      content: approved ? `确认审核通过物资报销？默认核准金额¥${defaultAmount}，审批后待实际付款。` : '确认驳回该报销申请？',
      editable: true,
      placeholderText: approved ? `核准金额（留空默认¥${defaultAmount}）` : '请输入驳回原因',
      success: (res) => {
        if (!res.confirm) return
        let approvedAmount = null
        let rejectReason = ''
        if (approved) {
          approvedAmount = res.content && res.content.trim() ? Number(res.content.trim()) : Number(defaultAmount)
          if (!Number.isFinite(approvedAmount) || approvedAmount <= 0) {
            wx.showToast({ title: '请输入有效核准金额', icon: 'none' })
            return
          }
        } else {
          rejectReason = (res.content || '').trim()
          if (!rejectReason) {
            wx.showToast({ title: '请填写驳回原因', icon: 'none' })
            return
          }
        }
        wx.showLoading({ title: '处理中...', mask: true })
        callFunction('admin', 'auditSupplyReimbursement', { id, approved, approvedAmount, rejectReason })
          .then(() => {
            wx.hideLoading()
            wx.showToast({ title: approved ? '已通过' : '已驳回' })
            this.loadStaffFinance()
          })
          .catch((err) => {
            wx.hideLoading()
            showError(err)
          })
      }
    })
  },

  paySupplyReimbursement(e) {
    const id = e.currentTarget.dataset.id
    this.confirmStaffPayment(id, 'paySupplyReimbursement', '确认报销已付款')
  },

  confirmDepositRefund(e) {
    this.confirmStaffPayment(e.currentTarget.dataset.id, 'confirmDepositRefund', '确认保证金已退还')
  },

  confirmStaffPayment(id, action, title) {
    if (this.data.actionBusy) return
    wx.showModal({
      title,
      content: '请核实实际付款成功，并填写付款凭证号。',
      editable: true,
      placeholderText: '银行或微信付款凭证号',
      success: (res) => {
        if (!res.confirm) return
        const paymentReference = String(res.content || '').trim()
        if (!paymentReference) { wx.showToast({ title: '请填写付款凭证号', icon: 'none' }); return }
        if (this.data.actionBusy) return
        this.setData({ actionBusy: true })
        wx.showLoading({ title: '确认中...', mask: true })
        callFunction('admin', action, { id, paymentReference, paymentConfirmed: true })
          .then(() => {
            wx.hideLoading()
            wx.showToast({ title: '已确认付款' })
            this.loadStaffFinance()
          })
          .catch((err) => {
            wx.hideLoading()
            showError(err)
          })
          .finally(() => this.setData({ actionBusy: false }))
      }
    })
  },

  previewReceipt(e) {
    const urls = e.currentTarget.dataset.urls || []
    const current = e.currentTarget.dataset.current || ''
    if (urls.length) {
      wx.previewImage({ current, urls })
    }
  },

  ...navMethods()
})
