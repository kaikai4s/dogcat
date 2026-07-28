const { callFunction, showError } = require('../../../../utils/cloud')
Page({
  data: { id: '', evidence: null },
  onLoad(q) { this.setData({ id: q.id }); callFunction('admin', 'getEvidence', { orderId: q.id }).then((evidence) => this.setData({ evidence })).catch(showError) }
})
