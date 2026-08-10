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

function calcDistanceKm(lat1, lng1, lat2, lng2) {
  const toRad = (degree) => degree * Math.PI / 180
  const radius = 6371
  const radLat1 = toRad(lat1)
  const radLat2 = toRad(lat2)
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(radLat1) * Math.cos(radLat2) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2)
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function formatDistance(distanceKm) {
  return distanceKm < 1 ? `${Math.round(distanceKm * 1000)}m` : `${distanceKm.toFixed(2)}km`
}

function buildTrackSummary(trackPoints) {
  let distanceKm = 0
  for (let i = 1; i < trackPoints.length; i += 1) {
    distanceKm += calcDistanceKm(trackPoints[i - 1].latitude, trackPoints[i - 1].longitude, trackPoints[i].latitude, trackPoints[i].longitude)
  }
  return {
    distanceText: trackPoints.length > 1 ? formatDistance(distanceKm) : '暂无',
    startTimeText: trackPoints[0] && trackPoints[0].recordedAtText || '--',
    endTimeText: trackPoints[trackPoints.length - 1] && trackPoints[trackPoints.length - 1].recordedAtText || '--'
  }
}

function formatTrackTime(value) {
  if (!value) return ''
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value).replace(/-/g, '/'))
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function buildMapData(tracks, checkins) {
  const trackPoints = (tracks || []).map((item) => {
    const point = toMapPoint(item)
    return point ? { ...point, recordedAtText: formatTrackTime(item.recordedAt) } : null
  }).filter(Boolean)
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
      width: 30,
      height: 30,
      label: { content: '起点', color: '#16a34a', fontSize: 13, anchorX: -12, anchorY: -34, borderRadius: 12, bgColor: '#ffffff', padding: 6 },
      callout: { content: `服务起点 ${trackPoints[0].recordedAtText || ''}`, color: '#16a34a', bgColor: '#ffffff', borderRadius: 12, padding: 8, display: 'BYCLICK' }
    })
    if (trackPoints.length > 1) {
      const end = trackPoints[trackPoints.length - 1]
      markers.push({
        id: 2,
        latitude: end.latitude,
        longitude: end.longitude,
        title: '服务终点',
        width: 30,
        height: 30,
        label: { content: '终点', color: '#e11d48', fontSize: 13, anchorX: -12, anchorY: -34, borderRadius: 12, bgColor: '#ffffff', padding: 6 },
        callout: { content: `服务终点 ${end.recordedAtText || ''}`, color: '#e11d48', bgColor: '#ffffff', borderRadius: 12, padding: 8, display: 'BYCLICK' }
      })
    }
  }

  checkinPoints.forEach((item, index) => {
    const title = item.checkin.eventTypeText || '服务打卡'
    markers.push({
      id: 100 + index,
      latitude: item.latitude,
      longitude: item.longitude,
      title,
      width: 26,
      height: 26,
      label: { content: title, color: '#ff4f87', fontSize: 12, anchorX: -18, anchorY: -30, borderRadius: 12, bgColor: '#fff0f6', padding: 6 },
      callout: { content: title, color: '#ff4f87', bgColor: '#ffffff', borderRadius: 12, padding: 8, display: 'BYCLICK' }
    })
  })

  const trackSummary = buildTrackSummary(trackPoints)

  return {
    hasMapData: Boolean(center),
    mapLatitude: center ? center.latitude : 0,
    mapLongitude: center ? center.longitude : 0,
    includePoints,
    markers,
    trackSummary,
    polyline: routePoints.length > 1 ? [{
      points: routePoints,
      color: '#ff4f87cc',
      width: 8,
      borderColor: '#ffffff',
      borderWidth: 2,
      arrowLine: true
    }] : []
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
    trackSummary: { distanceText: '暂无', startTimeText: '--', endTimeText: '--' },
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
