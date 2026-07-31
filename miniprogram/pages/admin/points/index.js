const { callFunction, showError } = require('../../../utils/cloud')

Page({
  data: {
    logs: [],
    form: { openid: '', delta: '', reason: '' },
    filterOpenid: ''
  },

  onShow() {
    this.load()
  },

  load() {
    callFunction('admin', 'listPointLogs', { openid: this.data.filterOpenid })
      .then((logs) => this.setData({ logs }))
      .catch(showError)
  },

  input(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ ['form.' + field]: e.detail.value })
  },

  filterInput(e) {
    this.setData({ filterOpenid: e.detail.value })
  },

  search() {
    this.load()
  },

  grant() {
    const { openid, delta, reason } = this.data.form
    if (!openid) return wx.showToast({ title: '请填写用户 openid', icon: 'none' })
    const deltaNum = Math.round(Number(delta))
    if (!deltaNum) return wx.showToast({ title: '积分变动不能为 0', icon: 'none' })
    callFunction('admin', 'grantPoints', { openid, delta: deltaNum, reason })
      .then(() => {
        wx.showToast({ title: '已操作' })
        this.setData({ form: { openid: '', delta: '', reason: '' } })
        this.load()
      })
      .catch(showError)
  }
})
