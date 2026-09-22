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
  result.lastForfeitImages = Array.isArray(item.lastForfeitImages) ? item.lastForfeitImages : []
  return result
}

async function uploadForfeitImage(filePath) {
  if (!filePath || filePath.startsWith('cloud://')) return filePath
  if (!wx.cloud || !wx.cloud.uploadFile) return filePath
  const ext = filePath.includes('.') ? filePath.substring(filePath.lastIndexOf('.')) : '.jpg'
  const cloudPath = `deposit_forfeits/${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`
  try {
    const res = await wx.cloud.uploadFile({ cloudPath, filePath })
    return res.fileID || filePath
  } catch (err) {
    return filePath
  }
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
    targetStaffOpenid: '',
    targetStaffLabel: '',
    forfeitEvidenceId: '',
    forfeitStaffName: '',
    forfeitEvidences: [],
    forfeitImages: [],
    startDate: monthStart(),
    endDate: today(),
    sectionHomeUrl: '',
    canGoBack: false
  },

  onLoad(q) {
    const navData = createPageNav(q)
    const activeTab = (q && q.tab) ? q.tab : this.data.activeTab
    const targetStaffOpenid = (q && q.staffOpenid) || ''
    const targetEvidenceId = (q && q.evidenceId) || ''
    const suggestAmount = (q && q.suggestAmount) || ''
    const reason = (q && q.reason) ? decodeURIComponent(q.reason) : ''

    if (targetStaffOpenid) {
      this._autoForfeitParams = {
        staffOpenid: targetStaffOpenid,
        evidenceId: targetEvidenceId,
        suggestAmount,
        reason
      }
    }

    this.setData({
      ...navData,
      activeTab,
      targetStaffOpenid
    })
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

  clearStaffFilter() {
    this.setData({ targetStaffOpenid: '', targetStaffLabel: '' })
  },

  loadStaffFinance() {
    this.setData({ staffFinanceLoading: true, staffFinanceError: '' })
    const query = this.query()
    Promise.all([
      callFunction('admin', 'listStaffDeposits', query),
      callFunction('admin', 'listSupplyReimbursements', query)
    ])
      .then(([deposits, supplies]) => {
        const rawDeposits = (deposits || []).map(decorateStaffFinance)
        const targetStaffOpenid = this.data.targetStaffOpenid

        let targetStaffLabel = ''
        if (targetStaffOpenid) {
          const matched = rawDeposits.find(d => d.staffOpenid === targetStaffOpenid)
          if (matched) {
            targetStaffLabel = matched.staffRealName || matched.staffNickname || targetStaffOpenid
          }
        }

        this.setData({
          deposits: rawDeposits,
          supplies: (supplies || []).map(decorateStaffFinance),
          staffFinanceLoading: false,
          targetStaffLabel
        })

        if (this._autoForfeitParams && this._autoForfeitParams.staffOpenid) {
          const params = this._autoForfeitParams
          this._autoForfeitParams = null

          const candidateDeposits = rawDeposits.filter(d => d.staffOpenid === params.staffOpenid)
          const target = candidateDeposits.find(d => d.canForfeit) || candidateDeposits[0]

          if (target) {
            if (target.canForfeit) {
              const maxAmount = Number(target.availableRefundAmount || 0)
              let fillAmount = maxAmount > 0 ? String(maxAmount) : ''
              if (params.suggestAmount && Number(params.suggestAmount) > 0) {
                const parsedSuggest = Number(params.suggestAmount)
                fillAmount = String(Math.min(parsedSuggest, maxAmount))
              }
              const fillReason = params.reason || '违规出险扣除保证金'
              const pendingEvidences = (target.problemOrders || []).filter((p) => p.status === 'pending')
              const forfeitEvidences = pendingEvidences.map((ev) => ({
                ...ev,
                selected: params.evidenceId ? (ev._id === params.evidenceId) : true,
                actualDeductAmountInput: String(ev.deductAmount > 0 ? ev.deductAmount : '')
              }))
              this.setData({
                showForfeitModal: true,
                forfeitDepositId: target._id || target.id,
                forfeitMaxAmount: maxAmount,
                forfeitAmountInput: fillAmount,
                forfeitReasonInput: fillReason,
                forfeitEvidenceId: params.evidenceId || '',
                forfeitStaffName: target.staffRealName || target.staffNickname || target.staffOpenid,
                forfeitEvidences,
                forfeitImages: []
              })
            } else {
              wx.showModal({
                title: '无法扣除保证金',
                content: `宠托师（${target.staffRealName || target.staffNickname || params.staffOpenid}）当前保证金可用余额为 ¥${target.availableRefundAmountText || '0.00'}，暂无可扣除额度。`,
                showCancel: false
              })
            }
          } else {
            wx.showModal({
              title: '未找到保证金记录',
              content: `未找到宠托师（${params.staffOpenid}）的保证金缴纳记录，该宠托师可能尚未缴纳履约保证金。`,
              showCancel: false
            })
          }
        }
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
    const staffName = (e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.staff) || ''
    const target = (this.data.deposits || []).find((d) => (d._id || d.id) === id) || {}
    const pendingEvidences = (target.problemOrders || []).filter((p) => p.status === 'pending')
    const forfeitEvidences = pendingEvidences.map((ev) => ({
      ...ev,
      selected: true,
      actualDeductAmountInput: String(ev.deductAmount > 0 ? ev.deductAmount : '')
    }))
    const totalSuggest = forfeitEvidences.reduce((sum, item) => sum + (Number(item.actualDeductAmountInput) || 0), 0)
    const reasons = forfeitEvidences.map((item) => item.reasonText ? `${item.reasonTypeName}: ${item.reasonText}` : item.reasonTypeName).join('；')
    const fillAmount = totalSuggest > 0 ? Math.min(totalSuggest, maxAmount) : (forfeitEvidences.length ? '' : (maxAmount > 0 ? maxAmount : ''))

    this.setData({
      showForfeitModal: true,
      forfeitDepositId: id,
      forfeitMaxAmount: maxAmount,
      forfeitAmountInput: fillAmount > 0 ? String(fillAmount) : (maxAmount > 0 ? String(maxAmount) : ''),
      forfeitReasonInput: reasons,
      forfeitEvidenceId: '',
      forfeitStaffName: staffName,
      forfeitEvidences,
      forfeitImages: []
    })
  },

  closeForfeitModal() {
    this.setData({
      showForfeitModal: false,
      forfeiting: false,
      forfeitEvidenceId: '',
      forfeitStaffName: '',
      forfeitEvidences: [],
      forfeitImages: []
    })
  },

  toggleEvidenceSelect(e) {
    const index = Number(e.currentTarget.dataset.index)
    const list = [...this.data.forfeitEvidences]
    if (!list[index]) return
    list[index].selected = !list[index].selected
    if (list[index].selected && !list[index].actualDeductAmountInput && list[index].deductAmount > 0) {
      list[index].actualDeductAmountInput = String(list[index].deductAmount)
    }
    const totalSuggest = list
      .filter((item) => item.selected)
      .reduce((sum, item) => sum + (Number(item.actualDeductAmountInput) || 0), 0)
    const reasons = list
      .filter((item) => item.selected)
      .map((item) => item.reasonText ? `${item.reasonTypeName}: ${item.reasonText}` : item.reasonTypeName)
      .join('；')
    const fillAmount = totalSuggest > 0 ? Math.min(totalSuggest, this.data.forfeitMaxAmount) : ''
    this.setData({
      forfeitEvidences: list,
      forfeitAmountInput: fillAmount > 0 ? String(fillAmount) : this.data.forfeitAmountInput,
      forfeitReasonInput: reasons || this.data.forfeitReasonInput
    })
  },

  inputEvidenceActualAmount(e) {
    const index = Number(e.currentTarget.dataset.index)
    const val = e.detail.value
    const list = [...this.data.forfeitEvidences]
    if (!list[index]) return
    list[index].actualDeductAmountInput = val
    const totalSuggest = list
      .filter((item) => item.selected)
      .reduce((sum, item) => sum + (Number(item.actualDeductAmountInput) || 0), 0)
    this.setData({
      forfeitEvidences: list,
      forfeitAmountInput: totalSuggest > 0 ? String(Math.min(totalSuggest, this.data.forfeitMaxAmount)) : this.data.forfeitAmountInput
    })
  },

  inputForfeitAmount(e) {
    this.setData({ forfeitAmountInput: e.detail.value })
  },

  inputForfeitReason(e) {
    this.setData({ forfeitReasonInput: e.detail.value })
  },

  chooseForfeitImages() {
    const remain = 4 - (this.data.forfeitImages || []).length
    if (remain <= 0) return
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const files = (res.tempFiles || []).map((f) => f.tempFilePath).filter(Boolean)
        this.setData({
          forfeitImages: [...(this.data.forfeitImages || []), ...files]
        })
      }
    })
  },

  removeForfeitImage(e) {
    const index = Number(e.currentTarget.dataset.index)
    const list = [...(this.data.forfeitImages || [])]
    list.splice(index, 1)
    this.setData({ forfeitImages: list })
  },

  previewForfeitModalImage(e) {
    const current = e.currentTarget.dataset.url
    const urls = this.data.forfeitImages || []
    if (!current || !urls.length) return
    wx.previewImage({ current, urls })
  },

  previewForfeitReceipt(e) {
    const current = e.currentTarget.dataset.current
    const urls = e.currentTarget.dataset.urls || (current ? [current] : [])
    if (!current || !urls.length) return
    wx.previewImage({ current, urls })
  },

  async submitForfeitDeposit() {
    const id = this.data.forfeitDepositId
    const amount = Number(this.data.forfeitAmountInput)
    const maxAmount = this.data.forfeitMaxAmount
    const reason = String(this.data.forfeitReasonInput || '').trim()
    const evidenceId = this.data.forfeitEvidenceId || ''

    if (!amount || isNaN(amount) || amount <= 0) {
      wx.showToast({ title: '请输入有效的扣除金额', icon: 'none' })
      return
    }
    if (amount > maxAmount) {
      wx.showToast({ title: `扣除金额不能超出可用余额 ¥${maxAmount}`, icon: 'none' })
      return
    }
    if (!reason) {
      wx.showToast({ title: '请填写违规扣除描述与原因', icon: 'none' })
      return
    }

    if (this.data.forfeiting || this.data.actionBusy) return
    this.setData({ forfeiting: true })

    try {
      let evidenceImages = []
      const localImages = this.data.forfeitImages || []
      if (localImages.length > 0) {
        wx.showLoading({ title: '上传举证照片...', mask: true })
        evidenceImages = await Promise.all(localImages.map(uploadForfeitImage))
        wx.hideLoading()
      }

      const pendingKey = `deposit_forfeit_${id}`
      const previous = wx.getStorageSync(pendingKey)
      const clientRequestId = previous && previous.amount === amount && previous.reason === reason
        ? previous.clientRequestId : `forfeit_${Date.now()}_${Math.random().toString(36).slice(2)}`
      wx.setStorageSync(pendingKey, { amount, reason, clientRequestId })

      const selectedEvidences = (this.data.forfeitEvidences || [])
        .filter((item) => item.selected)
        .map((item) => ({
          evidenceId: item._id,
          actualDeductAmount: Number(item.actualDeductAmountInput) || item.deductAmount || 0
        }))

      const payload = { id, amount, reason, clientRequestId, evidenceImages, selectedEvidences }
      if (evidenceId) {
        payload.evidenceId = evidenceId
      }
      if (selectedEvidences.length === 1 && !payload.evidenceId) {
        payload.evidenceId = selectedEvidences[0].evidenceId
        payload.actualDeductAmount = selectedEvidences[0].actualDeductAmount
      }

      await callFunction('admin', 'forfeitStaffDeposit', payload)
      wx.removeStorageSync(pendingKey)
      wx.showToast({ title: '已执行扣除' })
      this.closeForfeitModal()
      this.loadStaffFinance()
    } catch (err) {
      wx.hideLoading()
      showError(err)
    } finally {
      this.setData({ forfeiting: false })
    }
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
