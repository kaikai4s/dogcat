const { callFunction, showError } = require('../../../../utils/cloud')
const { withIncidentText } = require('../../../../utils/format')
Page({
  data: { incidents: [] },
  onShow() { callFunction('incident', 'listIncidents').then((incidents) => this.setData({ incidents: incidents.map(withIncidentText) })).catch(showError) },
  resolve(e) { callFunction('incident', 'resolveIncident', { id: e.currentTarget.dataset.id }).then(() => this.onShow()).catch(showError) },
  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  }
})
