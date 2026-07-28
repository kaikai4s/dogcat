const { callFunction, showError } = require('../../../../utils/cloud')
Page({
  data: { id: '', report: null },
  onLoad(q) { this.setData({ id: q.id }); callFunction('order', 'getServiceReport', { id: q.id }).then((report) => this.setData({ report })).catch(showError) }
})
