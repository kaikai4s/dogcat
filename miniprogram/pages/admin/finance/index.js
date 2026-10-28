const { can } = require('../../../utils/adminAccess')
const { optionalAdminRead } = require('../utils/admin-page-read')
const { uploadImage } = require('../../../utils/image-upload')
const { callFunction, showError } = require('../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../utils/nav')
const { toBeijingDate } = require('../../../utils/format')

function money(value) {
  return Number(value || 0).toFixed(2)
}

function today() {
  const d = toBeijingDate(new Date())
  const year = d.getUTCFullYear()
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function monthStart() {
  const d = toBeijingDate(new Date())
  const year = d.getUTCFullYear()
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${year}-${month}-01`
}

const withdrawStatusText = {
  pending: '待审核',
  approved: '待提交转账',
  transferring: '微信提现中',
  transfer_failed: '微信提现失败',
  rejected: '已驳回',
  paid: '已到账'
}

function decorate(item) {
  const status = String(item.status || '').toLowerCase()
  const transferStatus = String(item.transferStatus || '').toLowerCase()
  const isWechatWallet = item.payoutChannel === 'wechat_wallet'
  // Older withdrawal records may not have recipientOpenid persisted yet. The
  // staff/user owner fields are the same verified openid used for the transfer.
  const recipientOpenid = item.recipientOpenid || item.staffOpenid || item.userOpenid || item.openid || ''
  return {
    ...item,
    recipientOpenid,
    amountText: money(item.amount),
    statusText: withdrawStatusText[status] || item.status,
    transferStatusText: transferStatus ? (transferStatus === 'not_started' ? '未开始' : transferStatus === 'submitting' ? '提交中' : transferStatus === 'processing' ? '处理中' : transferStatus === 'success' ? '成功' : transferStatus === 'failed' ? '失败' : transferStatus === 'unknown' ? '待查询确认' : transferStatus) : '',
    currentAvailableAmountText: money(item.currentAvailableAmount),
    withdrawnAmountText: money(item.withdrawnAmount),
    withdrawHistory: (item.withdrawHistory || []).map((history) => ({
      ...history,
      amountText: money(history.amount),
      statusText: withdrawStatusText[String(history.status || '').toLowerCase()] || history.status || '处理中'
    })),
    isWechatWallet,
    actionLoading: false
  }
}

function matchClientKeyword(item, kw) {
  if (!kw) return true
  const k = String(kw).trim().toLowerCase()
  if (!k) return true
  const checks = [
    item.staffPhone, item.accountPhone, item.certifiedPhone, item.phone, item.userPhone, item.contactPhone,
    item._id, item.id, item.orderId, item.orderNo, item.paymentNo, item.refundNo, item.outBillNo,
    item.outTradeNo, item.transactionId, item.wechatTransferBillNo, item.paymentReference, item.targetId,
    item.staffRealName, item.staffNickname, item.userNickname, item.accountName
  ]
  if (checks.some((val) => val && String(val).toLowerCase().includes(k))) return true
  if (Array.isArray(item.problemOrders)) {
    if (item.problemOrders.some((p) => p && (String(p.orderId || '').toLowerCase().includes(k) || String(p.orderNo || '').toLowerCase().includes(k)))) {
      return true
    }
  }
  return false
}

function parseAmount(value) {
  const text = String(value).trim()
  const amount = Number(text)
  if (!/^\d+(\.\d{1,2})?$/.test(text) || !Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(Math.round(amount * 100))) return null
  return amount
}

function decorateStaffFinance(item) {
  const result = { ...item, id: item._id || item.id }
  ;['amount', 'paidAmount', 'refundedAmount', 'forfeitedAmount', 'supplyFeeAmount', 'supplyFeeDeductedAmount', 'availableRefundAmount', 'approvedRefundAmount', 'approvedAmount'].forEach((key) => {
    result[`${key}Text`] = item[key] === undefined || item[key] === null ? '待核实' : money(item[key])
  })
  result.refundPending = ['pending', 'requested', 'refund_requested', 'refund_pending'].includes(item.refundStatus) || ['refund_requested', 'refund_pending'].includes(item.status)
  result.canRequestRefund = parseAmount(item.availableRefundAmount) !== null && ['paid', 'partially_refunded'].includes(item.status) && !['requested', 'approved', 'processing', 'refunding'].includes(item.refundStatus)
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
    const res = await uploadImage({ cloudPath, filePath })
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
    { label: '实收扣退款', value: `¥${money(metrics.netRevenue)}`, highlight: true },
    { label: '宠托师收益', value: `¥${money(metrics.staffEarningAmount)}` },
    { label: '扣员工收益结余', value: `¥${money(metrics.platformGrossProfit)}`, highlight: true },
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
    expandedWithdrawHistories: {},
    targetStaffOpenid: '',
    targetStaffLabel: '',
    forfeitEvidenceId: '',
    forfeitStaffName: '',
    forfeitEvidences: [],
    forfeitImages: [],
    supplyShipDrafts: {},
    startDate: monthStart(),
    endDate: today(),
    keyword: '',
    appliedKeyword: '',
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

    if (targetStaffOpenid && (!q.action || q.action === 'forfeit')) {
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
    this.updateAccessibleTabs()
    this.load()
    this.loadStaffFinance()
  },

  query() {
    const q = { startDate: this.data.startDate, endDate: this.data.endDate }
    if (this.data.appliedKeyword) {
      q.keyword = this.data.appliedKeyword
    }
    return q
  },

  inputKeyword(e) {
    this.setData({ keyword: e.detail.value })
  },

  submitSearch() {
    const appliedKeyword = String(this.data.keyword || '').trim()
    this.setData({ appliedKeyword }, () => {
      this.reloadAll()
    })
  },

  clearSearch() {
    this.setData({ keyword: '', appliedKeyword: '' }, () => {
      this.reloadAll()
    })
  },

  updateAccessibleTabs() {
    const access = this.data.adminAccess
    const tabs = [
      ['withdraws', 'admin.listWithdrawRequests', 'admin.listUserAssetWithdrawals'], ['deposits', 'admin.listStaffDeposits'],
      ['supplies', 'admin.listSupplyReimbursements'], ['payments', 'admin.listPayments'], ['refunds', 'admin.listRefunds'],
      ['earnings', 'admin.listStaffEarnings'], ['logs', 'admin.listFinanceLogs']
    ].filter(([, ...permissions]) => permissions.some(key => can(access, key))).map(([tab]) => tab)
    this.setData({ accessibleTabs: tabs, financeTabs: Object.fromEntries(tabs.map(tab => [tab, true])), activeTab: tabs.includes(this.data.activeTab) ? this.data.activeTab : tabs[0] || '' })
  },
  load() {
    const query = this.query(), version = (this._financeVersion || 0) + 1
    this._financeVersion = version
    const access = this.data.adminAccess
    const withdrawalAction = can(access, 'admin.listWithdrawRequests') ? 'listWithdrawRequests' : 'listUserAssetWithdrawals'
    const fields = [
      ['financeDashboard', 'dashboard'], [withdrawalAction, 'requests'], ['listPayments', 'payments'],
      ['listRefunds', 'refunds'], ['listStaffEarnings', 'earnings'], ['listFinanceLogs', 'logs']
    ]
    return Promise.all(fields.map(async ([action, field]) => {
      try {
        const result = await optionalAdminRead(this, 'admin', action, field === 'requests' ? { ...query, status: this.data.status, staffOpenid: this.data.targetStaffOpenid } : query, field === 'dashboard' ? null : [])
        if (this._financeVersion !== version) return
        if (field === 'dashboard') this.setData({ dashboard: result, metricCards: result ? metricCards(result.metrics) : [] })
        else {
          const appliedKeyword = this.data.appliedKeyword
          const rawList = field === 'logs' ? (result || []) : (result || []).map(decorate)
          const filtered = appliedKeyword ? rawList.filter((item) => matchClientKeyword(item, appliedKeyword)) : rawList
          this.setData({ [field]: filtered })
        }
      } catch (error) { if (this._financeVersion === version) { this.setData({ [field]: field === 'dashboard' ? null : [], ...(field === 'dashboard' ? { metricCards: [] } : {}) }); showError(error) } }
    }))
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
    if (!(this.data.accessibleTabs || []).includes(tab)) return
    this.setData({ activeTab: tab })
    if (tab === 'deposits' || tab === 'supplies') {
      this.loadStaffFinance()
    }
  },

  filter(e) {
    this.setData({ status: e.currentTarget.dataset.status || '' }, this.load)
  },

  toggleWithdrawHistory(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    const currentMap = this.data.expandedWithdrawHistories || {}
    this.setData({
      [`expandedWithdrawHistories.${id}`]: !currentMap[id]
    })
  },

  audit(e) {
    const id = e.currentTarget.dataset.id
    const approved = e.currentTarget.dataset.approved === true || e.currentTarget.dataset.approved === 'true'
    const row = (this.data.requests || []).find(item => item._id === id)
    const action = row?.assetType === 'user' && !can(this.data.adminAccess, 'admin.auditWithdrawRequest') ? 'auditUserAssetWithdrawal' : 'auditWithdrawRequest'
    if (typeof wx.showLoading === 'function') wx.showLoading({ title: approved ? '正在审核并打款...' : '正在处理...', mask: true })
    callFunction('admin', action, { id, approved, auditRemark: approved ? '审核通过' : '审核驳回' })
      .then((res) => {
        if (typeof wx.hideLoading === 'function') wx.hideLoading()
        if (approved && res && res.autoTransferred) {
          const statusText = res.status === 'paid' ? '已审核并成功到账' : '已审核并自动发起微信打款'
          if (typeof wx.showToast === 'function') wx.showToast({ title: statusText, icon: 'success' })
        } else if (approved && res && res.transferError) {
          if (typeof wx.showModal === 'function') {
            wx.showModal({
              title: '审核已通过，自动打款待重试',
              content: `审核已通过，但自动打款提示：${res.transferError}。您可在待转账列表中重试发起微信打款。`,
              showCancel: false
            })
          }
        } else {
          if (typeof wx.showToast === 'function') wx.showToast({ title: approved ? '已通过' : '已驳回' })
        }
        this.load()
      })
      .catch((err) => {
        if (typeof wx.hideLoading === 'function') wx.hideLoading()
        showError(err)
      })
  },

  markPaid(e) {
    this.confirmStaffPayment(e.currentTarget.dataset.id, 'markWithdrawPaid', '确认提现付款')
  },

  queryWithdrawTransfer(e) {
    this.runWithdrawTransferAction(e.currentTarget.dataset.id, 'queryWithdrawTransfer', '正在查询...')
  },

  retryWithdrawTransfer(e) {
    const id = e.currentTarget.dataset.id
    const item = (this.data.requests || []).find((row) => row._id === id)
    const isApproved = item && item.status === 'approved'
    wx.showModal({
      title: isApproved ? '发起微信提现' : '重试微信提现',
      content: isApproved ? '确认发起转账到该宠托师的微信零钱？' : '仅在微信明确失败或未提交成功时重试；不确定状态会先查询微信结果。确认继续？',
      success: (res) => {
        if (res.confirm) this.runWithdrawTransferAction(id, 'retryWithdrawTransfer', '正在重试...')
      }
    })
  },

  releaseFailedWithdraw(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '释放失败提现收益',
      content: '确认微信侧未打款成功后，才可释放收益回可提现余额。',
      editable: true,
      placeholderText: '请输入处理备注',
      success: (res) => {
        if (!res.confirm) return
        this.runWithdrawTransferAction(id, 'releaseFailedWithdraw', '正在释放...', { remark: String(res.content || '').trim() || '微信提现失败后释放收益' })
      }
    })
  },

  runWithdrawTransferAction(id, action, title, extra = {}) {
    if (this.data.actionBusy) return
    this.setData({ actionBusy: true })
    wx.showLoading({ title, mask: true })
    callFunction('admin', action, { id, ...extra })
      .then(() => {
        wx.hideLoading()
        wx.showToast({ title: '已处理' })
        this.load()
      })
      .catch((err) => {
        wx.hideLoading()
        showError(err)
      })
      .finally(() => this.setData({ actionBusy: false }))
  },

  clearStaffFilter() {
    this._autoForfeitParams = null
    this.setData({ targetStaffOpenid: '', targetStaffLabel: '' }, this.reloadAll)
  },

  loadStaffFinance() {
    const version = (this._staffFinanceVersion || 0) + 1
    this._staffFinanceVersion = version
    const targetStaffOpenid = this.data.targetStaffOpenid
    this.setData({ staffFinanceLoading: true, staffFinanceError: '' })
    const query = this.query()
    const depositQuery = targetStaffOpenid
      ? { staffOpenid: targetStaffOpenid, ...(this.data.appliedKeyword ? { keyword: this.data.appliedKeyword } : {}) }
      : query
    return Promise.all([
      optionalAdminRead(this, 'admin', 'listStaffDeposits', depositQuery),
      optionalAdminRead(this, 'admin', 'listSupplyReimbursements', query)
    ])
      .then(([deposits, supplies]) => {
        if (this._staffFinanceVersion !== version) return
        const appliedKeyword = this.data.appliedKeyword
        const rawDeposits = (deposits || []).map(decorateStaffFinance)
        const rawSupplies = (supplies || []).map(decorateStaffFinance)
        const filteredDeposits = appliedKeyword ? rawDeposits.filter((item) => matchClientKeyword(item, appliedKeyword)) : rawDeposits
        const filteredSupplies = appliedKeyword ? rawSupplies.filter((item) => matchClientKeyword(item, appliedKeyword)) : rawSupplies

        let targetStaffLabel = ''
        if (targetStaffOpenid) {
          const matched = rawDeposits.find(d => d.staffOpenid === targetStaffOpenid)
          if (matched) {
            targetStaffLabel = matched.staffRealName || matched.staffNickname || targetStaffOpenid
          }
        }

        this.setData({
          deposits: filteredDeposits,
          supplies: filteredSupplies,
          staffFinanceLoading: false,
          targetStaffLabel
        })

        if (can(this.data.adminAccess, 'admin.forfeitStaffDeposit') && this._autoForfeitParams && this._autoForfeitParams.staffOpenid) {
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
        if (this._staffFinanceVersion !== version) return
        this.setData({ staffFinanceLoading: false, staffFinanceError: err.message || '加载宠托师财务失败' })
        showError(err)
      })
  },

  async requestDepositRefund(e) {
    if (this.data.actionBusy) return
    const id = e.currentTarget.dataset.id
    if (!id) return
    this.setData({ actionBusy: true })
    try {
      const response = await new Promise(resolve => wx.showModal({
        title: '发起保证金退还', editable: true, placeholderText: '请输入退还原因（最多200字）',
        content: '提交后进入退款审核。多笔保证金须逐笔处理，全部处理完成后才会退出身份。',
        success: resolve, fail: () => resolve({ confirm: false })
      }))
      if (!response.confirm) return
      const reason = String(response.content || '').trim()
      if (!reason || reason.length > 200) throw new Error('请填写退还原因，最多200字')
      await callFunction('admin', 'requestStaffDepositRefund', { id, reason })
      wx.showToast({ title: '已提交退款审核', icon: 'none' })
      await this.loadStaffFinance()
    } catch (error) { showError(error) }
    finally { this.setData({ actionBusy: false }) }
  },

  auditDepositRefund(e) {
    const id = e.currentTarget.dataset.id
    const approved = e.currentTarget.dataset.approved === true || e.currentTarget.dataset.approved === 'true'
    wx.showModal({
      title: approved ? '审核通过退还保证金' : '驳回退出退款申请',
      content: approved ? '确认审核通过？系统将同时自动发起原路退款返还至宠托师付款账户。' : '确认驳回该退出退款申请？',
      editable: !approved,
      placeholderText: !approved ? '请输入驳回原因' : '',
      success: (res) => {
        if (!res.confirm) return
        const reason = (!approved && res.content) ? res.content.trim() : (approved ? '审核通过并原路退款' : '')
        if (!approved && !reason) {
          wx.showToast({ title: '请填写驳回原因', icon: 'none' })
          return
        }
        wx.showLoading({ title: '处理中...', mask: true })
        callFunction('admin', 'auditDepositRefund', { id, approved, reason, autoRefund: true })
          .then((result) => {
            wx.hideLoading()
            if (approved && result && result.status === 'refunded') {
              wx.showToast({ title: '已自动原路退还', icon: 'success' })
            } else if (result && result.autoRefundFailed) {
              wx.showModal({
                title: '已通过审核，待人工退款',
                content: `自动原路退款未完成：${result.autoRefundError || '请核实原支付渠道'}。已转为待实际退款状态，您可线下打款后点击“人工录入凭证确认退款”。`,
                showCancel: false
              })
            } else {
              wx.showToast({ title: approved ? '已通过退款审核' : '已驳回' })
            }
            this.loadStaffFinance()
          })
          .catch((err) => {
            wx.hideLoading()
            showError(err)
          })
      }
    })
  },

  autoRefundDeposit(e) {
    if (this.data.actionBusy) return
    const id = e.currentTarget.dataset.id
    const amount = e.currentTarget.dataset.amount || ''
    if (!id) return
    wx.showModal({
      title: '自动原路退还保证金',
      content: `确认将该笔保证金${amount ? '（¥' + amount + '）' : ''}自动原路退还至宠托师付款账户并清零余额？`,
      confirmText: '立即退还',
      success: (res) => {
        if (!res.confirm || this.data.actionBusy) return
        this.setData({ actionBusy: true })
        wx.showLoading({ title: '正在发起原路退款...', mask: true })
        callFunction('admin', 'autoRefundStaffDeposit', { id, reason: '管理员自动原路退还' })
          .then(() => {
            wx.hideLoading()
            wx.showToast({ title: '已自动原路退还', icon: 'success' })
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
    const amountSource = String(e.currentTarget.dataset.amountSource || '').trim()
    wx.showModal({
      title: approved ? '审核通过物资报销' : '驳回物资报销申请',
      content: approved ? `确认按后台固定金额 ¥${defaultAmount} 审核通过？审批后待实际付款。` : '确认驳回该报销申请？',
      editable: !approved,
      placeholderText: approved ? '' : '请输入驳回原因',
      success: (res) => {
        if (!res.confirm) return
        let approvedAmount = null
        let rejectReason = ''
        if (approved) {
          approvedAmount = amountSource === 'config' ? undefined : Number(defaultAmount)
          if (amountSource !== 'config' && (!Number.isFinite(approvedAmount) || approvedAmount <= 0)) {
            wx.showToast({ title: '报销金额配置无效', icon: 'none' })
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
  supplyShipInput(e) {
    const id = e.currentTarget.dataset.id
    const field = e.currentTarget.dataset.field
    if (id && ['expressCompany', 'trackingNo'].includes(field)) this.setData({ [`supplyShipDrafts.${id}.${field}`]: e.detail.value })
  },
  shipStaffSupplies(e) {
    const id = e.currentTarget.dataset.id
    const draft = this.data.supplyShipDrafts[id] || {}
    const expressCompany = String(draft.expressCompany || '').trim()
    const trackingNo = String(draft.trackingNo || '').trim()
    if (!expressCompany || !trackingNo || this.data.actionBusy) return wx.showToast({ title: '请填写物流公司和单号', icon: 'none' })
    wx.showModal({ title: '确认首次用品发货', content: `${expressCompany}：${trackingNo}。提交后不可重复发货，请核对收件地址和物流单号。`,
      success: async res => {
        if (!res.confirm || this.data.actionBusy) return
        this.setData({ actionBusy: true })
        try {
          await callFunction('admin', 'shipStaffSupplies', { id, expressCompany, trackingNo })
          wx.showToast({ title: '已记录发货', icon: 'none' })
          await this.loadStaffFinance()
        } catch (error) { showError(error) } finally { this.setData({ actionBusy: false }) }
      } })
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
          .then((result) => {
            wx.hideLoading()
            if (action === 'confirmDepositRefund' && result?.exitCompleted === false) wx.showModal({ title: '此笔退款已记录', content: '还有其他保证金记录未处理，请继续逐笔核对。全部处理完成后才会完成退出。', showCancel: false })
            else wx.showToast({ title: '已确认付款' })
            if (action === 'markWithdrawPaid') this.load()
            else this.loadStaffFinance()
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
