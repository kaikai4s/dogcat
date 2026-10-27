const { callFunction, showError, showLoading, hideLoading } = require('../../../utils/cloud')
const { navMethods } = require('../../../utils/nav')
const { createClientRequestId } = require('../../../utils/offlineQueue')
const { applyTheme, getThemeState } = require('../../../utils/theme')

const WECHAT_MIN_TRANSFER_AMOUNT = 0.10
const WECHAT_MAX_TRANSFER_AMOUNT = 200

const earningStatusText = {
  pending: '待结算',
  available: '可提现',
  withdrawing: '提现中',
  withdrawn: '已提现',
  frozen: '已冻结',
  settled: '已结算',
  deducted: '已扣除',
  refunded_void: '已退款作废',
  mock_settled: '模拟测试(不可提现)',
  mock: '模拟测试(不可提现)'
}

const withdrawStatusText = {
  pending: '审核中',
  approved: '已通过',
  transferring: '打款中',
  transfer_failed: '打款失败',
  rejected: '已驳回',
  paid: '已到账'
}

const wechatTransferStateText = {
  ACCEPTED: '微信已受理（等待商户出资划账）',
  WAIT_USER_CONFIRM: '待收款人确认收款',
  TRANSFERING: '微信转账处理中',
  PROCESSING: '微信转账处理中',
  SUCCESS: '已到账',
  FAIL: '转账失败',
  CANCELLED: '已撤销'
}

function money(value) {
  return Number(value || 0).toFixed(2)
}

function withEarning(item) {
  const status = String(item.status || '').toLowerCase()
  const isMock = item.isMock === true || item.paymentChannel === 'mock' || status === 'mock_settled' || status === 'mock'
  const deductAmount = Number(item.deductAmount || 0)
  const hasDeduction = deductAmount > 0
  const expectedAmount = Number(item.originalAmount != null ? item.originalAmount : (item.amount != null ? Number(item.amount) + deductAmount : 0))
  return {
    ...item,
    isMock,
    amountText: money(item.amount),
    expectedAmountText: money(expectedAmount),
    originalAmountText: money(expectedAmount),
    deductAmountText: money(deductAmount),
    deductReasonText: item.deductReason || '服务违规/出险扣除',
    hasDeduction,
    statusText: isMock ? '模拟测试(不可提现)' : (earningStatusText[status] || '已记录')
  }
}

function withWithdraw(item) {
  const status = String(item.status || '').toLowerCase()
  const transferState = String(item.wechatTransferState || '').toUpperCase()
  const isAccepted = transferState === 'ACCEPTED'
  return {
    ...item,
    amountText: money(item.amount),
    statusText: withdrawStatusText[status] || '处理中',
    wechatTransferStateText: wechatTransferStateText[transferState] || transferState,
    isAccepted,
    canConfirmTransfer: transferState === 'WAIT_USER_CONFIRM'
  }
}

Page({
  data: {
    themeClass: 'theme-day',
    activeTab: 'earnings',
    earningFilterStatus: '',
    balance: null,
    earnings: [],
    filteredEarnings: [],
    availableEarningsCount: 0,
    pendingEarningsCount: 0,
    withdraws: [],
    amount: '',
    submitting: false,
    transferBusy: false,
    confirmingId: '',
    transferNotice: ''
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab && tab !== this.data.activeTab) {
      this.setData({ activeTab: tab })
    }
  },

  filterEarnings(e) {
    const status = e.currentTarget.dataset.status || ''
    const decoratedEarnings = this.data.earnings || []
    const filteredEarnings = status
      ? decoratedEarnings.filter((item) => {
        if (status === 'available') return item.status === 'available' && !item.isMock
        if (status === 'pending') return item.status === 'pending' && !item.isMock
        if (status === 'settled') return ['withdrawing', 'withdrawn', 'settled'].includes(item.status) || item.isMock
        return true
      })
      : decoratedEarnings
    this.setData({
      earningFilterStatus: status,
      filteredEarnings
    })
  },

  onPullDownRefresh() {
    Promise.resolve(this.load()).finally(() => wx.stopPullDownRefresh())
  },

  onShow() {
    this.applyCurrentTheme()
    this.load()
  },

  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },

  load() {
    Promise.all([
      callFunction('finance', 'getStaffBalance'),
      callFunction('finance', 'listStaffEarnings'),
      callFunction('finance', 'listMyWithdraws')
    ])
      .then(([balance, earnings, withdraws]) => {
        const quota = balance.wechatTransferQuota || {}
        const maxAmount = quota.effectiveRemainingAmount === null || quota.effectiveRemainingAmount === undefined
          ? Number(balance.available || 0)
          : Math.min(Number(balance.available || 0), Number(quota.effectiveRemainingAmount || 0))
        const decoratedEarnings = (earnings || []).map(withEarning)
        const availableEarningsCount = decoratedEarnings.filter((item) => item.status === 'available' && !item.isMock).length
        const pendingEarningsCount = decoratedEarnings.filter((item) => item.status === 'pending' && !item.isMock).length
        const currentFilter = this.data.earningFilterStatus
        const filteredEarnings = currentFilter
          ? decoratedEarnings.filter((item) => {
            if (currentFilter === 'available') return item.status === 'available' && !item.isMock
            if (currentFilter === 'pending') return item.status === 'pending' && !item.isMock
            if (currentFilter === 'settled') return ['withdrawing', 'withdrawn', 'settled'].includes(item.status) || item.isMock
            return true
          })
          : decoratedEarnings
        this.setData({
          balance: {
            ...balance,
            assetSummary: balance.assetSummary ? { ...balance.assetSummary, availableAmountText: money(balance.assetSummary.availableAmount), totalAmountText: money(balance.assetSummary.totalAmount) } : null,
            availableText: money(balance.available),
            pendingText: money(balance.pending),
            withdrawingText: money(balance.withdrawing),
            withdrawnText: money(balance.withdrawn),
            mockTotalText: money(balance.mockTotal || 0),
            hasMockEarnings: Number(balance.mockTotal || 0) > 0,
            minWithdrawAmountText: money(balance.minWithdrawAmount)
          },
          amount: maxAmount > 0 ? money(maxAmount) : '',
          earnings: decoratedEarnings,
          filteredEarnings,
          availableEarningsCount,
          pendingEarningsCount,
          withdraws: (withdraws || []).map(withWithdraw)
        })
        this.autoSyncPendingTransfers((withdraws || []).map(withWithdraw))
      })
      .catch(showError)
  },

  input(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value })
  },

  withdraw() {
    if (this._submittingLock || this.data.submitting) return
    const amount = Number(this.data.amount || 0)
    const minWithdraw = Number(this.data.balance?.minWithdrawAmount || 0)
    const available = Number(this.data.balance?.available || 0)
    if (!amount || amount <= 0) {
      return wx.showToast({ title: '请输入正确的提现金额', icon: 'none' })
    }
    if (amount < WECHAT_MIN_TRANSFER_AMOUNT) {
      return wx.showToast({ title: '微信零钱单笔最低 ¥0.10', icon: 'none' })
    }
    if (amount > WECHAT_MAX_TRANSFER_AMOUNT) {
      return wx.showToast({ title: '微信零钱单笔最高 ¥200.00', icon: 'none' })
    }
    if (available > 0 && amount > available) {
      return wx.showToast({ title: '提现金额超出可用余额', icon: 'none' })
    }
    if (minWithdraw > 0 && amount < minWithdraw) {
      return wx.showToast({ title: `最低提现金额为 ¥${minWithdraw}`, icon: 'none' })
    }
    const quota = this.data.balance?.wechatTransferQuota || {}
    if (quota.singleMaxAmount !== null && quota.singleMaxAmount !== undefined && amount > Number(quota.singleMaxAmount || 0)) {
      return wx.showToast({ title: '单笔额度不足，请分多次提现', icon: 'none' })
    }
    if (quota.platformDailyRemainingAmount !== null && quota.platformDailyRemainingAmount !== undefined && amount > Number(quota.platformDailyRemainingAmount || 0)) {
      return wx.showModal({ title: '暂不可提现', content: '当日全平台转帐额度受限,请明日再申请', showCancel: false })
    }
    if (quota.recipientDailyRemainingAmount !== null && quota.recipientDailyRemainingAmount !== undefined && amount > Number(quota.recipientDailyRemainingAmount || 0)) {
      return wx.showModal({ title: '暂不可提现', content: quota.message || '当日个人微信转账额度受限,请明日再申请', showCancel: false })
    }
    this._submittingLock = true
    this.setData({ submitting: true })
    showLoading({ title: '正在提交提现...', mask: true })
    callFunction('finance', 'createWithdrawRequest', {
      amount,
      payoutChannel: 'wechat_wallet',
      clientRequestId: createClientRequestId('withdraw')
    })
      .then(() => {
        hideLoading()
        this._submittingLock = false
        wx.showToast({ title: '已提交提现', icon: 'success' })
        this.setData({ submitting: false, amount: '', activeTab: 'withdraws' })
        this.load()
      })
      .catch((error) => {
        hideLoading()
        this._submittingLock = false
        this.setData({ submitting: false })
        if (String(error.message || error.errMsg || error).includes('当日全平台转帐额度受限')) {
          wx.showModal({ title: '暂不可提现', content: '当日全平台转帐额度受限,请明日再申请', showCancel: false })
          this.load()
        } else {
          showError(error)
        }
      })
  },

  autoSyncPendingTransfers(withdraws) {
    if (!Array.isArray(withdraws) || !withdraws.length) return
    const now = Date.now()
    if (this._lastAutoSyncAt && now - this._lastAutoSyncAt < 8000) return
    const transferring = withdraws.filter(w => w && w.status === 'transferring' && w._id)
    if (!transferring.length) return
    this._lastAutoSyncAt = now
    Promise.all(transferring.slice(0, 2).map(item =>
      callFunction('finance', 'queryMyWithdrawTransfer', { id: item._id }).catch(() => null)
    )).then((results) => {
      const anyUpdated = (results || []).some(r => r && (r.status === 'paid' || r.transferStatus === 'success' || String(r.wechatTransferState || '').toUpperCase() === 'SUCCESS'))
      if (anyUpdated) {
        this.load()
      }
    })
  },

  queryWithdrawTransfer(e) {
    const id = e.currentTarget.dataset.id
    if (!id || this.data.transferBusy) return
    this.setData({ transferBusy: true, transferNotice: '' })
    showLoading({ title: '正在查询转账状态...', mask: true })
    callFunction('finance', 'queryMyWithdrawTransfer', { id })
      .then((res) => {
        hideLoading()
        const status = String(res && res.status || '').toLowerCase()
        const transferState = String(res && res.wechatTransferState || '').toUpperCase()
        if (status === 'paid' || transferState === 'SUCCESS') {
          wx.showToast({ title: '已成功到账微信零钱', icon: 'success' })
        } else {
          wx.showToast({ title: '转账状态已同步', icon: 'none' })
        }
        return this.load()
      })
      .catch((error) => {
        hideLoading()
        this.setData({ transferNotice: '转账状态同步失败，请稍后刷新重试。' })
        showError(error)
      })
      .finally(() => this.setData({ transferBusy: false }))
  },

  async autoCheckTransferStatus(id, retries = 5, delay = 1200) {
    if (!id) return
    this.setData({ transferNotice: '已完成确认收款，正在同步微信到账结果...' })
    showLoading({ title: '同步到账状态...', mask: true })
    for (let i = 0; i < retries; i++) {
      try {
        const res = await callFunction('finance', 'queryMyWithdrawTransfer', { id })
        const status = String(res && res.status || '').toLowerCase()
        const transferState = String(res && res.wechatTransferState || '').toUpperCase()
        if (status === 'paid' || transferState === 'SUCCESS') {
          hideLoading()
          wx.showToast({ title: '已成功到账微信零钱', icon: 'success', duration: 2500 })
          this.setData({ transferNotice: '款项已成功到账微信零钱！', confirmingId: '' })
          await this.load()
          return true
        }
      } catch (err) {
        console.warn('[autoCheckTransferStatus] 查询转账状态失败:', err)
      }
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
    hideLoading()
    this.setData({
      transferNotice: '收款确认已提交，微信正在打款中。可稍后点击“查询微信转账状态”或下拉刷新。',
      confirmingId: ''
    })
    await this.load()
    return false
  },

  confirmWithdrawTransfer(e) {
    const id = e.currentTarget.dataset.id
    if (!id || this._confirmingLock || this.data.transferBusy || this.data.confirmingId) return
    this._confirmingLock = true
    this.setData({ transferBusy: true, confirmingId: id, transferNotice: '' })
    showLoading({ title: '正在调起收款确认...', mask: true })
    callFunction('finance', 'getMyWithdrawTransferConfirmation', { id })
      .then((result) => {
        hideLoading()
        const status = String(result && result.status || '').toUpperCase()
        if (status === 'SUCCESS' || status === 'PAID') {
          this.setData({ transferNotice: '该笔提现已成功到账微信零钱。', confirmingId: '' })
          this._confirmingLock = false
          return this.load()
        }
        if (status !== 'WAIT_USER_CONFIRM' || !result.packageInfo) {
          this.setData({ transferNotice: '当前无需确认收款，请先查询最新转账状态。', confirmingId: '' })
          this._confirmingLock = false
          return this.load()
        }
        if (!result.mchId || !result.appId || typeof wx.requestMerchantTransfer !== 'function' || (typeof wx.canIUse === 'function' && !wx.canIUse('requestMerchantTransfer'))) {
          this.setData({ transferNotice: '当前微信版本不支持收款确认，请升级微信后重试。', confirmingId: '' })
          this._confirmingLock = false
          return
        }
        return new Promise((resolve, reject) => wx.requestMerchantTransfer({
          mchId: result.mchId,
          appId: result.appId,
          package: result.packageInfo,
          success: resolve,
          fail: reject
        })).then(() => {
          // 用户在微信弹窗完成确认，进入自动查单轮询更新状态流程
          return this.autoCheckTransferStatus(id)
        })
      })
      .catch((error) => {
        hideLoading()
        const errMsg = String(error && (error.errMsg || error.message || error))
        if (errMsg.includes('cancel')) {
          this.setData({ transferNotice: '已取消收款确认，可在24小时内重新点击确认。', confirmingId: '' })
        } else {
          this.setData({ transferNotice: '未能调起收款确认，请稍后查询转账状态重试。', confirmingId: '' })
          showError(error)
        }
      })
      .finally(() => {
        hideLoading()
        this._confirmingLock = false
        this.setData({ transferBusy: false, confirmingId: '' })
      })
  },

  ...navMethods()
})
