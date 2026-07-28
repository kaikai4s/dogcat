const { callFunction, showError } = require('../../../../utils/cloud')
Page({
  data: { id: '', tracks: [], checkins: [] },
  onLoad(q) { this.setData({ id: q.id }); this.load() },
  load() { Promise.all([callFunction('track', 'getOrderTracks', { orderId: this.data.id }), callFunction('checkin', 'listOrderCheckins', { orderId: this.data.id })]).then(([tracks, checkins]) => this.setData({ tracks, checkins })).catch(showError) }
})
