const { callFunction, showError, ensureLogin } = require('../../../utils/cloud')
const { formatDateTime } = require('../../../utils/format')

function decorateRecords(records = []) {
  return records.map((item) => {
    let prizeTag = '祝福'
    if (item.prizeType === 'points' || Number(item.points) > 0) {
      prizeTag = '积分'
    } else if (item.prizeType === 'coupon' || item.couponId) {
      prizeTag = '优惠券'
    } else if (item.prizeType === 'pet_title' || item.titleId) {
      prizeTag = '宠物头衔'
    } else if (!item.prizeText && item.prizeName === '谢谢参与') {
      prizeTag = '参与奖'
    }

    const prizeName = item.prizeName || '萌宠祝福'
    const prizeText = item.prizeText || (item.prizeType === 'text' ? '毛孩子给你送来满满元气与好运，愿你今天顺遂无忧、心情如阳光般明媚！' : '')

    return {
      ...item,
      prizeName,
      prizeText,
      createdAtText: formatDateTime(item.createdAt),
      prizeTag
    }
  })
}

Page({
  data: {
    activity: null,
    drawing: false,
    result: null,
    records: [],
    loadingRecords: false
  },

  onShow() {
    ensureLogin({ content: '登录后可参与抽奖。' })
      .then(() => {
        this.load()
        this.loadRecords()
      })
      .catch(() => {})
  },

  load() {
    callFunction('lottery', 'getActiveActivity')
      .then((activity) => this.setData({ activity, result: null }))
      .catch(showError)
  },

  loadRecords() {
    this.setData({ loadingRecords: true })
    callFunction('lottery', 'listMyRecords', { pageSize: 20 })
      .then((records) => this.setData({ records: decorateRecords(records), loadingRecords: false }))
      .catch((error) => {
        this.setData({ loadingRecords: false })
        showError(error)
      })
  },

  draw() {
    if (this.data.drawing || !this.data.activity || !this.data.activity.canDraw) return
    this.setData({ drawing: true })
    callFunction('lottery', 'draw')
      .then((res) => {
        const result = res || {}
        this.setData({ result })
        if (result.prizeType === 'coupon' || result.couponId) {
          wx.showToast({ title: `恭喜获得：${result.prizeName}`, icon: 'success', duration: 3000 })
        } else if (result.prizeType === 'points' || (result.points && result.points > 0)) {
          wx.showToast({ title: `恭喜获得：${result.prizeName}`, icon: 'success', duration: 3000 })
        } else if (result.prizeType === 'pet_title' || result.titleId) {
          wx.showModal({
            title: '恭喜获得宠物头衔',
            content: `${result.prizeName || '宠物头衔'} 已发送到奖励邮箱，请领取后为宠物佩戴。`,
            showCancel: true,
            confirmText: '去邮箱',
            cancelText: '稍后领取',
            success: (modalRes) => {
              if (modalRes.confirm) wx.navigateTo({ url: '/pages/client/reward-mails/index' })
            }
          })
        } else {
          // 萌宠文字祝福：以专属弹窗展示暖心文案
          wx.showModal({
            title: `🐾 ${result.prizeName || '萌宠祝福'}`,
            content: result.prizeText || '愿可爱的毛孩子带给你满满的元气与好运！',
            showCancel: false,
            confirmText: '收到祝福',
            confirmColor: '#e05c8b'
          })
        }
        this.load()
        this.loadRecords()
      })
      .catch((err) => {
        wx.showToast({ title: err.message || '抽奖失败', icon: 'none' })
      })
      .finally(() => this.setData({ drawing: false }))
  }
})
