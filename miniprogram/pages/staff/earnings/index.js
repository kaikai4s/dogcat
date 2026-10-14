const { callFunction, showError, showLoading, hideLoading } = require('../../../utils/cloud')
const { navMethods } = require('../../../utils/nav')
const { createClientRequestId } = require('../../../utils/offlineQueue')
const { applyTheme, getThemeState } = require('../../../utils/theme')

const WECHAT_MIN_TRANSFER_AMOUNT = 0.01
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

function money(value) {
  return Number(value || 0).toFixed(2)
}

function withEarning(item) {
  const status = String(item.status || '').toLowerCase()
  const isMock = item.isMock === true || item.paymentChannel === 'mock' || status === 'mock_settled' || status === 'mock'
  return {
    ...item,
    isMock,
    amountText: money(item.amount),
    grossAmountText: money(item.grossAmount),
    originalAmountText: money(item.originalAmount || item.amount),
    deductAmountText: money(item.deductAmount || 0),
    hasDeduction: Number(item.deductAmount || 0) > 0,
    statusText: isMock ? '模拟测试(不可提现)' : (earningStatusText[status] || '已记录')
  }
}

function withWithdraw(item) {
  const status = String(item.status || '').toLowerCase()
  const transferState = String(item.wechatTransferState || '').toUpperCase()
  return {
    ...item,
    amountText: money(item.amount),
    statusText: withdrawStatusText[status] || '处理中',
    canConfirmTransfer: transferState === 'WAIT_USER_CONFIRM' && Boolean(item.wechatPackageInfo || item.transferPackageInfo)
  }
}

Page({
  data: {
    themeClass: 'theme-day',
    balance: null,
    earnings: [],
    withdraws: [],
    amount: '',
    submitting: false,
    transferBusy: false,
    transferNotice: ''
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
          earnings: (earnings || []).map(withEarning),
          withdraws: (withdraws || []).map(withWithdraw)
        })
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
      return wx.showToast({ title: '微信零钱单笔最低 ¥0.01', icon: 'none' })
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
        this.setData({ submitting: false, amount: '' })
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

  queryWithdrawTransfer(e) {
    const id = e.currentTarget.dataset.id
    if (!id || this.data.transferBusy) return
    this.setData({ transferBusy: true, transferNotice: '' })
    callFunction('finance', 'queryMyWithdrawTransfer', { id })
      .then(() => this.load())
      .catch((error) => {
        this.setData({ transferNotice: '转账状态同步失败，请稍后刷新重试。' })
        showError(error)
      })
      .finally(() => this.setData({ transferBusy: false }))
  },

  confirmWithdrawTransfer(e) {
    const id = e.currentTarget.dataset.id
    if (!id || this.data.transferBusy) return
    this.setData({ transferBusy: true, transferNotice: '' })
    callFunction('finance', 'getMyWithdrawTransferConfirmation', { id })
      .then((result) => {
        if (String(result.status || '').toUpperCase() !== 'WAIT_USER_CONFIRM' || !result.packageInfo) {
          this.setData({ transferNotice: '当前无需确认收款，请先查询最新转账状态。' })
          return
        }
        if (!result.mchId || !result.appId || typeof wx.requestMerchantTransfer !== 'function' || (typeof wx.canIUse === 'function' && !wx.canIUse('requestMerchantTransfer'))) {
          this.setData({ transferNotice: '当前微信版本不支持收款确认，请升级微信后重试。' })
          return
        }
        return new Promise((resolve, reject) => wx.requestMerchantTransfer({
          mchId: result.mchId,
          appId: result.appId,
          package: result.packageInfo,
          success: resolve,
          fail: reject
        })).then(() => {
          this.setData({ transferNotice: '已展示收款确认页面，请以转账状态查询结果为准。' })
          return this.load()
        })
      })
      .catch((error) => {
        this.setData({ transferNotice: '未能确认收款，请稍后查询转账状态。' })
        showError(error)
      })
      .finally(() => this.setData({ transferBusy: false }))
  },

  ...navMethods()
})
