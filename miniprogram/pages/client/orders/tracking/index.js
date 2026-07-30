const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { withCheckinText } = require('../../../../utils/format')

Page({
  data: { id: '', tracks: [], checkins: [], sectionHomeUrl: '', canGoBack: false },
  onLoad(q) { this.setData({ ...createPageNav(q), id: q.id }); this.load() },
  load() { Promise.all([callFunction('track', 'getOrderTracks', { orderId: this.data.id }), callFunction('checkin', 'listOrderCheckins', { orderId: this.data.id })]).then(([tracks, checkins]) => this.setData({ tracks, checkins: checkins.map(withCheckinText) })).catch(showError) },
  ...navMethods()
})
