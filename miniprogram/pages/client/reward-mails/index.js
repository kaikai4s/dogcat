const { callFunction, showError, ensureLogin } = require('../../../utils/cloud')
const { formatDateTime } = require('../../../utils/format')

function rewardSummary(item) {
  const reward = item.reward || {}
  if (item.rewardType === 'coupon' || reward.type === 'coupon') {
    const coupon = reward.couponSnapshot || {}
    return coupon.name || '奖励优惠券'
  }
  if (item.rewardType === 'retro_card' || reward.type === 'retro_card') {
    return `补签卡 ${Number(reward.count || 0)} 张`
  }
  return `${Number(reward.points || 0)} 积分`
}

Page({
  data: {
    loading: false,
    mails: [],
    claimingId: ''
  },

  onShow() {
    ensureLogin({ content: '登录后可查看奖励邮箱。' })
      .then(() => this.load())
      .catch(() => {})
  },

  load() {
    this.setData({ loading: true })
    callFunction('rewardMail', 'listMyMails')
      .then((list) => {
        this.setData({
          mails: (list || []).map((item) => ({
            ...item,
            rewardSummary: rewardSummary(item),
            createdAtText: formatDateTime(item.createdAt)
          })),
          loading: false
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        showError(err)
      })
  },

  openMail(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.mails.find((record) => record._id === id)
    if (!item) return
    const showDetail = (mail) => {
      wx.showModal({
        title: mail.title,
        content: `${mail.content || '奖励已发放至你的账户。'}\n\n奖励内容：${mail.rewardSummary}`,
        showCancel: false,
        confirmText: mail.claimable ? '知道了' : '已领取'
      })
    }
    if (!item.unread) {
      showDetail(item)
      return
    }
    callFunction('rewardMail', 'markRead', { id })
      .then((mail) => {
        const updated = {
          ...item,
          ...mail,
          rewardSummary: rewardSummary(mail),
          createdAtText: formatDateTime(mail.createdAt)
        }
        this.setData({
          mails: this.data.mails.map((record) => (record._id === id ? updated : record))
        })
        showDetail(updated)
      })
      .catch(showError)
  },

  claimMail(e) {
    const id = e.currentTarget.dataset.id
    if (!id || this.data.claimingId) return
    this.setData({ claimingId: id })
    callFunction('rewardMail', 'claimReward', { id })
      .then((mail) => {
        wx.showToast({ title: '奖励已领取', icon: 'none' })
        this.setData({
          claimingId: '',
          mails: this.data.mails.map((record) => (record._id === id ? {
            ...record,
            ...mail,
            rewardSummary: rewardSummary(mail),
            createdAtText: formatDateTime(mail.createdAt)
          } : record))
        })
      })
      .catch((err) => {
        this.setData({ claimingId: '' })
        showError(err)
      })
  }
})
