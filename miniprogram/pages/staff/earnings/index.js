const { callFunction, showError } = require('../../../utils/cloud')
const { navMethods } = require('../../../utils/nav')
const { createClientRequestId } = require('../../../utils/offlineQueue')
const { applyTheme, getThemeState } = require('../../../utils/theme')

function money(value) {
  return Number(value || 0).toFixed(2)
}

function withMoney(item) {
  return { ...item, amountText: money(item.amount), grossAmountText: money(item.grossAmount) }
}

Page({
  data: {
    themeClass: 'theme-day',
    balance: null,
    earnings: [],
    withdraws: [],
    amount: '',
    accountName: '',
    accountNo: '',
    submitting: false
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
        this.setData({
          balance: {
            ...balance,
            availableText: money(balance.available),
            pendingText: money(balance.pending),
            withdrawingText: money(balance.withdrawing),
            withdrawnText: money(balance.withdrawn),
            minWithdrawAmountText: money(balance.minWithdrawAmount)
          },
          amount: balance.available ? money(balance.available) : '',
          earnings: (earnings || []).map(withMoney),
          withdraws: (withdraws || []).map((item) => ({ ...item, amountText: money(item.amount) }))
        })
      })
      .catch(showError)
  },

  input(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value })
  },

  withdraw() {
    if (this.data.submitting) return
    this.setData({ submitting: true })
    callFunction('finance', 'createWithdrawRequest', {
      amount: Number(this.data.amount || 0),
      accountName: this.data.accountName,
      accountNo: this.data.accountNo,
      clientRequestId: createClientRequestId('withdraw')
    })
      .then(() => {
        wx.showToast({ title: '已提交提现' })
        this.setData({ submitting: false })
        this.load()
      })
      .catch((error) => {
        this.setData({ submitting: false })
        showError(error)
      })
  },

  ...navMethods()
})
