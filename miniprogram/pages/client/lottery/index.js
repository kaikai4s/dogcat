const { callFunction, showError, ensureLogin } = require('../../../utils/cloud')

function formatRecordTime(value) {
  if (!value) return ''
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value).replace(/-/g, '/'))
  if (Number.isNaN(date.getTime())) return ''
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${month}-${day} ${hour}:${minute}`
}

function decorateRecords(records = []) {
  return records.map((item) => ({
    ...item,
    createdAtText: formatRecordTime(item.createdAt),
    prizeTag: item.couponId ? '优惠券' : '参与奖'
  }))
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
        if (res.couponId) {
          wx.showToast({ title: `恭喜获得：${res.prizeName}`, icon: 'success', duration: 3000 })
        } else {
          wx.showToast({ title: res.prizeName || '谢谢参与', icon: 'none', duration: 2000 })
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
