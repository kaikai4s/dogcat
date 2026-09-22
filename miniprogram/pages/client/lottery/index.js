const { callFunction, showError, ensureLogin } = require('../../../utils/cloud')
const { formatDateTime } = require('../../../utils/format')

function decorateRecords(records = []) {
  return records.map((item) => {
    let prizeTag = '祝福'
    if (item.prizeType === 'points' || Number(item.points) > 0) {
      prizeTag = '积分'
    } else if (item.prizeType === 'coupon' || item.couponId) {
      prizeTag = '优惠券'
    } else if (!item.prizeText && item.prizeName === '谢谢参与') {
      prizeTag = '参与奖'
    }
    return {
      ...item,
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
        this.setData({ result: res })
        if (res.prizeType === 'coupon' || res.couponId) {
          wx.showToast({ title: `恭喜获得：${res.prizeName}`, icon: 'success', duration: 3000 })
        } else if (res.prizeType === 'points' || (res.points && res.points > 0)) {
          wx.showToast({ title: `恭喜获得：${res.prizeName}`, icon: 'success', duration: 3000 })
        } else {
          // 萌宠文字祝福：以专属弹窗展示暖心文案
          wx.showModal({
            title: `🐾 ${res.prizeName || '萌宠祝福'}`,
            content: res.prizeText || res.prizeName || '谢谢参与，祝您生活愉快！',
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
