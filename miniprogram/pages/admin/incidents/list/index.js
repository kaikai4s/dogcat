const { callFunction, showError } = require('../../../../utils/cloud')
Page({
  data: { incidents: [] },
  onShow() { callFunction('incident', 'listIncidents').then((incidents) => this.setData({ incidents })).catch(showError) },
  resolve(e) { callFunction('incident', 'resolveIncident', { id: e.currentTarget.dataset.id }).then(() => this.onShow()).catch(showError) }
})
