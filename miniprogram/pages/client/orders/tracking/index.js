const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { ensureLogin } = require('../../../../utils/cloud')
const { withCheckinText } = require('../../../../utils/format')

function toMapPoint(item) {
  const latitude = Number(item && item.latitude)
  const longitude = Number(item && item.longitude)
  if (!latitude || !longitude || Number.isNaN(latitude) || Number.isNaN(longitude)) return null
  return { latitude, longitude }
}

function buildMapData(tracks, checkins) {
  const trackPoints = (tracks || []).map(toMapPoint).filter(Boolean)
  const checkinPoints = (checkins || []).map((item) => {
    const point = toMapPoint(item)
    return point ? { ...point, checkin: item } : null
  }).filter(Boolean)
  const checkinMapPoints = checkinPoints.map((item) => ({ latitude: item.latitude, longitude: item.longitude }))
  const includePoints = trackPoints.concat(checkinMapPoints)
  const routePoints = trackPoints.length > 1 ? trackPoints : []
  const center = routePoints[0] || checkinMapPoints[0] || includePoints[0]
  const markers = []

  if (trackPoints.length > 0) {
    markers.push({
      id: 1,
      latitude: trackPoints[0].latitude,
      longitude: trackPoints[0].longitude,
      title: '服务起点',
      callout: { content: '服务起点', display: 'BYCLICK' }
    })
    if (trackPoints.length > 1) {
      const end = trackPoints[trackPoints.length - 1]
      markers.push({
        id: 2,
        latitude: end.latitude,
        longitude: end.longitude,
        title: '服务终点',
        callout: { content: '服务终点', display: 'BYCLICK' }
      })
    }
  }

  checkinPoints.forEach((item, index) => {
    markers.push({
      id: 100 + index,
      latitude: item.latitude,
      longitude: item.longitude,
      title: item.checkin.eventTypeText || '服务打卡',
      callout: { content: item.checkin.eventTypeText || '服务打卡', display: 'BYCLICK' }
    })
  })

  return {
    hasMapData: Boolean(center),
    mapLatitude: center ? center.latitude : 0,
    mapLongitude: center ? center.longitude : 0,
    includePoints,
    markers,
    polyline: routePoints.length > 1 ? [{ points: routePoints, color: '#FF6B9B', width: 5 }] : []
  }
}

Page({
  data: {
    id: '',
    tracks: [],
    checkins: [],
    mapLatitude: 0,
    mapLongitude: 0,
    polyline: [],
    markers: [],
    includePoints: [],
    hasMapData: false,
    sectionHomeUrl: '',
    canGoBack: false
  },
  onLoad(q) { this.setData({ ...createPageNav(q), id: q.id }) },
  onShow() {
    ensureLogin({ content: '登录后可查看服务轨迹。' })
      .then(() => this.load())
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },
  load() {
    Promise.all([
      callFunction('track', 'getOrderTracks', { orderId: this.data.id }),
      callFunction('checkin', 'listOrderCheckins', { orderId: this.data.id })
    ]).then(([tracks, checkins]) => {
      const mappedCheckins = (checkins || []).map(withCheckinText)
      this.setData({
        tracks: tracks || [],
        checkins: mappedCheckins,
        ...buildMapData(tracks || [], mappedCheckins)
      })
    }).catch(showError)
  },
  ...navMethods()
})
