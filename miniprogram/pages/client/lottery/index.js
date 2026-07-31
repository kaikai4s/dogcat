const { callFunction, showError, ensureLogin } = require('../../../utils/cloud')

Page({
  data: {
    activity: null,
    drawing: false,
    result: null
  },

  onShow() {
    ensureLogin({ content: '登录后可参与抽奖。' })
      .then(() => this.load())
      .catch(() => {})
  },

  load() {
    callFunction('lottery', 'getActiveActivity')
      .then((activity) => this.setData({ activity, result: null }))
      .catch(showError)
  },

  draw() {
    if (this.data.drawing) return
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
      })
      .catch((err) => {
        wx.showToast({ title: err.message || '抽奖失败', icon: 'none' })
      })
      .finally(() => this.setData({ drawing: false }))
  }
})
