const { callFunction, showError, showLoading, hideLoading, savePendingInvite, ensureLogin, loadSystemSettings, getCachedSystemSettings } = require('../../../../utils/cloud')
const { copyText } = require('../../../../utils/clipboard')

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

function withWithdraw(item) {
  const status = String(item.status || '').toLowerCase()
  const transferState = String(item.wechatTransferState || '').toUpperCase()
  const isAccepted = transferState === 'ACCEPTED'
  const canConfirmTransfer = item.payoutChannel === 'wechat_wallet' && transferState === 'WAIT_USER_CONFIRM'
  let statusText = withdrawStatusText[status] || item.statusText || '处理中'
  if (canConfirmTransfer) {
    statusText = '待确认收款'
  }
  return {
    ...item,
    amountText: Number(item.amount || 0).toFixed(2),
    statusText,
    wechatTransferStateText: wechatTransferStateText[transferState] || item.wechatTransferStateText || transferState,
    isAccepted,
    canConfirmTransfer
  }
}

Page({
  data: {
    activeTab: 'invites', // 'invites' | 'earnings' | 'withdraws'
    loading: false,
    summary: null,
    inviteCode: '',
    invitationMaintenance: false,
    maintenanceLoading: true,
    bindCode: '',
    incomingInviteCode: '',
    autoBindingInvite: false,
    invitationShareImageUrl: '',
    withdrawAmount: '',
    withdrawing: false,
    transferBusy: false,
    confirmingId: '',
    transferNotice: '',
    hasPendingWithdrawConfirm: false
  },

  onLoad(options = {}) {
    const incomingInviteCode = String(options.inviteCode || '').trim().toUpperCase()
    if (options.inviteCode || options.inviterOpenid) savePendingInvite(options)
    if (incomingInviteCode) this.setData({ incomingInviteCode })
    if (options.tab && ['invites', 'earnings', 'withdraws'].includes(options.tab)) {
      this.setData({ activeTab: options.tab })
    }
  },

  onShow() {
    this.refreshMaintenance()
    ensureLogin({ content: '登录后可查看资产和邀请收益。' })
      .then(() => this.load())
      .catch(() => {})
  },

  async onPullDownRefresh() {
    try {
      await ensureLogin({ content: '登录后可查看资产和邀请收益。' })
      await this.refreshMaintenance()
      await this.load()
    } catch (_) {
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  refreshMaintenance() {
    const cached = getCachedSystemSettings()
    this.setData({ invitationMaintenance: cached.maintenance?.invitation === true, maintenanceLoading: true })
    return loadSystemSettings().then((settings) => {
      this.setData({ invitationMaintenance: settings.maintenance?.invitation === true, maintenanceLoading: false })
      if (this.data.summary && !this.data.invitationMaintenance) return this.autoBindIncomingInvite(this.data.summary)
    }).catch(() => this.setData({ maintenanceLoading: false }))
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
      const withdraws = (summary.withdraws || []).map(withWithdraw)
      const hasPendingWithdrawConfirm = withdraws.some(item => item.canConfirmTransfer)
      this.setData({
        summary: {
          ...summary,
          withdraws
        },
        hasPendingWithdrawConfirm,
        inviteCode: summary.inviteCode || '',
        invitationShareImageUrl: summary.invitationShareImageUrl || '',
        withdrawAmount: maxAmount > 0 ? maxAmount.toFixed(2) : ''
      })
      if (!this.data.invitationMaintenance && !this.data.maintenanceLoading) await this.autoBindIncomingInvite(summary)
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
    if (this.data.invitationMaintenance || this.data.maintenanceLoading) return
    copyText(this.data.inviteCode, { successTitle: '邀请码已复制', emptyTitle: '暂无邀请码' })
  },

  async autoBindIncomingInvite(summary = {}) {
    if (this.data.invitationMaintenance || this.data.maintenanceLoading) return
    const inviteCode = String(this.data.incomingInviteCode || '').trim().toUpperCase()
    if (!inviteCode || this.data.autoBindingInvite || summary.inviterOpenid || inviteCode === String(summary.inviteCode || '').trim().toUpperCase()) return
    this.setData({ autoBindingInvite: true })
    try {
      await callFunction('finance', 'bindInviteCode', { inviteCode, bindingSource: 'share' })
      wx.showToast({ title: '已绑定邀请', icon: 'success' })
      this.setData({ incomingInviteCode: '', bindCode: '' })
      const summary = await callFunction('finance', 'getUserAssetSummary')
      const quota = summary.wechatTransferQuota || {}
      const maxAmount = quota.effectiveRemainingAmount === null || quota.effectiveRemainingAmount === undefined
        ? Number(summary.availableAmount || 0)
        : Math.min(Number(summary.availableAmount || 0), Number(quota.effectiveRemainingAmount || 0))
      const withdraws = (summary.withdraws || []).map(withWithdraw)
      const hasPendingWithdrawConfirm = withdraws.some(item => item.canConfirmTransfer)
      this.setData({
        summary: {
          ...summary,
          withdraws
        },
        hasPendingWithdrawConfirm,
        inviteCode: summary.inviteCode || '',
        invitationShareImageUrl: summary.invitationShareImageUrl || '',
        withdrawAmount: maxAmount > 0 ? maxAmount.toFixed(2) : ''
      })
    } catch (error) {
      const message = String(error.message || error.errMsg || error)
      if (!message.includes('只能绑定一次') && !message.includes('邀请码无效')) showError(error)
      this.setData({ incomingInviteCode: '' })
    } finally {
      this.setData({ autoBindingInvite: false })
    }
  },

  switchRecordTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab && tab !== this.data.activeTab) {
      this.setData({ activeTab: tab })
    }
  },

  goToWithdrawsTab() {
    this.setData({ activeTab: 'withdraws' })
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

  async bindInvite() {
    if (this.data.invitationMaintenance || this.data.maintenanceLoading) return
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
    if (this.data.invitationMaintenance || this.data.maintenanceLoading) return { title: '我的资产', path: '/pages/client/profile/assets/index' }
    const code = this.data.inviteCode || ''
    const shareObj = {
      title: '邀请好友注册，领取活动收益',
      path: '/pages/client/profile/assets/index?inviteCode=' + encodeURIComponent(code)
    }
    if (this.data.invitationShareImageUrl) shareObj.imageUrl = this.data.invitationShareImageUrl
    return shareObj
  }
})
