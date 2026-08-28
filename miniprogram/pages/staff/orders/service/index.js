const { callFunction, showError, getServiceLocation, requirePrivacyAuthorize, requestSubscribeTemplates } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { createClientRequestId, enqueueOfflineTask, getOfflineTasks, getOfflineTaskCount, removeOfflineTask, updateOfflineTask } = require('../../../../utils/offlineQueue')
const { applyTheme, getThemeState } = require('../../../../utils/theme')
const { formatDateTime, toBeijingDate } = require('../../../../utils/format')

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

function toTimeValue(value) {
  if (!value) return 0
  const date = toBeijingDate(value)
  const time = date ? date.getTime() : 0
  return Number.isFinite(time) ? time : 0
}

function isNetworkError(error) {
  const message = error && (error.message || error.errMsg) || ''
  return /network|timeout|fail/i.test(message)
}

function withServiceActionState(order) {
  if (!order) return order
  const serviceStarted = order.status === 'in_service'
  const startTime = toTimeValue(order.startTime)
  const canRequestEarlyStart = order.status === 'assigned' && startTime > Date.now()
  return { ...order, serviceStarted, canRequestEarlyStart }
}

Page({
  data: {
    themeClass: 'theme-day',
    id: '',
    order: null,
    unlock: null,
    pointCount: 0,
    autoTracking: false,
    backgroundTracking: false,
    trackStatusText: '服务开始后自动记录轨迹',
    latestTrackText: '',
    offlineTaskCount: 0,
    earlyStartRequest: null,
    requestingEarlyStart: false,
    requestingRemoteUnlock: false,
    returningKey: false,
    keyReturnImageFileIds: [],
    customerService: null,
    starting: false,
    finishing: false,
    sectionHomeUrl: '',
    canGoBack: false
  },

  onLoad(q) {
    this.applyCurrentTheme()
    this.setData({ ...createPageNav(q), id: q.id })
    this.loadCustomerService()
    this.loadOrder()
  },

  onShow() {
    this.applyCurrentTheme()
    if (this.data.id) this.loadOrder()
  },

  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },

  onUnload() {
    this.stopAutoTracking()
  },

  loadOrder() {
    callFunction('order', 'getOrderDetail', { id: this.data.id })
      .then((order) => {
        const displayOrder = withServiceActionState(order)
        this.setData({ order: displayOrder, pointCount: Number(order.trackCount || 0), earlyStartRequest: order.earlyStartRequest || null, offlineTaskCount: getOfflineTaskCount(this.data.id) })
        if (order && order.status === 'in_service') {
          this.flushOfflineTasks()
          this.startAutoTracking()
        }
      })
      .catch(() => {})
  },

  loadCustomerService() {
    callFunction('system', 'getCustomerServiceInfo')
      .then((customerService) => this.setData({ customerService }))
      .catch(() => {})
  },

  callCustomerService() {
    const phone = this.data.customerService && this.data.customerService.phone
    if (!phone) {
      wx.showToast({ title: '暂未配置客服电话', icon: 'none' })
      return
    }
    wx.makePhoneCall({ phoneNumber: phone })
  },

  copyOrderNo() {
    const orderNo = this.data.order && this.data.order.orderNo
    if (!orderNo) return
    wx.setClipboardData({ data: orderNo })
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
        this.setData({ starting: false, order: withServiceActionState({ ...(this.data.order || {}), status: 'in_service' }) })
        this.startAutoTracking()
      })
      .catch((error) => {
        this.setData({ starting: false })
        const message = (error && (error.message || error.errMsg)) || ''
        if (message.includes('服务时间未到')) {
          wx.showModal({
            title: '服务时间未到',
            content: '现在还没到预约开始时间，可向宠物主申请提前开始服务。',
            confirmText: '申请提前',
            cancelText: '稍后再说',
            success: (res) => {
              if (res.confirm) this.requestEarlyStart()
            }
          })
          return
        }
        showError(error)
      })
  },

  requestEarlyStart() {
    if (this.data.requestingEarlyStart) return
    this.setData({ requestingEarlyStart: true })
    requestSubscribeTemplates(['serviceStart'], 'staff_early_start')
      .then(() => callFunction('order', 'requestEarlyStart', { id: this.data.id, reason: '宠护师已到达，申请提前开始服务' }))
      .then((earlyStartRequest) => {
        wx.showToast({ title: '已发送申请', icon: 'none' })
        this.setData({ requestingEarlyStart: false, earlyStartRequest })
      })
      .catch((error) => {
        this.setData({ requestingEarlyStart: false })
        showError(error)
      })
  },

  unlock() {
    if (!this.data.order || !this.data.order.serviceStarted) return
    callFunction('homeSecurity', 'getUnlockCode', { orderId: this.data.id })
      .then((unlock) => this.setData({ unlock }))
      .catch((error) => {
        const message = (error && error.message) || ''
        if (message.includes('尚未生效') || message.includes('已过期')) {
          wx.showModal({ title: '密码暂不可用', content: message, showCancel: false })
          return
        }
        showError(error)
      })
  },

  requestRemoteUnlock() {
    if (!this.data.order || !this.data.order.serviceStarted) return
    if (this.data.requestingRemoteUnlock) return
    this.setData({ requestingRemoteUnlock: true })
    requestSubscribeTemplates(['serviceStart'], 'staff_remote_unlock')
      .then(() => callFunction('homeSecurity', 'requestRemoteUnlock', { orderId: this.data.id }))
      .then((security) => {
        wx.showToast({ title: '已请求开门', icon: 'none' })
        this.setData({ requestingRemoteUnlock: false, order: { ...(this.data.order || {}), orderHomeSecurity: security } })
      })
      .catch((error) => {
        this.setData({ requestingRemoteUnlock: false })
        showError(error)
      })
  },

  chooseKeyReturnImage() {
    if (this.data.returningKey) return
    wx.chooseMedia({
      count: 3,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      success: (res) => {
        const files = res.tempFiles || []
        if (!files.length) return
        this.setData({ returningKey: true })
        Promise.all(files.map((file) => new Promise((resolve, reject) => {
          const tempFilePath = file.tempFilePath
          const ext = tempFilePath.includes('.') ? tempFilePath.slice(tempFilePath.lastIndexOf('.')) : '.jpg'
          wx.cloud.uploadFile({ cloudPath: `key_returns/${this.data.id}/${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`, filePath: tempFilePath, success: resolve, fail: reject })
        }))).then((uploads) => {
          this.setData({ keyReturnImageFileIds: [...this.data.keyReturnImageFileIds, ...uploads.map((item) => item.fileID).filter(Boolean)], returningKey: false })
        }).catch((error) => {
          this.setData({ returningKey: false })
          showError(error)
        })
      },
      fail: showError
    })
  },

  recordKeyReturned() {
    if (!this.data.keyReturnImageFileIds.length) {
      wx.showToast({ title: '请上传放回钥匙图片', icon: 'none' })
      return
    }
    this.setData({ returningKey: true })
    callFunction('homeSecurity', 'recordKeyReturned', { orderId: this.data.id, imageFileIds: this.data.keyReturnImageFileIds })
      .then((security) => {
        wx.showToast({ title: '已记录放回' })
        this.setData({ returningKey: false, keyReturnImageFileIds: [], order: { ...(this.data.order || {}), orderHomeSecurity: security } })
      })
      .catch((error) => {
        this.setData({ returningKey: false })
        if (isNetworkError(error)) {
          enqueueOfflineTask('key_return', { orderId: this.data.id, imageFileIds: this.data.keyReturnImageFileIds, clientRequestId: createClientRequestId('key_return') })
          this.setData({ offlineTaskCount: getOfflineTaskCount(this.data.id), keyReturnImageFileIds: [] })
          wx.showToast({ title: '网络异常，已加入待补传', icon: 'none' })
          return
        }
        showError(error)
      })
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
    if (typeof wx.stopLocationUpdateBackground === 'function') wx.stopLocationUpdateBackground({})
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
          latestTrackText: `最近记录：${formatDateTime(point.recordedAt).slice(6)}，精度${Math.round(point.accuracy || 0)}m`,
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
    let flushed = false
    return tasks.reduce((chain, task) => chain.then(() => {
      if (task.type === 'track') {
        return callFunction('track', 'batchUploadTrack', { orderId: task.orderId, batchId: createClientRequestId('backfill'), points: [task.payload.point] })
          .then(() => { flushed = true; removeOfflineTask(task.id) })
      }
      if (task.type === 'checkin') {
        return callFunction('checkin', 'createCheckin', { ...task.payload, isBackfilled: true })
          .then(() => { flushed = true; removeOfflineTask(task.id) })
      }
      if (task.type === 'key_return') {
        return callFunction('homeSecurity', 'recordKeyReturned', task.payload)
          .then(() => { flushed = true; removeOfflineTask(task.id) })
      }
      removeOfflineTask(task.id)
      return Promise.resolve()
    }).catch(() => {
      updateOfflineTask({ ...task, retryTimes: Number(task.retryTimes || 0) + 1 })
    }), Promise.resolve()).then(() => {
      this.setData({ offlineTaskCount: getOfflineTaskCount(this.data.id) })
      if (!flushed) return null
      return callFunction('order', 'getOrderDetail', { id: this.data.id })
        .then((order) => this.setData({ order: withServiceActionState(order), pointCount: Number(order.trackCount || 0), earlyStartRequest: order.earlyStartRequest || null }))
        .catch(() => null)
    })
  },

  uploadPoint(options = {}) {
    if (!this.data.order || !this.data.order.serviceStarted) return Promise.resolve(null)
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
    if (!this.data.order || !this.data.order.serviceStarted) return
    wx.navigateTo({ url: '/pages/staff/checkin/camera/index?id=' + this.data.id + '&eventType=' + e.currentTarget.dataset.type })
  },

  validateRequiredCheckins() {
    const requirements = (this.data.order && this.data.order.checkinRequirements) || []
    const missing = requirements.filter((item) => item.required && !item.completed)
    if (!missing.length) return ''
    return `还缺少必打卡：${missing.map((item) => item.label || item.eventType).join('、')}`
  },

  finish() {
    if (!this.data.order || !this.data.order.serviceStarted) return
    const missingTip = this.validateRequiredCheckins()
    if (missingTip) {
      wx.showToast({ title: missingTip, icon: 'none' })
      return
    }
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
        this.setData({ finishing: false, order: withServiceActionState({ ...(this.data.order || {}), status: 'completed' }) })
      })
      .catch((error) => {
        this.setData({ finishing: false })
        showError(error)
      })
  },

  ...navMethods()
})
