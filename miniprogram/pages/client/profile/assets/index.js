const { callFunction, showError, savePendingInvite, ensureLogin } = require('../../../../utils/cloud')
const { copyText } = require('../../../../utils/clipboard')

Page({
  data: {
    loading: false,
    summary: null,
    inviteCode: '',
    bindCode: '',
    withdrawAmount: '',
    withdrawing: false
  },

  onLoad(options = {}) {
    if (options.inviteCode || options.inviterOpenid) savePendingInvite(options)
  },

  onShow() {
    ensureLogin({ content: '登录后可查看资产和邀请收益。' })
      .then(() => this.load())
      .catch(() => {})
  },

  async onPullDownRefresh() {
    try {
      await ensureLogin({ content: '登录后可查看资产和邀请收益。' })
      await this.load()
    } catch (_) {
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  async load() {
    if (this.data.loading) return
    this.setData({ loading: true })
    try {
      const summary = await callFunction('finance', 'getUserAssetSummary')
      const quota = summary.wechatTransferQuota || {}
      const maxAmount = quota.effectiveRemainingAmount === null || quota.effectiveRemainingAmount === undefined
        ? Number(summary.availableAmount || 0)
        : Math.min(Number(summary.availableAmount || 0), Number(quota.effectiveRemainingAmount || 0))
      this.setData({ summary, inviteCode: summary.inviteCode || '', withdrawAmount: maxAmount > 0 ? maxAmount.toFixed(2) : '' })
    } catch (error) {
      showError(error)
    } finally {
      this.setData({ loading: false })
    }
  },

  inputBindCode(e) {
    this.setData({ bindCode: e.detail.value })
  },

  inputWithdrawAmount(e) {
    this.setData({ withdrawAmount: e.detail.value })
  },

  copyInviteCode() {
    copyText(this.data.inviteCode, { successTitle: '邀请码已复制', emptyTitle: '暂无邀请码' })
  },

  async bindInvite() {
    const inviteCode = this.data.bindCode.trim()
    if (!inviteCode) return wx.showToast({ title: '请输入邀请码', icon: 'none' })
    try {
      await callFunction('finance', 'bindInviteCode', { inviteCode })
      wx.showToast({ title: '绑定成功', icon: 'success' })
      this.setData({ bindCode: '' })
      this.load()
    } catch (error) {
      showError(error)
    }
  },

  async withdraw() {
    const summary = this.data.summary || {}
    const quota = summary.wechatTransferQuota || {}
    const amount = Number(this.data.withdrawAmount || 0)
    if (this.data.withdrawing) return
    if (!amount || amount <= 0) return wx.showToast({ title: '请输入提现金额', icon: 'none' })
    if (amount > Number(summary.availableAmount || 0)) return wx.showToast({ title: '提现金额超出可用余额', icon: 'none' })
    if (Number(summary.availableAmount || 0) < Number(summary.minWithdrawAmount || 0) || amount < Number(summary.minWithdrawAmount || 0)) return wx.showToast({ title: '可提现余额未达到最低金额', icon: 'none' })
    if (quota.singleMaxAmount !== null && quota.singleMaxAmount !== undefined && amount > Number(quota.singleMaxAmount || 0)) return wx.showToast({ title: '单笔额度不足，请分多次提现', icon: 'none' })
    if (quota.platformDailyRemainingAmount !== null && quota.platformDailyRemainingAmount !== undefined && amount > Number(quota.platformDailyRemainingAmount || 0)) return wx.showModal({ title: '暂不可提现', content: '当日全平台转帐额度受限,请明日再申请', showCancel: false })
    if (quota.recipientDailyRemainingAmount !== null && quota.recipientDailyRemainingAmount !== undefined && amount > Number(quota.recipientDailyRemainingAmount || 0)) return wx.showModal({ title: '暂不可提现', content: quota.message || '当日个人微信转账额度受限,请明日再申请', showCancel: false })
    this.setData({ withdrawing: true })
    try {
      await callFunction('finance', 'createUserAssetWithdraw', {
        amount,
        clientRequestId: 'asset_' + Date.now() + '_' + Math.random().toString(16).slice(2, 8)
      })
      wx.showToast({ title: '已提交提现申请', icon: 'success' })
      this.load()
    } catch (error) {
      if (String(error.message || error.errMsg || error).includes('当日全平台转帐额度受限')) {
        wx.showModal({ title: '暂不可提现', content: '当日全平台转帐额度受限,请明日再申请', showCancel: false })
        this.load()
      } else {
        showError(error)
      }
    } finally {
      this.setData({ withdrawing: false })
    }
  },

  onShareAppMessage() {
    const code = this.data.inviteCode || ''
    return {
      title: '邀请好友注册，领取活动收益',
      path: '/pages/client/profile/assets/index?inviteCode=' + encodeURIComponent(code)
    }
  }
})
