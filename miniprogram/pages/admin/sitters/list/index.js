const { optionalAdminRead } = require('../../utils/admin-page-read')
const { uploadImage } = require('../../../../utils/image-upload')
const { callFunction, showError } = require('../../../../utils/cloud')
const { getActiveEnvId } = require('../../../../envList')

const statusTabs = [
  { label: '全部', value: '' },
  { label: '已通过', value: 'approved' },
  { label: '待审核', value: 'pending' },
  { label: '未通过', value: 'rejected' },
  { label: '已移除', value: 'revoked' },
  { label: '零保证金·可移除', value: 'can_revoke' }
]

function withDisplay(profile, selectedIds = []) {
  const reviewCount = Number(profile.reviewCount || 0)
  const depositBalance = profile.depositBalance != null ? Number(profile.depositBalance) : 0
  const canRevokeStaff = profile.canRevokeStaff !== undefined
    ? Boolean(profile.canRevokeStaff)
    : (profile.auditStatus === 'approved' && depositBalance <= 0)
  return {
    ...profile,
    depositId: profile.depositId || '',
    reviewCount,
    ratingText: reviewCount ? `${Number(profile.ratingAverage || 0)}分 / ${reviewCount}条评价` : '暂无评分',
    depositBalance,
    depositBalanceText: `¥${depositBalance.toFixed(2)}`,
    withdrawableAmount: Number(profile.withdrawableAmount || 0),
    withdrawableAmountText: `¥${Number(profile.withdrawableAmount || 0).toFixed(2)}`,
    withdrawnAmountText: `¥${Number(profile.withdrawnAmount || 0).toFixed(2)}`,
    withdrawHistory: (profile.withdrawHistory || []).map((history) => ({
      ...history,
      amountText: `¥${Number(history.amount || 0).toFixed(2)}`,
      statusText: history.payoutChannel === 'manual' && history.status === 'approved' ? '待人工付款'
        : history.source === 'admin_manual_tail_settlement' && history.status === 'paid' ? '已人工结清'
          : ({ pending: '审核中', approved: '已通过', transferring: '打款中', transfer_failed: '打款失败', rejected: '已驳回', paid: '已到账' })[history.status] || history.status || '处理中'
    })),
    featuredActionText: profile.isFeatured ? '取消精选' : '设为精选',
    commissionPercentText: profile.commissionRateOverride == null ? '沿用平台统一比例' : `个人提成 ${Math.round(Number(profile.commissionRateOverride) * 10000) / 100}%`,
    actionText: profile.auditStatus === 'pending' ? '去审核' : '查看资料',
    canRevokeStaff,
    avatarText: (profile.userNickname || profile.realName || '托').slice(0, 1),
    expanded: false,
    selected: selectedIds.includes(profile._id)
  }
}

function pageList(result) {
  return Array.isArray(result) ? { list: result, hasMore: false, page: 1, total: result.length } : (result || { list: [], hasMore: false, page: 1, total: 0 })
}

Page({
  data: {
    profiles: [],
    keyword: '',
    auditStatus: '',
    statusTabs,
    minDeposit: '',
    maxDeposit: '',
    hasViolations: '', // '' (全部) | 'yes' (仅有违规) | 'no' (无违规)
    requireRepayStatus: '', // '' (全部) | 'yes' (需补缴) | 'no' (正常)
    canRevokeStatus: '', // '' (全部) | 'yes' (保证金为0·可移除) | 'no' (不可移除)
    showFilterPanel: false,
    selectedIds: [],
    selectedProfiles: [],
    standardDepositAmount: '500.00',
    defaultCommissionPercent: 70,
    commissionStaff: null,
    commissionUseDefault: true,
    commissionPercentInput: '',
    commissionSaving: false,
    showRepayModal: false,
    repayReasonInput: '',
    submittingRepay: false,
    showForfeitModal: false,
    forfeiting: false,
    forfeitStaff: null,
    forfeitDepositId: '',
    forfeitMaxAmount: 0,
    forfeitAmountInput: '',
    forfeitReasonInput: '',
    forfeitEvidences: [],
    forfeitImages: [],
    page: 1,
    pageSize: 20,
    hasMore: true,
    total: 0,
    loading: false,
    settlementBusy: false,
    settlementStaffId: '',
    settlementProgress: '',
    settlementResumeStaffId: '',
    depositRefundBusy: false,
    showDepositRefundModal: false,
    depositRefundPreview: null,
    depositRefundPreviewLoading: false,
    depositRefundError: '',
    depositRefundReason: '',
    depositRefundStaff: null
  },

    onPullDownRefresh() {
    Promise.all([
      Promise.resolve(this.load({ reset: true })),
      Promise.resolve(this.loadDepositConfig())
    ]).finally(() => wx.stopPullDownRefresh())
  },

  onShow() {
    this._settlementPageUnloaded = false
    this.load({ reset: true })
    this.loadDepositConfig()
  },

  onUnload() {
    this._settlementPageUnloaded = true
    this._depositRefundPreviewVersion = (this._depositRefundPreviewVersion || 0) + 1
  },

  loadDepositConfig() {
    optionalAdminRead(this, 'admin', 'getSystemSettings')
      .then((res) => {
        if (res && res.staffDeposit && res.staffDeposit.amount != null) {
          this.setData({ standardDepositAmount: Number(res.staffDeposit.amount).toFixed(2) })
        }
      })
      .catch(() => {})
  },

  onReachBottom() {
    this.loadMore()
  },

  load(options = {}) {
    if (this.data.loading) return
    const reset = options.reset === true
    const page = reset ? 1 : this.data.page
    this.setData({ loading: true })
    callFunction('admin', 'listStaffProfiles', {
      keyword: this.data.keyword,
      auditStatus: this.data.auditStatus,
      canRevoke: this.data.canRevokeStatus,
      minDeposit: this.data.minDeposit,
      maxDeposit: this.data.maxDeposit,
      hasViolations: this.data.hasViolations,
      requireRepayStatus: this.data.requireRepayStatus,
      page,
      pageSize: this.data.pageSize
    })
      .then((result) => {
        const pageData = pageList(result)
        const profiles = pageData.list.map((p) => withDisplay(p, this.data.selectedIds))
        this.setData({
          profiles: reset ? profiles : this.data.profiles.concat(profiles),
          page: pageData.page,
          hasMore: pageData.hasMore,
          total: pageData.total,
          defaultCommissionPercent: Math.round(Number(pageData.defaultCommissionRate ?? 0.7) * 10000) / 100,
          loading: false
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        showError(err)
      })
  },

  loadMore() {
    if (!this.data.hasMore || this.data.loading) return
    this.setData({ page: this.data.page + 1 }, () => this.load())
  },

  inputKeyword(e) {
    this.setData({ keyword: e.detail.value })
  },

  search() {
    this.load({ reset: true })
  },

  switchStatus(e) {
    this.setData({ auditStatus: e.currentTarget.dataset.value || '' })
    this.load({ reset: true })
  },

  toggleFilterPanel() {
    this.setData({ showFilterPanel: !this.data.showFilterPanel })
  },

  inputMinDeposit(e) {
    this.setData({ minDeposit: e.detail.value })
  },

  inputMaxDeposit(e) {
    this.setData({ maxDeposit: e.detail.value })
  },

  selectViolationFilter(e) {
    const val = e.currentTarget.dataset.value || ''
    this.setData({ hasViolations: val })
  },

  selectRepayFilter(e) {
    const val = e.currentTarget.dataset.value || ''
    this.setData({ requireRepayStatus: val })
  },

  selectCanRevokeFilter(e) {
    const val = e.currentTarget.dataset.value || ''
    this.setData({ canRevokeStatus: val })
  },

  resetFilter() {
    this.setData({
      minDeposit: '',
      maxDeposit: '',
      hasViolations: '',
      requireRepayStatus: '',
      canRevokeStatus: ''
    })
    this.load({ reset: true })
  },

  applyFilter() {
    this.load({ reset: true })
  },

  toggleSelect(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    let list = [...this.data.selectedIds]
    const idx = list.indexOf(id)
    if (idx >= 0) list.splice(idx, 1)
    else list.push(id)
    this.setData({
      selectedIds: list,
      profiles: this.data.profiles.map(p => ({ ...p, selected: list.includes(p._id) }))
    })
  },

  toggleSelectAll() {
    const allIds = this.data.profiles.map(p => p._id)
    const isAllSelected = this.data.selectedIds.length === allIds.length && allIds.length > 0
    const nextList = isAllSelected ? [] : allIds
    this.setData({
      selectedIds: nextList,
      profiles: this.data.profiles.map(p => ({ ...p, selected: !isAllSelected }))
    })
  },

  openRepayModal() {
    if (!this.data.selectedIds.length) {
      wx.showToast({ title: '请至少勾选一位宠托师', icon: 'none' })
      return
    }
    const selectedProfiles = this.data.profiles.filter(p => this.data.selectedIds.includes(p._id))
    this.setData({
      showRepayModal: true,
      selectedProfiles,
      repayReasonInput: '保证金余额过低且存在服务违规出险记录，平台要求重新足额缴纳履约保证金后方可继续接单'
    })
  },

  closeRepayModal() {
    this.setData({ showRepayModal: false, submittingRepay: false })
  },

  inputRepayReason(e) {
    this.setData({ repayReasonInput: e.detail.value })
  },

  confirmBatchRepay() {
    const ids = this.data.selectedIds
    const reason = String(this.data.repayReasonInput || '').trim()
    if (!ids.length) return
    this.setData({ submittingRepay: true })
    callFunction('admin', 'batchRequireDepositRepay', {
      staffProfileIds: ids,
      reason
    })
      .then((res) => {
        wx.showToast({ title: `已成功标记 ${res.count || ids.length} 位宠托师` })
        this.closeRepayModal()
        this.setData({ selectedIds: [] })
        this.load({ reset: true })
      })
      .catch(showError)
      .finally(() => this.setData({ submittingRepay: false }))
  },

  toggleDetails(e) {
    const index = Number(e.currentTarget.dataset.index)
    const profile = this.data.profiles[index]
    if (!profile) return
    this.setData({ [`profiles[${index}].expanded`]: !profile.expanded })
  },

  openCommissionEditor(e) {
    const staff = this.data.profiles.find(p => p._id === e.currentTarget.dataset.id)
    if (!staff) return
    this.setData({
      commissionStaff: staff,
      commissionUseDefault: staff.commissionRateOverride == null,
      commissionPercentInput: staff.commissionRateOverride == null ? '' : String(Math.round(Number(staff.commissionRateOverride) * 10000) / 100)
    })
  },

  changeCommissionMode(e) { this.setData({ commissionUseDefault: e.detail.value }) },
  inputCommissionPercent(e) { this.setData({ commissionPercentInput: e.detail.value }) },
  closeCommissionEditor() {
    if (!this.data.commissionSaving) this.setData({ commissionStaff: null })
  },

  async saveCommissionRate() {
    if (!this.data.commissionStaff || this.data.commissionSaving) return
    const text = String(this.data.commissionPercentInput || '').trim()
    const percent = Number(text)
    if (!this.data.commissionUseDefault && (!/^\d+(?:\.\d{1,2})?$/.test(text) || !Number.isFinite(percent) || percent < 0 || percent > 100)) {
      return showError(new Error('请输入 0 至 100 之间的百分比，最多两位小数'))
    }
    this.setData({ commissionSaving: true })
    try {
      const result = await callFunction('admin', 'setStaffCommissionRate', {
        staffProfileId: this.data.commissionStaff._id,
        useDefault: this.data.commissionUseDefault,
        commissionPercent: text
      })
      this.setData({
        profiles: this.data.profiles.map(p => p._id !== result.staffProfileId ? p : { ...withDisplay({ ...p, commissionRateOverride: result.commissionRateOverride }, this.data.selectedIds), expanded: p.expanded }),
        commissionStaff: null
      })
      wx.showToast({ title: '提成比例已更新', icon: 'success' })
    } catch (error) { showError(error) }
    finally { this.setData({ commissionSaving: false }) }
  },

  detail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/admin/staff-audit/detail/index?id=${id}` })
  },

  goToOrder(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/admin/orders/detail/index?id=${id}` })
  },

  goToFinanceDeposit(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const staffOpenid = ds.staffOpenid || ''
    const evidenceId = ds.evidenceId || ''
    const suggestAmount = ds.suggestAmount || ''
    const reason = encodeURIComponent(ds.reason || '')
    let url = '/pages/admin/finance/index?tab=deposits'
    if (staffOpenid) {
      url += `&staffOpenid=${staffOpenid}&evidenceId=${evidenceId}&suggestAmount=${suggestAmount}&reason=${reason}`
    }
    wx.navigateTo({ url })
  },

  openForfeitModal(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    let target = ds.item
    if (!target && ds.id) {
      target = this.data.profiles.find((p) => p._id === ds.id)
    }
    if (!target) return
    const maxAmount = Number(target.depositBalance || 0)
    if (maxAmount <= 0) {
      wx.showModal({
        title: '无法扣除保证金',
        content: '该宠托师当前可用保证金余额为 0，无法执行扣除。若有违规可先要求其重新补缴保证金。',
        showCancel: false
      })
      return
    }
    const pendingEvidences = (target.problemOrders || []).filter((p) => p.status === 'pending')
    const clickedEvidenceId = ds.evidenceId || ''
    const forfeitEvidences = pendingEvidences.map((ev) => {
      const isSelected = clickedEvidenceId ? (ev._id === clickedEvidenceId) : true
      return {
        ...ev,
        selected: isSelected,
        actualDeductAmountInput: String(ev.deductAmount > 0 ? ev.deductAmount : '')
      }
    })
    const totalSuggest = forfeitEvidences
      .filter((item) => item.selected)
      .reduce((sum, item) => sum + (Number(item.actualDeductAmountInput) || 0), 0)
    const reasons = forfeitEvidences
      .filter((item) => item.selected)
      .map((item) => item.reasonText ? `${item.reasonTypeName}: ${item.reasonText}` : item.reasonTypeName)
      .join('；')
    const fillAmount = totalSuggest > 0 ? Math.min(totalSuggest, maxAmount) : (forfeitEvidences.length ? '' : String(maxAmount))
    this.setData({
      showForfeitModal: true,
      forfeiting: false,
      forfeitStaff: target,
      forfeitDepositId: target.depositId || '',
      forfeitMaxAmount: maxAmount,
      forfeitAmountInput: fillAmount > 0 ? String(fillAmount) : (forfeitEvidences.length ? '' : String(maxAmount)),
      forfeitReasonInput: reasons,
      forfeitEvidences,
      forfeitImages: []
    })
  },

  closeForfeitModal() {
    this.setData({
      showForfeitModal: false,
      forfeiting: false,
      forfeitStaff: null,
      forfeitDepositId: '',
      forfeitMaxAmount: 0,
      forfeitAmountInput: '',
      forfeitReasonInput: '',
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
    const idx = Number(e.currentTarget.dataset.index)
    const list = [...(this.data.forfeitImages || [])]
    list.splice(idx, 1)
    this.setData({ forfeitImages: list })
  },

  previewForfeitModalImage(e) {
    const url = e.currentTarget.dataset.url
    const urls = this.data.forfeitImages || []
    wx.previewImage({ current: url, urls })
  },

  async submitForfeitDeposit() {
    if (this.data.forfeiting) return
    const amount = Number(this.data.forfeitAmountInput)
    const maxAmount = this.data.forfeitMaxAmount
    const reason = String(this.data.forfeitReasonInput || '').trim()
    const staff = this.data.forfeitStaff
    if (!staff) return
    if (!amount || isNaN(amount) || amount <= 0) {
      wx.showToast({ title: '请输入有效扣除金额', icon: 'none' })
      return
    }
    if (amount > maxAmount) {
      wx.showToast({ title: `不可超过最大可扣余额 ¥${maxAmount}`, icon: 'none' })
      return
    }
    if (!reason) {
      wx.showToast({ title: '请填写具体扣除原因说明', icon: 'none' })
      return
    }

    this.setData({ forfeiting: true })
    try {
      let evidenceImages = []
      const localImages = this.data.forfeitImages || []
      if (localImages.length > 0) {
        evidenceImages = await Promise.all(localImages.map((img) => {
          if (img.startsWith('cloud://') || img.startsWith('http://') || img.startsWith('https://')) return img
          const extMatch = img.match(/\.[a-zA-Z0-9]+$/)
          const ext = extMatch ? extMatch[0] : '.jpg'
          const cloudPath = `deposit_forfeits/${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`
          return uploadImage({ cloudPath, filePath: img }).then((uploadRes) => uploadRes.fileID)
        }))
      }

      const selectedEvidences = (this.data.forfeitEvidences || [])
        .filter((item) => item.selected)
        .map((item) => ({
          evidenceId: item._id,
          actualDeductAmount: Number(item.actualDeductAmountInput) || item.deductAmount || 0
        }))

      const clientRequestId = `forfeit_${Date.now()}_${Math.random().toString(36).slice(2)}`
      const payload = {
        id: this.data.forfeitDepositId,
        staffOpenid: staff.openid,
        amount,
        reason,
        clientRequestId,
        evidenceImages,
        selectedEvidences
      }
      if (selectedEvidences.length === 1) {
        payload.evidenceId = selectedEvidences[0].evidenceId
        payload.actualDeductAmount = selectedEvidences[0].actualDeductAmount
      }

      await callFunction('admin', 'forfeitStaffDeposit', payload)
      wx.showToast({ title: '扣除成功', icon: 'success' })
      this.closeForfeitModal()
      this.load({ reset: true })
    } catch (err) {
      showError(err)
    } finally {
      this.setData({ forfeiting: false })
    }
  },

  toggleFeatured(e) {
    const staffProfileId = e.currentTarget.dataset.id
    const currentFeatured = e.currentTarget.dataset.featured === true || e.currentTarget.dataset.featured === 'true'
    const isFeatured = !currentFeatured
    if (!staffProfileId) return
    wx.showModal({
      title: isFeatured ? '设为精选宠托师' : '取消精选宠托师',
      content: isFeatured ? '精选宠托师会在前台列表所有排序中优先展示。' : '取消后将按普通排序展示。',
      success: (res) => {
        if (!res.confirm) return
        callFunction('admin', 'setSitterFeatured', { staffProfileId, isFeatured })
          .then(() => {
            wx.showToast({ title: isFeatured ? '已设为精选' : '已取消精选' })
            this.load({ reset: true })
          })
          .catch(showError)
      }
    })
  },

  async settleEarnings(e) {
    if (this.data.settlementBusy) return
    const staffProfileId = e.currentTarget.dataset.id
    if (!staffProfileId) return
    const storageKey = `admin_staff_settlement_${getActiveEnvId()}_${staffProfileId}`
    this.setData({ settlementBusy: true, settlementStaffId: staffProfileId, settlementProgress: '正在核对可转账收益...' })
    let operation = null
    try {
      try { operation = wx.getStorageSync(storageKey) || null } catch (_) {}
      if (!operation) {
        const preview = await callFunction('admin', 'getStaffSettlementPreview', { staffProfileId })
        if (!preview.canSettle) throw new Error(preview.unavailableReason || '暂无可转账结清收益')
        const confirmed = await new Promise(resolve => wx.showModal({
          title: '商家微信转账结清收益',
          content: `向${preview.staffName}转账 ¥${Number(preview.available).toFixed(2)}，共${preview.batchCount}笔。待结算 ¥${Number(preview.pending).toFixed(2)}、冻结 ¥${Number(preview.frozen).toFixed(2)}、已有提现占用 ¥${Number(preview.withdrawing).toFixed(2)} 不会重复打款。以微信到账结果扣减收益，可能需要宠托师确认收款。`,
          confirmText: '确认转账', success: res => resolve(res.confirm), fail: () => resolve(false)
        }))
        if (!confirmed) return
        operation = { clientRequestId: `settle_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`, expectedAmount: preview.available, batchIndex: 0 }
        wx.setStorageSync(storageKey, operation)
      }
      let hasMore = true
      while (hasMore && !this._settlementPageUnloaded) {
        this.setData({ settlementProgress: `正在发起第 ${operation.batchIndex + 1} 笔转账，请勿关闭页面` })
        const result = await callFunction('admin', 'settleStaffEarningsByWechat', { ...operation, staffProfileId, confirmed: true })
        if (result.needsHandling) throw new Error(result.lastTransferError
          ? `${result.lastTransferError}${result.lastTransferErrorCode ? `（${result.lastTransferErrorCode}）` : ''}`
          : '该笔转账需要处理，请到财务管理查看或重试原单；不会重复创建转账')
        hasMore = result.hasMore
        operation.batchIndex += 1
        if (hasMore) wx.setStorageSync(storageKey, operation)
      }
      if (hasMore) return
      wx.removeStorageSync(storageKey)
      if (!this._settlementPageUnloaded) this.setData({ settlementResumeStaffId: '' })
      if (this._settlementPageUnloaded) return
      wx.showModal({ title: '结清转账已发起', content: '请到财务管理查看每笔结果。等待收款确认或转账处理中的收益会继续保留占用状态，只有微信确认到账后才记为已提现。', showCancel: false })
    } catch (error) {
      if (error.code === 'STAFF_SETTLEMENT_REVIEW_REQUIRED') wx.removeStorageSync(storageKey)
      if (!this._settlementPageUnloaded) {
        this.setData({ settlementResumeStaffId: error.code === 'STAFF_SETTLEMENT_REVIEW_REQUIRED' ? '' : staffProfileId })
        if (operation && operation.batchIndex > 0) {
          wx.showModal({
            title: '部分转账已发起',
            content: `前 ${operation.batchIndex} 笔转账已成功发起；后续批次因提示“${error.message || '网络或商户额度受限'}”暂停。未完成的批次可在财务管理处理或稍后点击继续结清，不会重复打款。`,
            showCancel: false
          })
        } else {
          showError(error)
        }
      }
    } finally {
      if (!this._settlementPageUnloaded) {
        this.setData({ settlementBusy: false, settlementProgress: '' })
        this.load({ reset: true })
      }
    }
  },

  async settleManualTail(e) {
    if (this.data.settlementBusy) return
    const staffProfileId = e.currentTarget.dataset.id
    if (!staffProfileId) return
    const storageKey = `admin_staff_manual_tail_${getActiveEnvId()}_${staffProfileId}`
    this.setData({ settlementBusy: true, settlementStaffId: staffProfileId, settlementProgress: '正在核对小额尾款...' })
    try {
      let operation = wx.getStorageSync(storageKey) || null
      if (!operation) {
        const preview = await callFunction('admin', 'getStaffSettlementPreview', { staffProfileId })
        if (this._settlementPageUnloaded) return
        if (!preview.canSettleManualTail) throw new Error(preview.manualTailUnavailableReason || '仅可处理不足 ¥0.10 且没有其他未结清收益或在途提现的尾款')
        const confirmed = await new Promise(resolve => wx.showModal({
          title: '小额尾款人工结清',
          content: `核对${preview.staffName}全部尾款 ¥${Number(preview.available).toFixed(2)}。确认后生成待审核人工付款记录；请到财务管理审核并核对收款人，完成实际付款并填写凭证号后才记为已结清。开启双人复核时须由另一位管理员确认付款。`,
          confirmText: '生成结清单', success: res => resolve(res.confirm), fail: () => resolve(false)
        }))
        if (!confirmed || this._settlementPageUnloaded) return
        operation = { clientRequestId: `tail_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`, expectedAmount: preview.available }
        wx.setStorageSync(storageKey, operation)
      }
      if (this._settlementPageUnloaded) return
      const result = await callFunction('admin', 'createStaffManualTailSettlement', { ...operation, staffProfileId, confirmed: true })
      wx.removeStorageSync(storageKey)
      if (this._settlementPageUnloaded) return
      wx.showModal({
        title: result.status === 'paid' ? '尾款已登记到账' : result.needsHandling ? '尾款单需要处理' : '尾款结清单已生成',
        content: result.status === 'paid' ? '该笔尾款已有实际付款登记，可到财务管理查看凭证。'
          : result.needsHandling ? '原尾款结清单已驳回，未记为付款；收益已退回余额。请先查看财务记录，重新发起时需再次核对余额。'
            : '收益已关联结清记录。请到财务管理审核原单，核实实际付款并填写付款凭证号；尚未付款时请保留待付款状态。',
        confirmText: '查看财务', showCancel: false,
        success: () => wx.navigateTo({ url: `/pages/admin/finance/index?tab=withdraws&action=settlement&staffOpenid=${encodeURIComponent(result.staffOpenid)}` })
      })
    } catch (error) {
      if (error.code === 'STAFF_TAIL_REVIEW_REQUIRED') wx.removeStorageSync(storageKey)
      if (!this._settlementPageUnloaded) showError(error)
    } finally {
      if (!this._settlementPageUnloaded) {
        this.setData({ settlementBusy: false, settlementProgress: '' })
        this.load({ reset: true })
      }
    }
  },

  resetSettlement(e) {
    if (this.data.settlementBusy) return
    const staffProfileId = e.currentTarget.dataset.id
    wx.showModal({
      title: '重新核对剩余收益',
      content: '已发起的转账会保留原记录，仍在处理中的金额不会再次转账。清除本机续办记录后，再次点击收益转账结清，只核对当前可提现余额。',
      confirmText: '重新核对',
      success: res => {
        if (!res.confirm) return
        wx.removeStorageSync(`admin_staff_settlement_${getActiveEnvId()}_${staffProfileId}`)
        this.setData({ settlementResumeStaffId: '' })
        this.load({ reset: true })
      }
    })
  },

  async refundDeposit(e) {
    if (this.data.depositRefundBusy || this.data.depositRefundPreviewLoading) return
    const item = e.currentTarget.dataset.item
    if (!item?.depositId) return
    this.setData({ showDepositRefundModal: true, depositRefundStaff: item, depositRefundReason: '', depositRefundPreview: null, depositRefundError: '' })
    await this.refreshDepositRefundPreview()
  },

  async refreshDepositRefundPreview() {
    const item = this.data.depositRefundStaff
    if (this.data.depositRefundBusy || this.data.depositRefundPreviewLoading || !this.data.showDepositRefundModal || !item?.depositId) return
    const version = this._depositRefundPreviewVersion = (this._depositRefundPreviewVersion || 0) + 1
    this.setData({ depositRefundPreviewLoading: true, depositRefundError: '' })
    try {
      const preview = await callFunction('admin', 'getStaffDepositRefundPreview', { id: item.depositId })
      if (version !== this._depositRefundPreviewVersion || this._settlementPageUnloaded || !this.data.showDepositRefundModal) return
      this.setData({ depositRefundPreview: this.formatDepositRefundPreview(preview) })
    } catch (error) {
      if (version === this._depositRefundPreviewVersion && !this._settlementPageUnloaded && this.data.showDepositRefundModal) this.setData({ depositRefundError: error.message || '结算状态读取失败，请重试' })
    } finally {
      if (version === this._depositRefundPreviewVersion && !this._settlementPageUnloaded) this.setData({ depositRefundPreviewLoading: false })
    }
  },

  formatDepositRefundPreview(preview) {
    const view = { ...preview }
    for (const field of ['availableRefundAmount', 'supplyFeeAmount', 'supplyFeeDeductedAmount', 'supplyFeeDue', 'estimatedRefundAmount']) {
      view[`${field}Text`] = preview[field] == null ? '待核定' : Number(preview[field]).toFixed(2)
    }
    return view
  },

  closeDepositRefundModal() {
    if (this.data.depositRefundBusy) return
    this._depositRefundPreviewVersion = (this._depositRefundPreviewVersion || 0) + 1
    this.setData({ showDepositRefundModal: false, depositRefundPreviewLoading: false })
  },

  viewDepositRefundFinance() {
    const staff = this.data.depositRefundStaff
    if (!staff || this.data.depositRefundBusy) return
    this.closeDepositRefundModal()
    wx.navigateTo({ url: `/pages/admin/finance/index?tab=deposits&staffOpenid=${encodeURIComponent(staff.openid || '')}` })
  },

  viewDepositReimbursement() {
    const staff = this.data.depositRefundStaff
    if (!staff || this.data.depositRefundBusy) return
    this.closeDepositRefundModal()
    wx.navigateTo({ url: `/pages/admin/finance/index?tab=supplies&staffOpenid=${encodeURIComponent(staff.openid || '')}` })
  },

  noop() {},

  inputDepositRefundReason(e) {
    this.setData({ depositRefundReason: e.detail.value })
  },

  async submitDepositRefund() {
    if (this.data.depositRefundBusy || this.data.depositRefundPreviewLoading || !this.data.showDepositRefundModal || !this.data.depositRefundPreview || this.data.depositRefundPreview.blocked || this.data.depositRefundPreview.canRequestRefund === false) return
    const item = this.data.depositRefundStaff
    const reason = String(this.data.depositRefundReason || '').trim()
    if (!reason || reason.length > 200) return wx.showToast({ title: '请填写退还原因，最多200字', icon: 'none' })
    this.setData({ depositRefundBusy: true, depositRefundError: '' })
    try {
      const preview = await callFunction('admin', 'getStaffDepositRefundPreview', { id: item.depositId })
      if (this._settlementPageUnloaded) return
      const previous = this.data.depositRefundPreview
      this.setData({ depositRefundPreview: this.formatDepositRefundPreview(preview) })
      if (preview.blocked) throw new Error(preview.blockedReason)
      if (preview.canRequestRefund === false) throw new Error('该笔保证金已进入退款流程或已结清，请查看财务处理进度')
      if (preview.estimatedRefundAmount !== previous.estimatedRefundAmount || preview.reimbursementStatus !== previous.reimbursementStatus) {
        throw new Error('报销状态或退款金额已更新，请核对明细后重新提交')
      }
      await callFunction('admin', 'requestStaffDepositRefund', { id: item.depositId, reason })
      if (this._settlementPageUnloaded) return
      this.setData({ showDepositRefundModal: false })
      wx.showToast({ title: '已提交退款审核', icon: 'none' })
      this.load({ reset: true })
    } catch (error) {
      if (!this._settlementPageUnloaded) this.setData({ depositRefundError: error.message || '提交失败，请刷新核对后重试' })
    } finally { if (!this._settlementPageUnloaded) this.setData({ depositRefundBusy: false }) }
  },

  viewStaffFinance(e) {
    wx.navigateTo({ url: `/pages/admin/finance/index?tab=withdraws&action=settlement&staffOpenid=${encodeURIComponent(e.currentTarget.dataset.openid)}` })
  },

  revokeStaff(e) {
    const staffProfileId = e.currentTarget.dataset.id
    if (!staffProfileId) return
    const profile = (this.data.profiles || []).find((p) => p._id === staffProfileId)
    if (profile && profile.canRevokeStaff === false) {
      let reason = '该宠托师尚有未结清款项，无法直接移除身份。'
      if (profile.depositBalance > 0) {
        reason = `该宠托师保证金尚未结清（余额 ${profile.depositBalanceText}），请先退还或扣除保证金。`
      } else if (profile.hasUnsettledDeposit) {
        reason = '该宠托师存在待处理或审核中的保证金记录，请先在财务管理完成处理后再移除。'
      } else if (profile.withdrawableAmount > 0) {
        reason = `该宠托师尚有可提现收益 ${profile.withdrawableAmountText}，请先使用“收益转账结清”发起商家转账。`
      }
      wx.showModal({
        title: '无法移除身份',
        content: reason,
        showCancel: false,
        confirmText: '我知道了'
      })
      return
    }
    wx.showModal({
      title: '移除宠托师身份',
      content: '确认后该用户会失去宠托师角色和接单资格。请先用“收益转账结清”发起商家微信转账，并处理保证金退还。仍有待结算、冻结或未到账资金时不能移除；历史收益账目会保留。',
      confirmText: '确认移除',
      confirmColor: '#ef4444',
      success: (res) => {
        if (!res.confirm) return
        callFunction('admin', 'revokeStaff', { staffProfileId })
          .then(() => {
            wx.showToast({ title: '已移除身份' })
            this.load({ reset: true })
          })
          .catch(showError)
      }
    })
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    const pages = getCurrentPages()
    const current = pages[pages.length - 1]
    const currentRoute = current && current.route ? '/' + current.route : ''
    if (currentRoute === url) return
    const mainNavUrls = ['/pages/admin/home/index', '/pages/admin/orders/list/index', '/pages/admin/staff-audit/list/index', '/pages/admin/incidents/list/index', '/pages/admin/checkin-config/index', '/pages/admin/points/index', '/pages/admin/settings/index']
    const method = mainNavUrls.includes(url) ? 'redirectTo' : 'navigateTo'
    wx[method]({ url })
  }
})
