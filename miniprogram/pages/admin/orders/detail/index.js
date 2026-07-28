const { callFunction, showError } = require('../../../../utils/cloud')
Page({
  data: { id: '', detail: null },
  onLoad(q) { this.setData({ id: q.id }); this.load() },
  load() { callFunction('admin', 'getOrderDetail', { id: this.data.id }).then((detail) => this.setData({ detail })).catch(showError) },
  evidence() { wx.navigateTo({ url: '/pages/admin/evidence/detail/index?id=' + this.data.id }) }
})
