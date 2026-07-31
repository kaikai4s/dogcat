const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { ensureLogin } = require('../../../../utils/cloud')
const { withCheckinText } = require('../../../../utils/format')

Page({
  data: { id: '', tracks: [], checkins: [], sectionHomeUrl: '', canGoBack: false },
  onLoad(q) { this.setData({ ...createPageNav(q), id: q.id }) },
  onShow() {
    ensureLogin({ content: '登录后可查看服务轨迹。' })
      .then(() => this.load())
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },
  load() { Promise.all([callFunction('track', 'getOrderTracks', { orderId: this.data.id }), callFunction('checkin', 'listOrderCheckins', { orderId: this.data.id })]).then(([tracks, checkins]) => this.setData({ tracks, checkins: checkins.map(withCheckinText) })).catch(showError) },
  ...navMethods()
})
