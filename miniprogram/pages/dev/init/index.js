const { callFunction, showError } = require('../../../utils/cloud')

Page({
  data: {
    collections: [],
    result: null,
    initAdminSecret: ''
  },

  checkCollections() {
    callFunction('initData', 'checkCollections', { secret: this.data.initAdminSecret })
      .then((collections) => this.setData({ collections }))
      .catch(showError)
  },

  inputInitAdminSecret(e) {
    this.setData({ initAdminSecret: e.detail.value })
  },

  seedAdmin() {
    callFunction('initData', 'claimInitialAdmin', { secret: this.data.initAdminSecret })
      .then((result) => {
        this.setData({ result })
        wx.showToast({ title: '已设为管理员' })
      })
      .catch(showError)
  },

  seedDemoData() {
    callFunction('initData', 'seedDemoData')
      .then((result) => {
        this.setData({ result })
        wx.showToast({ title: '演示数据已生成' })
      })
      .catch(showError)
  }
})
