const { callFunction, showError } = require('../../../../utils/cloud')
const { withIncidentText } = require('../../../../utils/format')

const statusTabs = [
  { label: '全部', value: '' },
  { label: '待处理', value: 'open' },
  { label: '处理中', value: 'processing' },
  { label: '已结案', value: 'resolved' }
]

Page({
  data: { incidents: [], statusTabs, status: '', orderId: '' },

  onLoad(q) {
    this.setData({ orderId: q.orderId || '' })
  },

  onShow() {
    this.load()
  },

  load() {
    callFunction('incident', 'listIncidents', { status: this.data.status, orderId: this.data.orderId })
      .then((incidents) => this.setData({ incidents: incidents.map(withIncidentText) }))
      .catch(showError)
  },

  switchStatus(e) {
    this.setData({ status: e.currentTarget.dataset.status || '' }, this.load)
  },

  resolve(e) {
    callFunction('incident', 'resolveIncident', { id: e.currentTarget.dataset.id }).then(() => this.load()).catch(showError)
  },

  detail(e) {
    wx.navigateTo({ url: `/pages/admin/incidents/detail/index?id=${e.currentTarget.dataset.id}` })
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  }
})
