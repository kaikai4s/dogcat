const { callFunction, showError } = require('../../../utils/cloud')

Page({
  data: {
    collections: [],
    result: null
  },

  checkCollections() {
    callFunction('initData', 'checkCollections')
      .then((collections) => this.setData({ collections }))
      .catch(showError)
  },

  seedAdmin() {
    callFunction('initData', 'seedAdmin')
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
