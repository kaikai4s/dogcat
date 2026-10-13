const { callFunction, showError, savePendingInvite, ensureLogin } = require('../../../../utils/cloud')
Page({
  data: { loading: false, summary: null, inviteCode: '', bindCode: '', withdrawing: false },
  onLoad(options = {}) { if (options.inviteCode || options.inviterOpenid) savePendingInvite(options) },
  onShow() {
    ensureLogin({ content: '登录后可查看资产和邀请收益。' })
      .then(() => this.load())
      .catch(() => {})
  },
  async load() {
    if (this.data.loading) return
    this.setData({ loading: true })
    try { const summary = await callFunction('finance', 'getUserAssetSummary'); this.setData({ summary, inviteCode: summary.inviteCode || '' }) }
    catch (error) { showError(error) }
    finally { this.setData({ loading: false }) }
  },
  inputBindCode(e) { this.setData({ bindCode: e.detail.value }) },
  async bindInvite() {
    const inviteCode = this.data.bindCode.trim()
    if (!inviteCode) return wx.showToast({ title: '请输入邀请码', icon: 'none' })
    try { await callFunction('finance', 'bindInviteCode', { inviteCode }); wx.showToast({ title: '绑定成功', icon: 'success' }); this.setData({ bindCode: '' }); this.load() }
    catch (error) { showError(error) }
  },
  async withdraw() {
    const summary = this.data.summary || {}
    if (this.data.withdrawing) return
    if (Number(summary.availableAmount || 0) < Number(summary.minWithdrawAmount || 0)) return wx.showToast({ title: '可提现余额未达到最低金额', icon: 'none' })
    this.setData({ withdrawing: true })
    try { await callFunction('finance', 'createUserAssetWithdraw', { amount: summary.availableAmount, clientRequestId: 'asset_' + Date.now() + '_' + Math.random().toString(16).slice(2, 8) }); wx.showToast({ title: '已提交提现申请', icon: 'success' }); this.load() }
    catch (error) { showError(error) }
    finally { this.setData({ withdrawing: false }) }
  },
  onShareAppMessage() {
    const code = this.data.inviteCode || ''
    return { title: '邀请好友注册，领取活动收益', path: '/pages/client/profile/assets/index?inviteCode=' + encodeURIComponent(code) }
  }
})
