const { callFunction, showError, getServiceLocation, requirePrivacyAuthorize, requestSubscribeTemplates } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { createClientRequestId, enqueueOfflineTask, getOfflineTasks, getOfflineTaskCount, removeOfflineTask, updateOfflineTask } = require('../../../../utils/offlineQueue')
const { applyTheme, getThemeState } = require('../../../../utils/theme')
const { formatDateTime, toBeijingDate } = require('../../../../utils/format')
const { copyText } = require('../../../../utils/clipboard')

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
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const text = String(value).trim()
  if (/^\d{10,13}$/.test(text)) {
    const num = Number(text)
    return Number.isFinite(num) ? (text.length === 10 ? num * 1000 : num) : 0
  }
  const localMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/)
  if (localMatch) {
    const [, year, month, day, hour = '0', minute = '0', second = '0'] = localMatch
    return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 8, Number(minute), Number(second))
  }
  let parsed = new Date(text).getTime()
  if (Number.isNaN(parsed)) {
    parsed = new Date(text.replace(/-/g, '/').replace('T', ' ')).getTime()
  }
  return Number.isNaN(parsed) ? 0 : parsed
}

function isNetworkError(error) {
  const message = error && (error.message || error.errMsg) || ''
  return /network|timeout|fail/i.test(message)
}

function formatElapsed(ms) {
  const total = Math.max(Math.floor(Number(ms || 0) / 1000), 0)
  const hours = String(Math.floor(total / 3600)).padStart(2, '0')
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
  const seconds = String(total % 60).padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
}

function formatServiceTime(startTime, endTime) {
  const startText = formatDateTime(startTime)
  const endText = formatDateTime(endTime)
  if (startText && endText) return `${startText} 至 ${endText}`
  return startText || endText || '待确认'
}

function buildDurationRows(order, serviceKey) {
  return (order.petServiceDurations || [])
    .filter((item) => item.serviceKey === serviceKey)
    .map((item) => ({
      petName: item.petName || '宠物',
      durationMinutes: Number(item.durationMinutes || 0),
      text: `${item.petName || '宠物'} · ${Number(item.durationMinutes || 0)}分钟`
    }))
}

function buildPetNoticeRows(order) {
  const snapshots = Array.isArray(order.petSnapshots) && order.petSnapshots.length ? order.petSnapshots : [order.petSnapshot].filter(Boolean)
  return snapshots.map((pet) => {
    const notes = [
      pet.healthNotes ? `健康：${pet.healthNotes}` : '',
      pet.specialNotes ? `照顾：${pet.specialNotes}` : '',
      pet.dislikes ? `禁忌：${pet.dislikes}` : ''
    ].filter(Boolean)
    return {
      name: pet.name || '宠物',
      isDog: pet.species === 'dog',
      text: notes.join('；') || '暂无特别注意事项'
    }
  })
}

function withServiceActionState(order) {
  if (!order) return order
  const serviceStarted = order.status === 'in_service'
  const sessions = Array.isArray(order.serviceSessions) ? order.serviceSessions : []
  const activeSession = sessions.find((item) => item.status === 'in_service' || Number(item.index) === Number(order.activeSessionIndex || 0)) || null
  const nextSession = sessions.find((item) => item.status !== 'completed') || null
  const startTime = toTimeValue((nextSession && nextSession.startTime) || order.startTime)
  const canStartService = ['assigned', 'day_completed'].includes(order.status)
  const canRequestEarlyStart = canStartService && startTime > Date.now()
  const sanitization = (order.checkinRequirements || []).find((item) => item.eventType === 'sanitization')
  const sanitizationRequired = Boolean((sanitization && sanitization.required) || (order.requiredCheckins || []).includes('sanitization'))
  const sanitizationCompleted = Boolean(sanitization && sanitization.completed)
  const currentSession = activeSession || nextSession || null
  const walkDurationRows = buildDurationRows(order, 'walk')
  const playDurationRows = buildDurationRows(order, 'play')
  const customerRemarkText = order.clientRemark || order.customerRemark || order.orderRemark || order.remark || (order.orderHomeSecurity && order.orderHomeSecurity.entryNotes) || (order.homeSecuritySnapshot && order.homeSecuritySnapshot.entryNotes) || ''
  return {
    ...order,
    serviceStarted,
    canStartService,
    canRequestEarlyStart,
    sanitizationRequired,
    sanitizationCompleted,
    activeSession,
    nextSession,
    currentSession,
    isMultiDay: Number(order.sessionCount || sessions.length || 1) > 1,
    serviceRequirementText: order.serviceSummary || (order.serviceType === 'walk' ? '遛狗服务' : '上门宠护服务'),
    serviceTimeText: formatServiceTime((currentSession && currentSession.startTime) || order.startTime, (currentSession && currentSession.endTime) || order.endTime),
    fullServiceTimeText: formatServiceTime(order.startTime, order.endTime),
    customerRemarkText,
    petNoticeRows: buildPetNoticeRows(order),
    walkDurationRows,
    playDurationRows,
    hasServiceRequirementInfo: Boolean(customerRemarkText || walkDurationRows.length || playDurationRows.length || order.serviceSummary || order.startTime || order.endTime)
  }
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
    serviceElapsedText: '00:00:00',
    sectionHomeUrl: '',
    canGoBack: false,
    supplyItems: [
      { name: '一次性手套', description: '佩戴防接触感染', purchaseUrl: '' },
      { name: '一次性口罩', description: '规范防护', purchaseUrl: '' },
      { name: '一次性鞋套', description: '进门即穿戴，保护家庭卫生', purchaseUrl: '' },
      { name: '安全宠物消毒用品', description: '进门及工具消毒', purchaseUrl: '' }
    ]
  },

  onLoad(q) {
    this.applyCurrentTheme()
    this.setData({ ...createPageNav(q), id: q.id })
    this.loadCustomerService()
    this.loadOrder()
    this.loadSupplies()
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
    this.stopServiceElapsedTimer()
    this.stopAutoTracking()
  },

  startServiceElapsedTimer(order) {
    this.stopServiceElapsedTimer()
    const startedAt = toTimeValue(order && (order.currentSessionStartedAt || (order.activeSession && order.activeSession.startedAt) || order.startedAt))
    if (!startedAt) {
      this.setData({ serviceElapsedText: '00:00:00' })
      return
    }
    const updateElapsed = () => this.setData({ serviceElapsedText: formatElapsed(Date.now() - startedAt) })
    updateElapsed()
    this.serviceElapsedTimer = setInterval(updateElapsed, 1000)
  },

  stopServiceElapsedTimer() {
    if (this.serviceElapsedTimer) clearInterval(this.serviceElapsedTimer)
    this.serviceElapsedTimer = null
  },

  loadOrder() {
    return Promise.all([
      callFunction('order', 'getOrderDetail', { id: this.data.id }),
      callFunction('checkin', 'listOrderCheckins', { orderId: this.data.id }).catch(() => [])
    ])
      .then(([order, checkins]) => {
        const displayOrder = withServiceActionState(order)
        if (displayOrder && Array.isArray(displayOrder.checkinRequirements)) {
          const sessionStartedAt = toTimeValue(displayOrder.currentSessionStartedAt || (displayOrder.activeSession && displayOrder.activeSession.startedAt) || displayOrder.startedAt)
          const validCheckins = (checkins || []).filter((item) => {
            if (item.eventType === 'sanitization') return true
            if (displayOrder.status !== 'in_service' || !sessionStartedAt) return !item.deletedAt
            return !item.deletedAt && toTimeValue(item.recordedAt || item.serverTime || item.createdAt) >= (sessionStartedAt - 60000)
          })
          const countsByType = {}
          validCheckins.forEach((c) => {
            if (c.eventType && c.mediaFileId) {
              countsByType[c.eventType] = (countsByType[c.eventType] || 0) + 1
            }
          })
          displayOrder.checkinRequirements = displayOrder.checkinRequirements.map((req) => {
            const count = countsByType[req.eventType] !== undefined ? countsByType[req.eventType] : (req.photoCount || 0)
            return {
              ...req,
              photoCount: count,
              completed: count > 0 || Boolean(req.completed)
            }
          })
        }
        this.setData({
          order: displayOrder,
          pointCount: Number((order && order.trackCount) || 0),
          earlyStartRequest: (order && order.earlyStartRequest) || null,
          offlineTaskCount: getOfflineTaskCount(this.data.id)
        })
        if (order && order.status === 'in_service') {
          this.startServiceElapsedTimer(displayOrder)
          this.flushOfflineTasks()
          this.startAutoTracking()
        } else {
          this.stopServiceElapsedTimer()
          this.setData({ serviceElapsedText: '00:00:00' })
        }
      })
      .catch(() => {})
  },

  loadCustomerService() {
    callFunction('system', 'getCustomerServiceInfo')
      .then((customerService) => this.setData({ customerService }))
      .catch(() => {})
  },

  loadSupplies() {
    callFunction('system', 'getSettings')
      .then((settings) => {
        const supplies = (settings && settings.staffSupplies) || {}
        if (Array.isArray(supplies.items) && supplies.items.length) {
          this.setData({ supplyItems: supplies.items.filter((i) => i.enabled !== false) })
        }
      })
      .catch(() => {})
  },

  openPurchaseUrl(e) {
    const url = (e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.url) || ''
    const name = (e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.name) || '物品'
    if (!url) {
      wx.showToast({ title: '暂未配置购买链接', icon: 'none' })
      return
    }
    if (url.startsWith('/')) {
      wx.navigateTo({ url })
      return
    }
    copyText(url, {
      successModal: true,
      successTitle: `${name} 购买链接已复制`,
      successModalContent: `购买链接已成功复制到剪贴板！\n\n地址：${url}\n\n可在微信对话框或手机浏览器中长按粘贴打开完成购买。`,
      failTitle: `${name} 购买链接`,
      failContent: `购买地址：\n${url}\n\n检测到剪贴板权限受限，您可长按上方地址复制，并在浏览器中打开完成购买。`
    })
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
    const orderNo = String((this.data.order && this.data.order.orderNo) || '').trim()
    if (!orderNo) {
      wx.showToast({ title: '暂无订单号', icon: 'none' })
      return
    }
    copyText(orderNo, { successTitle: '订单号已复制', emptyTitle: '暂无订单号' })
  },

  previewPetPhoto() {
    const photo = this.data.order && this.data.order.petSnapshot && this.data.order.petSnapshot.avatarFileId
    if (photo) wx.previewImage({ urls: [photo] })
  },

  start() {
    if (!this.data.order || !this.data.order.canStartService) return
    if (this.data.order.sanitizationRequired && !this.data.order.sanitizationCompleted) {
      wx.showToast({ title: '请先完成服务前消毒拍照打卡', icon: 'none', duration: 3000 })
      return
    }
    if (this.data.starting) return
    this.setData({ starting: true })

    // 【新增】获取实时位置并检查前置条件
    wx.getLocation({
      type: 'gcj02',
      success: (locationRes) => {
        // 先检查开始服务的准备情况
        callFunction('order', 'checkStartServiceReadiness', {
          id: this.data.id,
          currentLatitude: locationRes.latitude,
          currentLongitude: locationRes.longitude
        })
          .then((readiness) => {
            if (!readiness.canStart) {
              this.setData({ starting: false })
              // 找到最重要的问题并提示
              const issue = readiness.issues[0]
              if (issue.type === 'missing_sanitization') {
                wx.showModal({
                  title: '请先完成消毒打卡',
                  content: '开始服务前需要先完成消毒拍照打卡，确保服务质量和安全。',
                  showCancel: false
                })
              } else if (issue.type === 'too_far') {
                wx.showModal({
                  title: '距离服务地址较远',
                  content: issue.message,
                  showCancel: false
                })
              } else if (issue.type === 'active_service_conflict') {
                wx.showModal({
                  title: '已有订单服务中',
                  content: issue.message || '当前已有订单正在服务中，请先完成该订单后再开始新的服务。',
                  confirmText: '前往服务',
                  cancelText: '知道了',
                  success: (res) => {
                    if (res.confirm && issue.orderId) wx.redirectTo({ url: '/pages/staff/orders/service/index?id=' + issue.orderId })
                  }
                })
              } else if (issue.type === 'time_not_ready') {
                wx.showModal({
                  title: '服务时间未到',
                  content: '现在还没到预约开始时间，可向宠物主申请提前开始服务。',
                  confirmText: '申请提前',
                  cancelText: '稍后再说',
                  success: (res) => {
                    if (res.confirm) this.requestEarlyStart()
                  }
                })
              } else {
                wx.showModal({
                  title: '暂时无法开始服务',
                  content: issue.message,
                  showCancel: false
                })
              }
              return Promise.reject(new Error('前置条件未满足'))
            }
            // 所有条件都满足，开始服务
            return requestSubscribeTemplates(['serviceStart', 'serviceFinish'], 'staff_service')
          })
          .then(() => callFunction('order', 'startService', {
            id: this.data.id,
            currentLatitude: locationRes.latitude,
            currentLongitude: locationRes.longitude,
            clientRequestId: createClientRequestId('start_service')
          }))
          .then(() => {
            wx.showToast({ title: '已开始服务' })
            this.setData({ starting: false })
            this.loadOrder()
          })
          .catch((error) => {
            if (error && error.message === '前置条件未满足') return // 已经显示了具体的错误提示
            this.setData({ starting: false })
            showError(error)
          })
      },
      fail: (err) => {
        this.setData({ starting: false })
        wx.showModal({
          title: '需要位置权限',
          content: '开始服务需要验证你是否在服务地址附近，请允许获取位置信息。',
          showCancel: false
        })
      }
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
    const order = this.data.order
    const eventType = e.currentTarget.dataset.type
    const isSanitization = eventType === 'sanitization'
    if (!order || (isSanitization ? !['assigned', 'day_completed', 'in_service'].includes(order.status) : !order.serviceStarted)) return
    const goCamera = () => wx.navigateTo({ url: '/pages/staff/checkin/camera/index?id=' + this.data.id + '&eventType=' + eventType })
    if (!isSanitization || order.status === 'in_service') {
      goCamera()
      return
    }
    callFunction('order', 'checkServiceTimeReadyForCheckin', { id: this.data.id })
      .then(goCamera)
      .catch(showError)
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
      .then((res) => {
        this.stopServiceElapsedTimer()
        this.stopAutoTracking()
        wx.showToast({ title: res && res.status === 'day_completed' ? '当天已完成' : '已完成' })
        this.setData({ finishing: false })
        this.loadOrder()
      })
      .catch((error) => {
        this.setData({ finishing: false })
        showError(error)
      })
  },

  ...navMethods()
})
