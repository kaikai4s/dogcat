const { callFunction, showError } = require('../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../utils/nav')
const { requireSelectedLocation } = require('../../../utils/cloud')
const { createClientRequestId } = require('../../../utils/offlineQueue')

Page({
  data: { orderId: '', description: '', submitting: false, sectionHomeUrl: '', canGoBack: false },
  onLoad(q) { this.setData({ ...createPageNav(q), orderId: q.id }) },
  input(e) { this.setData({ description: e.detail.value }) },
  submit() {
    if (this.data.submitting) return
    this.setData({ submitting: true })
    requireSelectedLocation()
      .then((loc) => callFunction('incident', 'createSosIncident', {
        orderId: this.data.orderId,
        description: this.data.description,
        latitude: loc.latitude,
        longitude: loc.longitude,
        clientRequestId: createClientRequestId('sos')
      }))
      .then((incident) => {
        wx.showToast({ title: '已上报' })
        this.setData({ submitting: false })
        wx.redirectTo({ url: `/pages/staff/incidents/detail/index?id=${incident._id}` })
      })
      .catch((error) => {
        this.setData({ submitting: false })
        showError(error)
      })
  },
  ...navMethods()
})
