const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { ensureLogin } = require('../../../../utils/cloud')
const { withCheckinText, formatDateTime, toBeijingDate } = require('../../../../utils/format')
const { applyTheme, getThemeState } = require('../../../../utils/theme')

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
  return formatDateTime(value).slice(6)
}

function getPointTimeValue(value) {
  if (!value) return 0
  if (typeof value === 'number') return value
  const date = toBeijingDate(value)
  const time = date ? date.getTime() : 0
  return Number.isNaN(time) ? 0 : time
}

function groupCheckinPhotos(checkins = []) {
  const map = {}
  checkins.filter((item) => item.mediaFileId).forEach((item) => {
    const eventType = item.eventType || ''
    if (!map[eventType]) map[eventType] = { eventType, eventTypeText: item.eventTypeText || eventType, count: 0, photos: [], remarks: [], remarkText: '' }
    map[eventType].count += 1
    map[eventType].photos.push(item)
    if (item.remark && !map[eventType].remarks.includes(item.remark)) map[eventType].remarks.push(item.remark)
    map[eventType].remarkText = map[eventType].remarks.join('；')
  })
  return Object.values(map)
}

function buildMapData(tracks, checkins) {
  const trackPoints = (tracks || []).map((item) => {
    const point = toMapPoint(item)
    return point ? { ...point, recordedAt: item.recordedAt, recordedAtValue: getPointTimeValue(item.recordedAt), recordedAtText: formatTrackTime(item.recordedAt), pointType: 'track' } : null
  }).filter(Boolean)
  const checkinPoints = (checkins || []).map((item) => {
    const point = toMapPoint(item)
    const recordedAt = item.recordedAt || item.createdAt || item.serverTime
    return point ? { ...point, recordedAt, recordedAtValue: getPointTimeValue(recordedAt), recordedAtText: formatTrackTime(recordedAt), pointType: 'checkin', checkin: item } : null
  }).filter(Boolean)
  const routePoints = trackPoints.concat(checkinPoints)
    .filter((item) => item.recordedAtValue > 0)
    .sort((a, b) => a.recordedAtValue - b.recordedAtValue)
  const fallbackPoints = trackPoints.concat(checkinPoints)
  const includePoints = routePoints.length ? routePoints : fallbackPoints
  const center = routePoints[0] || fallbackPoints[0]
  const markers = []

  if (routePoints.length > 0) {
    markers.push({
      id: 1,
      latitude: routePoints[0].latitude,
      longitude: routePoints[0].longitude,
      title: '服务起点',
      width: 30,
      height: 30,
      label: { content: '起点', color: '#16a34a', fontSize: 13, anchorX: -12, anchorY: -34, borderRadius: 12, bgColor: '#ffffff', padding: 6 },
      callout: { content: `服务起点 ${routePoints[0].recordedAtText || ''}`, color: '#16a34a', bgColor: '#ffffff', borderRadius: 12, padding: 8, display: 'BYCLICK' }
    })
    if (routePoints.length > 1) {
      const end = routePoints[routePoints.length - 1]
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

  const trackSummary = buildTrackSummary(routePoints)

  return {
    hasMapData: Boolean(center),
    mapLatitude: center ? center.latitude : 0,
    mapLongitude: center ? center.longitude : 0,
    includePoints,
    markers,
    trackSummary,
    polyline: routePoints.length > 1 ? [{
      points: routePoints.map((item) => ({ latitude: item.latitude, longitude: item.longitude })),
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
    themeClass: 'theme-day',
    id: '',
    tracks: [],
    checkins: [],
    checkinGroups: [],
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
    this.applyCurrentTheme()
    ensureLogin({ content: '登录后可查看服务轨迹。' })
      .then(() => this.load())
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },
  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
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
        checkinGroups: groupCheckinPhotos(mappedCheckins),
        ...buildMapData(tracks || [], mappedCheckins)
      })
    }).catch(showError)
  },
  previewCheckinPhoto(e) {
    const current = e.currentTarget.dataset.url
    const urls = this.data.checkins.map((item) => item.mediaFileId).filter(Boolean)
    if (current && urls.length) wx.previewImage({ current, urls })
  },
  ...navMethods()
})
