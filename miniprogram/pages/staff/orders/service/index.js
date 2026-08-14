const { callFunction, showError, getServiceLocation, requirePrivacyAuthorize, requestSubscribeTemplates } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { createClientRequestId, enqueueOfflineTask, getOfflineTasks, getOfflineTaskCount, removeOfflineTask, updateOfflineTask } = require('../../../../utils/offlineQueue')

const TRACK_INTERVAL_MS = 60 * 1000
const TRACK_MIN_DISTANCE_M = 50
const MAX_ACCEPTABLE_ACCURACY_M = 200

function hasCoordinate(latitude, longitude) {
  const lat = Number(latitude)
  const lng = Number(longitude)
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) > 0.000001 && Math.abs(lng) > 0.000001
}

function calcDistanceM(lat1, lng1, lat2, lng2) {
  const toRad = (degree) => degree * Math.PI / 180
  const radius = 6371000
  const radLat1 = toRad(Number(lat1))
  const radLat2 = toRad(Number(lat2))
  const dLat = toRad(Number(lat2) - Number(lat1))
  const dLng = toRad(Number(lng2) - Number(lng1))
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(radLat1) * Math.cos(radLat2) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2)
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function toTrackPoint(location) {
  const latitude = Number(location && location.latitude)
  const longitude = Number(location && location.longitude)
  if (!hasCoordinate(latitude, longitude)) return null
  return {
    latitude,
    longitude,
    accuracy: Number(location.accuracy || 0),
    speed: Number(location.speed || 0),
    recordedAt: Date.now()
  }
}

Page({
  data: {
    id: '',
    order: null,
    unlock: null,
    pointCount: 0,
    autoTracking: false,
    backgroundTracking: false,
    trackStatusText: '服务开始后自动记录轨迹',
    latestTrackText: '',
    offlineTaskCount: 0,
    starting: false,
    finishing: false,
    sectionHomeUrl: '',
    canGoBack: false
  },

  onLoad(q) {
    this.setData({ ...createPageNav(q), id: q.id })
    this.loadOrder()
  },

  onUnload() {
    this.stopAutoTracking()
  },

  loadOrder() {
    callFunction('order', 'getOrderDetail', { id: this.data.id })
      .then((order) => {
        this.setData({ order, offlineTaskCount: getOfflineTaskCount(this.data.id) })
        if (order && order.status === 'in_service') {
          this.flushOfflineTasks()
          this.startAutoTracking()
        }
      })
      .catch(() => {})
  },

  previewPetPhoto() {
    const photo = this.data.order && this.data.order.petSnapshot && this.data.order.petSnapshot.avatarFileId
    if (photo) wx.previewImage({ urls: [photo] })
  },

  start() {
    if (this.data.starting) return
    this.setData({ starting: true })
    requestSubscribeTemplates(['serviceStart', 'serviceFinish'], 'staff_service')
      .then(() => callFunction('order', 'startService', { id: this.data.id, clientRequestId: createClientRequestId('start_service') }))
      .then(() => {
        wx.showToast({ title: '已开始' })
        this.setData({ starting: false, order: { ...(this.data.order || {}), status: 'in_service' } })
        this.startAutoTracking()
      })
      .catch((error) => {
        this.setData({ starting: false })
        showError(error)
      })
  },

  unlock() {
    callFunction('homeSecurity', 'getUnlockCode', { orderId: this.data.id })
      .then((unlock) => this.setData({ unlock }))
      .catch(showError)
  },

  startAutoTracking() {
    if (this.trackingStarted || !this.data.id) return
    this.trackingStarted = true
    this.lastTrackPoint = null
    this.lastTrackUploadedAt = 0
    this.setData({ autoTracking: true, backgroundTracking: false, trackStatusText: '正在开启轨迹记录' })

    requirePrivacyAuthorize()
      .then(() => this.startLocationUpdate())
      .then((mode) => {
        if (typeof wx.onLocationChange !== 'function') throw new Error('当前微信版本不支持连续定位')
        this.handleLocationChange = (location) => this.recordTrackPoint(location, false)
        wx.onLocationChange(this.handleLocationChange)
        this.uploadAutoTrackPoint()
        this.trackTimer = setInterval(() => this.uploadAutoTrackPoint(), TRACK_INTERVAL_MS)
        this.setData({
          backgroundTracking: mode === 'background',
          trackStatusText: mode === 'background' ? '后台轨迹记录中' : '前台轨迹记录中'
        })
      })
      .catch((error) => {
        this.trackingStarted = false
        this.setData({ autoTracking: false, backgroundTracking: false, trackStatusText: '自动轨迹未开启，请手动记录当前位置' })
        showError(error)
      })
  },

  startLocationUpdate() {
    const startForeground = () => new Promise((resolve, reject) => {
      if (typeof wx.startLocationUpdate !== 'function') {
        reject(new Error('当前微信版本不支持连续定位'))
        return
      }
      wx.startLocationUpdate({ success: () => resolve('foreground'), fail: reject })
    })

    if (typeof wx.startLocationUpdateBackground !== 'function') return startForeground()
    return new Promise((resolve) => {
      wx.startLocationUpdateBackground({
        success: () => resolve('background'),
        fail: () => startForeground().then(resolve).catch(() => resolve('failed'))
      })
    }).then((mode) => {
      if (mode === 'failed') throw new Error('当前微信版本或权限不支持连续定位')
      return mode
    })
  },

  stopAutoTracking() {
    if (!this.trackingStarted) return
    this.trackingStarted = false
    if (this.handleLocationChange && typeof wx.offLocationChange === 'function') {
      wx.offLocationChange(this.handleLocationChange)
    }
    this.handleLocationChange = null
    if (this.trackTimer) clearInterval(this.trackTimer)
    this.trackTimer = null
    if (typeof wx.stopLocationUpdate === 'function') wx.stopLocationUpdate({})
    this.setData({ autoTracking: false, backgroundTracking: false, trackStatusText: '轨迹记录已停止' })
  },

  shouldUploadTrackPoint(point, force) {
    if (force) return true
    if (point.accuracy && point.accuracy > MAX_ACCEPTABLE_ACCURACY_M) return false
    if (!this.lastTrackPoint) return true
    if (Date.now() - this.lastTrackUploadedAt >= TRACK_INTERVAL_MS) return true
    const distance = calcDistanceM(this.lastTrackPoint.latitude, this.lastTrackPoint.longitude, point.latitude, point.longitude)
    return distance >= TRACK_MIN_DISTANCE_M
  },

  getRealtimeLocation() {
    return requirePrivacyAuthorize().then(() => new Promise((resolve, reject) => {
      wx.getLocation({
        type: 'gcj02',
        success: resolve,
        fail: reject
      })
    }))
  },

  uploadAutoTrackPoint() {
    return this.getRealtimeLocation()
      .then((loc) => this.recordTrackPoint(loc, false))
      .then((res) => this.flushOfflineTasks().then(() => res))
      .catch(() => null)
  },

  recordTrackPoint(location, force) {
    const point = toTrackPoint(location)
    if (!point || !this.shouldUploadTrackPoint(point, force)) return Promise.resolve(null)
    point.clientPointId = createClientRequestId('track')
    return callFunction('track', 'batchUploadTrack', { orderId: this.data.id, batchId: createClientRequestId('batch'), points: [point] })
      .then((res) => {
        this.lastTrackPoint = point
        this.lastTrackUploadedAt = Date.now()
        const pointCount = this.data.pointCount + Number(res.count || 0)
        this.setData({
          pointCount,
          latestTrackText: `最近记录：${new Date(point.recordedAt).toTimeString().slice(0, 5)}，精度${Math.round(point.accuracy || 0)}m`,
          offlineTaskCount: getOfflineTaskCount(this.data.id)
        })
        return res
      })
      .catch((error) => {
        enqueueOfflineTask('track', { orderId: this.data.id, point: { ...point, isBackfilled: true }, clientPointId: point.clientPointId })
        this.setData({ offlineTaskCount: getOfflineTaskCount(this.data.id) })
        if (force) showError(error)
        return null
      })
  },

  flushOfflineTasks() {
    const tasks = getOfflineTasks(this.data.id)
    if (!tasks.length) {
      this.setData({ offlineTaskCount: 0 })
      return Promise.resolve()
    }
    return tasks.reduce((chain, task) => chain.then(() => {
      if (task.type === 'track') {
        return callFunction('track', 'batchUploadTrack', { orderId: task.orderId, batchId: createClientRequestId('backfill'), points: [task.payload.point] })
          .then(() => removeOfflineTask(task.id))
      }
      if (task.type === 'checkin') {
        return callFunction('checkin', 'createCheckin', { ...task.payload, isBackfilled: true })
          .then(() => removeOfflineTask(task.id))
      }
      removeOfflineTask(task.id)
      return Promise.resolve()
    }).catch(() => {
      updateOfflineTask({ ...task, retryTimes: Number(task.retryTimes || 0) + 1 })
    }), Promise.resolve()).then(() => {
      this.setData({ offlineTaskCount: getOfflineTaskCount(this.data.id) })
    })
  },

  uploadPoint(options = {}) {
    return getServiceLocation()
      .then((loc) => this.recordTrackPoint(loc, true))
      .then((res) => {
        if (res && !options.silent) wx.showToast({ title: '已记录位置' })
      })
      .catch((error) => {
        if (!options.silent) showError(error)
      })
  },

  checkin(e) {
    wx.navigateTo({ url: '/pages/staff/checkin/camera/index?id=' + this.data.id + '&eventType=' + e.currentTarget.dataset.type })
  },

  finish() {
    if (this.data.finishing) return
    this.setData({ finishing: true })
    this.uploadAutoTrackPoint()
      .then(() => this.flushOfflineTasks())
      .then(() => {
        if (getOfflineTaskCount(this.data.id) > 0) wx.showToast({ title: '仍有数据待补传，网络恢复后会继续上传', icon: 'none' })
      })
      .then(() => callFunction('order', 'finishService', { id: this.data.id, clientRequestId: createClientRequestId('finish_service') }))
      .then(() => {
        this.stopAutoTracking()
        wx.showToast({ title: '已完成' })
        this.setData({ finishing: false, order: { ...(this.data.order || {}), status: 'completed' } })
      })
      .catch((error) => {
        this.setData({ finishing: false })
        showError(error)
      })
  },

  ...navMethods()
})
