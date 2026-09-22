const { callFunction, showError } = require('../../../../utils/cloud')

const statusTabs = [
  { label: '全部', value: '' },
  { label: '已通过', value: 'approved' },
  { label: '待审核', value: 'pending' },
  { label: '未通过', value: 'rejected' },
  { label: '已移除', value: 'revoked' }
]

function withDisplay(profile, selectedIds = []) {
  const reviewCount = Number(profile.reviewCount || 0)
  const depositBalance = profile.depositBalance != null ? Number(profile.depositBalance) : 0
  return {
    ...profile,
    depositId: profile.depositId || '',
    reviewCount,
    ratingText: reviewCount ? `${Number(profile.ratingAverage || 0)}分 / ${reviewCount}条评价` : '暂无评分',
    depositBalance,
    depositBalanceText: `¥${depositBalance.toFixed(2)}`,
    featuredActionText: profile.isFeatured ? '取消精选' : '设为精选',
    actionText: profile.auditStatus === 'pending' ? '去审核' : '查看资料',
    canRevokeStaff: profile.auditStatus === 'approved',
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
    showFilterPanel: false,
    selectedIds: [],
    selectedProfiles: [],
    standardDepositAmount: '500.00',
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
    loading: false
  },

  onShow() {
    this.load({ reset: true })
    this.loadDepositConfig()
  },

  loadDepositConfig() {
    callFunction('admin', 'getSystemSettings')
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

  resetFilter() {
    this.setData({
      minDeposit: '',
      maxDeposit: '',
      hasViolations: '',
      requireRepayStatus: ''
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
          return wx.cloud.uploadFile({ cloudPath, filePath: img }).then((uploadRes) => uploadRes.fileID)
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

  revokeStaff(e) {
    const staffProfileId = e.currentTarget.dataset.id
    if (!staffProfileId) return
    wx.showModal({
      title: '移除宠托师身份',
      content: '确认后该用户会失去宠托师角色和接单资格；再次申请需重新审核、答题、观看培训视频并通过视频审核。',
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
    const mainNavUrls = ['/pages/admin/home/index', '/pages/admin/orders/list/index', '/pages/admin/staff-audit/list/index', '/pages/admin/incidents/list/index', '/pages/admin/coupons/index', '/pages/admin/checkin-config/index', '/pages/admin/points/index', '/pages/admin/settings/index']
    const method = mainNavUrls.includes(url) ? 'redirectTo' : 'navigateTo'
    wx[method]({ url })
  }
})
