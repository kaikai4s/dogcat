const { sessionChatMethods } = require('../../utils/sessionChat')
const { callFunction, showError, getServiceLocation, requirePrivacyAuthorize, requestSubscribeTemplates, loadSystemSettings, showLoading, hideLoading } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { createClientRequestId, enqueueOfflineTask, getOfflineTasks, getOfflineTaskCount, removeOfflineTask, failOfflineTask, retryOfflineTasks, withOfflineFlush, isOfflineOwner, getUnownedOfflineTaskCount } = require('../../../../utils/offlineQueue')
const { applyTheme, getThemeState } = require('../../../../utils/theme')
const { formatDateTime, toBeijingDate, buildOrderCareCards } = require('../../../../utils/format')
const { copyText } = require('../../../../utils/clipboard')
const { MAX_GAP_MS, pointTime, isGoodTrackPoint, isPlausibleStep } = require('../../utils/trackQuality')

// Keep the route dense enough to represent a walking path. The continuous
// location callback remains the primary source; this timer is a fallback for
// devices that do not emit a callback while the user is moving slowly.
const TRACK_INTERVAL_MS = 5 * 1000
const TRACK_MIN_DISTANCE_M = 3
const TRACK_MIN_INTERVAL_MS = 2 * 1000
const TRACK_UPLOAD_BATCH_SIZE = 20

function locationErrorText(error, fallback = '未知错误') {
  return (error && (error.errMsg || error.message)) || fallback
}

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
  const rawRecordedAt = location && (location.recordedAt || location.timestamp)
  const numericRecordedAt = Number(rawRecordedAt)
  const recordedAt = Number.isFinite(numericRecordedAt) && numericRecordedAt > 0
    ? (numericRecordedAt < 100000000000 ? numericRecordedAt * 1000 : numericRecordedAt)
    : (rawRecordedAt || Date.now())
  return {
    latitude,
    longitude,
    accuracy: Number(location.accuracy || location.horizontalAccuracy || 0),
    speed: Number(location.speed || 0),
    // Some WeChat versions expose a capture timestamp on the continuous
    // callback. Keep it when available so delayed background callbacks retain
    // their real position time instead of being stamped at upload time.
    recordedAt,
    coordinateType: 'gcj02',
    locationSource: 'gps'
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
  return buildOrderCareCards(order)
}

function withServiceActionState(order) {
  if (!order) return order
  const serviceStarted = order.status === 'in_service'
  const sessions = Array.isArray(order.serviceSessions) ? order.serviceSessions : []
  const activeSession = sessions.find((item) => item.status === 'in_service' || Number(item.index) === Number(order.activeSessionIndex || 0)) || null
  const nextSession = sessions.find((item) => item.status !== 'completed') || null
  const startTime = toTimeValue((nextSession && nextSession.startTime) || order.startTime)
  const canDepart = order.status === 'assigned'
  const isOnTheWay = order.status === 'on_the_way'
  const canStartService = ['assigned', 'on_the_way', 'day_completed'].includes(order.status)
  const canRequestEarlyStart = ['assigned', 'on_the_way', 'day_completed'].includes(order.status) && startTime > Date.now()
  const sanitization = (order.checkinRequirements || []).find((item) => item.eventType === 'sanitization')
  const sanitizationRequired = Boolean((sanitization && sanitization.required) || (order.requiredCheckins || []).includes('sanitization'))
  const sanitizationCompleted = Boolean(sanitization && sanitization.completed)
  const currentSession = activeSession || nextSession || null
  const walkDurationRows = buildDurationRows(order, 'walk')
  const playDurationRows = buildDurationRows(order, 'play')
  const customerRemarkText = order.clientRemark || order.customerRemark || order.orderRemark || order.remark || (order.orderHomeSecurity && order.orderHomeSecurity.entryNotes) || (order.homeSecuritySnapshot && order.homeSecuritySnapshot.entryNotes) || ''
  const petNoticeRows = buildPetNoticeRows(order)
  const highRiskCareCards = petNoticeRows.filter((card) => card.isHighRisk)
  const nowTs = Date.now()
  const isStartOverdue = canStartService && startTime > 0 && nowTs > startTime
  const startOverdueMinutes = isStartOverdue ? Math.floor((nowTs - startTime) / 60000) : 0
  const endTimeVal = toTimeValue((currentSession && currentSession.endTime) || order.endTime)
  const isFinishOverdue = serviceStarted && endTimeVal > 0 && nowTs > endTimeVal
  const finishOverdueMinutes = isFinishOverdue ? Math.floor((nowTs - endTimeVal) / 60000) : 0
  const allCheckinsDone = sanitizationCompleted && (order.checkinRequirements || []).every((req) => !req.required || req.completed)
  const wechatNotifyMap = {
    pending: '发送中',
    sent: '已发送',
    success: '发送成功',
    skipped: '无需发送',
    failed: '发送失败'
  }
  let orderHomeSecurity = order.orderHomeSecurity
  if (orderHomeSecurity && orderHomeSecurity.remoteUnlock && orderHomeSecurity.remoteUnlock.lastNotifyStatus) {
    const rawWechat = String(orderHomeSecurity.remoteUnlock.lastNotifyStatus.wechat || '').toLowerCase()
    orderHomeSecurity = {
      ...orderHomeSecurity,
      remoteUnlock: {
        ...orderHomeSecurity.remoteUnlock,
        lastNotifyStatusText: wechatNotifyMap[rawWechat] || (rawWechat ? '已处理' : '未知')
      }
    }
  }

  return {
    ...order,
    orderHomeSecurity,
    serviceStarted,
    canDepart,
    isOnTheWay,
    canStartService,
    canRequestEarlyStart,
    isStartOverdue,
    startOverdueMinutes,
    isFinishOverdue,
    finishOverdueMinutes,
    allCheckinsDone,
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
    petNoticeRows,
    hasHighRiskCare: highRiskCareCards.length > 0,
    highRiskCareCards,
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
    trackingState: 'idle',
    trackingErrorText: '',
    trackingWarningText: '',
    trackStatusText: '服务开始后自动记录轨迹',
    latestTrackText: '',
    offlineTaskCount: 0,
    earlyStartRequest: null,
    requestingEarlyStart: false,
    requestingRemoteUnlock: false,
    returningKey: false,
    keyReturnImageFileIds: [],
    customerService: null,
    cancelling: false,
    starting: false,
    finishing: false,
    departing: false,
    updatingTravelLocation: false,
    openingCheckinType: '',
    sessionMessages: [],
    sessionScrollTarget: '',
    sessionUnreadCount: 0,
    sessionChatError: '',
    sessionInputText: '',
    showChatModal: false,
    sendingChatMessage: false,
    privacyCallInfo: null,
    showCallModal: false,
    showCareCard: true,
    showCareRiskModal: false,
    careRiskStartConfirmed: false,
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
    if (q.openChat === '1' || q.openChat === 'true' || q.openChat === true) {
      setTimeout(() => {
        if (typeof this.openSessionChat === 'function') this.openSessionChat({ silent: true })
      }, 500)
    }
    this.loadCustomerService()
    this.loadOrder()
    this.loadSupplies()
  },

  onShow() {
    this._pageHidden = false
    loadSystemSettings().catch(() => null)
    this._chatPageVisible = true
    this.applyCurrentTheme()
    if (this.data.id) this.loadOrder()
    if (this.data.showChatModal) this.startSessionChatRefresh()
    this.showPendingTrackingNotice()
  },

  onHide() {
    this._pageHidden = true
    this._chatPageVisible = false
    this._checkinNavigationSeq = (this._checkinNavigationSeq || 0) + 1
    if (this.data.openingCheckinType) this.setData({ openingCheckinType: '' })
    this.stopSessionChatRefresh()
    this.stopEarlyStartPolling()
    // Keep a confirmed background session alive. During startup the request
    // flag prevents a quick app switch from cancelling the permission flow.
    if (!this.data.backgroundTracking && !this.trackingBackgroundRequested) this.stopAutoTracking()
  },

  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },

  onUnload() {
    this._chatPageVisible = false
    this._checkinNavigationSeq = (this._checkinNavigationSeq || 0) + 1
    this.stopSessionChatRefresh()
    this.stopEarlyStartPolling()
    this.stopServiceElapsedTimer()
    this.stopAutoTracking()
  },

  startEarlyStartPolling() {
    this.stopEarlyStartPolling()
    if (!this.data.id) return
    this.earlyStartPollTimer = setInterval(() => {
      if (!this.data.id || this.data.starting || this.data.requestingEarlyStart) return
      callFunction('order', 'getEarlyStartStatus', { id: this.data.id })
        .then((earlyStart) => {
          if (!earlyStart) return
          const currentStatus = this.data.earlyStartRequest && this.data.earlyStartRequest.status
          if (currentStatus === 'pending' && earlyStart.status !== 'pending') {
            this.stopEarlyStartPolling()
            this.setData({ earlyStartRequest: earlyStart })
            if (earlyStart.status === 'approved') {
              wx.showModal({
                title: '宠物主已同意',
                content: '宠物主已同意提前开始服务，现在可以开始服务。',
                showCancel: false,
                confirmText: '立即处理',
                success: () => {
                  this.loadOrder()
                }
              })
            } else if (earlyStart.status === 'rejected') {
              wx.showModal({
                title: '申请未通过',
                content: '宠物主已拒绝提前开始服务，请按原约定时间开始服务。',
                showCancel: false,
                confirmText: '知道了',
                success: () => {
                  this.loadOrder()
                }
              })
            }
          }
        })
        .catch(() => {})
    }, 4000)
  },

  stopEarlyStartPolling() {
    if (this.earlyStartPollTimer) {
      clearInterval(this.earlyStartPollTimer)
      this.earlyStartPollTimer = null
    }
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

  handleOrderReassigned(notice) {
    if (this._reassignModalShown) return
    this._reassignModalShown = true
    this.stopServiceElapsedTimer()
    this.stopEarlyStartPolling()
    this.stopAutoTracking()
    wx.showModal({
      title: '订单已被改派',
      content: notice || '该订单因超时未履约已被平台转加急派单',
      showCancel: false,
      confirmText: '返回工作台',
      confirmColor: '#ea580c',
      success: () => {
        wx.reLaunch({
          url: '/pages/staff/home/index',
          fail: () => {
            wx.redirectTo({ url: '/pages/staff/home/index' })
          }
        })
      }
    })
  },

  loadOrder() {
    return Promise.all([
      callFunction('order', 'getOrderDetail', { id: this.data.id, role: 'staff' }),
      callFunction('checkin', 'listOrderCheckins', { orderId: this.data.id }).catch(() => [])
    ])
      .then(([order, checkins]) => {
        if (!order) return
        const app = typeof getApp === 'function' ? getApp() : null
        const currentUser = (app && app.globalData && app.globalData.user) || {}
        const myOpenid = currentUser.openid || ''

        const isReassigned = Boolean(
          order.isReassignedToOther ||
          (order.isUrgent && order.status === 'paid' && !order.staffOpenid) ||
          (order.isUrgent && order.assignmentSource === 'admin_urgent_republish' && !order.staffOpenid) ||
          (myOpenid && order.staffOpenid && order.staffOpenid !== myOpenid && (order.originalStaffOpenid === myOpenid || (Array.isArray(order.previousStaffRecords) && order.previousStaffRecords.some((r) => r.staffOpenid === myOpenid))))
        )
        if (isReassigned) {
          const notice = order.reassignNotice || (order.isUrgent ? '该订单因超时未履约已被平台转加急派单' : '该订单已被平台改派给其他宠托师')
          this.handleOrderReassigned(notice)
          return
        }

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
        const earlyStart = (order && order.earlyStartRequest) || null
        this.setData({
          order: displayOrder,
          pointCount: Number((order && order.trackCount) || 0),
          earlyStartRequest: earlyStart,
          offlineTaskCount: getOfflineTaskCount(this.data.id)
        })
        if (earlyStart && earlyStart.status === 'pending') {
          this.startEarlyStartPolling()
        } else {
          this.stopEarlyStartPolling()
        }
        if (order && order.status === 'in_service') {
          this.startServiceElapsedTimer(displayOrder)
          this.flushOfflineTasks()
          this.startAutoTracking()
        } else {
          this.stopServiceElapsedTimer()
          this.stopAutoTracking()
          this.setData({ serviceElapsedText: '00:00:00' })
        }
      })
      .catch((err) => {
        const msg = (err && (err.message || err.errMsg)) || ''
        if (/无权访问|不是该订单员工/.test(msg)) {
          this.handleOrderReassigned('该订单因超时未履约已被平台转加急派单')
        }
      })
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

  toggleCareCard() {
    this.setData({ showCareCard: !this.data.showCareCard })
  },

  closeCareRiskModal() {
    this.setData({ showCareRiskModal: false })
  },

  confirmCareRiskStart() {
    this.setData({ showCareRiskModal: false, careRiskStartConfirmed: true })
    this.start()
  },

  start() {
    if (!this.data.order || !this.data.order.canStartService) return
    if (this.data.order.hasHighRiskCare && !this.data.careRiskStartConfirmed) {
      this.setData({ showCareRiskModal: true, showCareCard: true })
      return
    }
    if (this.data.order.sanitizationRequired && !this.data.order.sanitizationCompleted) {
      wx.showToast({ title: '请先完成服务前消毒拍照打卡', icon: 'none', duration: 3000 })
      return
    }
    if (this._startingLock || this.data.starting) return
    this._startingLock = true
    this.setData({ starting: true })
    showLoading({ title: '正在准备开始服务...', mask: true })

    const checkLocation = () => wx.getLocation({
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
              hideLoading()
              this._startingLock = false
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
          })
          .then(() => callFunction('order', 'startService', {
            id: this.data.id,
            currentLatitude: locationRes.latitude,
            currentLongitude: locationRes.longitude,
            clientRequestId: createClientRequestId('start_service')
          }))
          .then(() => {
            hideLoading()
            this._startingLock = false
            this._pendingTrackingNotice = true
            wx.showToast({ title: '已开始服务', icon: 'success' })
            this.setData({ starting: false })
            this.loadOrder()
          })
          .catch((error) => {
            hideLoading()
            this._startingLock = false
            this.setData({ starting: false })
            if (error && error.message === '前置条件未满足') return // 已经显示了具体的错误提示
            showError(error)
          })
      },
      fail: (err) => {
        hideLoading()
        this._startingLock = false
        this.setData({ starting: false })
        wx.showModal({
          title: '需要位置权限',
          content: '开始服务需要验证你是否在服务地址附近，请允许获取位置信息。',
          showCancel: false
        })
      }
    })
    // Ask within the tap, before location and readiness network callbacks.
    return requestSubscribeTemplates(['serviceProgress', 'serviceFinish'], 'staff_service').catch(() => null)
      .then(checkLocation)
      .catch(error => {
        hideLoading()
        this._startingLock = false
        this.setData({ starting: false })
        showError(error)
      })
  },

  requestEarlyStart() {
    if (this._requestingEarlyStartLock || this.data.requestingEarlyStart) return
    this._requestingEarlyStartLock = true
    this.setData({ requestingEarlyStart: true })
    showLoading({ title: '正在申请提前开始...', mask: true })
    requestSubscribeTemplates(['serviceProgress'], 'staff_early_start')
      .then(() => callFunction('order', 'requestEarlyStart', { id: this.data.id, reason: '宠护师已到达，申请提前开始服务' }))
      .then((earlyStartRequest) => {
        hideLoading()
        this._requestingEarlyStartLock = false
        wx.showToast({ title: '已发送申请', icon: 'none' })
        this.setData({ requestingEarlyStart: false, earlyStartRequest })
        if (earlyStartRequest && earlyStartRequest.status === 'pending') {
          this.startEarlyStartPolling()
        }
      })
      .catch((err) => {
        hideLoading()
        this._requestingEarlyStartLock = false
        this.setData({ requestingEarlyStart: false })
        showError(err)
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
    callFunction('homeSecurity', 'requestRemoteUnlock', { orderId: this.data.id })
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
    if (this.trackingStarted || !this.data.id) return this.trackingStartPromise
    if (this.trackingStopPromise) {
      if (!this.trackingRestartPromise) {
        const restartPromise = this.trackingStopPromise.then(() => {
          if (this.trackingRestartPromise === restartPromise) this.trackingRestartPromise = null
          if (this.data.order && this.data.order.status === 'in_service') return this.startAutoTracking()
          return null
        })
        this.trackingRestartPromise = restartPromise
      }
      return this.trackingRestartPromise
    }

    this.trackingStarted = true
    this.lastTrackPoint = null
    this.trackWarmupPoint = null
    this.trackSegmentId = createClientRequestId('segment')
    const segmentId = this.trackSegmentId
    this.lastTrackUploadedAt = 0
    this.trackingBackgroundRequested = true
    this.trackUploadQueue = []
    this.setData({
      autoTracking: true,
      backgroundTracking: false,
      trackingState: 'starting',
      trackingErrorText: '',
      trackingWarningText: '',
      trackStatusText: '正在申请后台轨迹记录'
    })

    const startPromise = requirePrivacyAuthorize()
      .then(() => {
        if (this.trackingStarted && segmentId === this.trackSegmentId) return this.ensureTrackingLocationPermission()
        return null
      })
      .then(() => {
        if (!this.trackingStarted || segmentId !== this.trackSegmentId) return null
        return this.startLocationUpdate()
      })
      .then((result) => {
        if (!result || !this.trackingStarted || segmentId !== this.trackSegmentId) return
        const { mode, backgroundError } = result
        if (typeof wx.onLocationChange !== 'function') throw new Error('当前微信版本不支持连续定位监听')
        this.handleLocationChange = (location) => {
          if (this.trackingStarted && segmentId === this.trackSegmentId) this.recordTrackPoint(location, false)
        }
        wx.onLocationChange(this.handleLocationChange)
        this.uploadAutoTrackPoint()
        this.trackTimer = setInterval(() => this.uploadAutoTrackPoint(), TRACK_INTERVAL_MS)
        this.trackingBackgroundRequested = false
        this.trackingMode = mode
        if (mode === 'foreground' && this._pageHidden) {
          this.stopAutoTracking()
          return
        }
        this.setData({
          backgroundTracking: mode === 'background',
          trackingState: mode,
          trackingErrorText: backgroundError || '',
          trackingWarningText: mode === 'background'
            ? '可返回微信或使用浮窗；请勿结束小程序、关闭微信或关闭系统定位。'
            : '当前仅支持前台定位，请勿离开服务页面，否则轨迹记录会暂停。',
          trackStatusText: mode === 'background' ? '后台采集中，持续记录履约轨迹' : '前台采集中，离开页面将暂停'
        })
        this.showPendingTrackingNotice()
      })
      .catch((error) => {
        if (segmentId !== this.trackSegmentId) return
        this.trackingBackgroundRequested = false
        this.trackingStarted = false
        this.trackingMode = ''
        const nativeStopPromise = this.stopNativeLocationUpdates().finally(() => {
          if (this.trackingStopPromise === nativeStopPromise) this.trackingStopPromise = null
        })
        this.trackingStopPromise = nativeStopPromise
        const message = locationErrorText(error)
        const hasPendingNotice = this._pendingTrackingNotice
        this.setData({
          autoTracking: false,
          backgroundTracking: false,
          trackingState: 'error',
          trackingErrorText: message,
          trackingWarningText: '自动轨迹未开启，请保持在服务页面并手动补记当前位置。',
          trackStatusText: '自动轨迹未开启'
        })
        this.showPendingTrackingNotice()
        if (!hasPendingNotice) showError(error)
      })
      .finally(() => {
        if (this.trackingStartPromise === startPromise) this.trackingStartPromise = null
      })
    this.trackingStartPromise = startPromise
    return startPromise
  },

  startLocationUpdate() {
    const startForeground = (backgroundError) => new Promise((resolve, reject) => {
      if (typeof wx.startLocationUpdate !== 'function') {
        reject(new Error(`${backgroundError}；当前微信版本不支持前台连续定位`))
        return
      }
      wx.startLocationUpdate({
        type: 'gcj02',
        success: () => resolve({ mode: 'foreground', backgroundError }),
        fail: (foregroundError) => reject(new Error(`${backgroundError}；前台定位开启失败：${this.trackingLocationError(foregroundError)}`))
      })
    })

    if (typeof wx.startLocationUpdateBackground !== 'function') {
      return startForeground('当前微信版本不支持后台持续定位')
    }
    return new Promise((resolve, reject) => {
      wx.startLocationUpdateBackground({
        type: 'gcj02',
        success: () => resolve({ mode: 'background', backgroundError: '' }),
        fail: (backgroundError) => {
          const message = `后台定位开启失败：${this.trackingLocationError(backgroundError)}`
          startForeground(message).then(resolve).catch(reject)
        }
      })
    })
  },

  ensureTrackingLocationPermission() {
    if (typeof wx.getSetting !== 'function') return Promise.resolve()
    return new Promise((resolve, reject) => wx.getSetting({
      success: ({ authSetting = {} }) => {
        if (authSetting['scope.userLocation'] === true) return resolve()
        if (authSetting['scope.userLocation'] === false) return reject(new Error('未获得手机端定位授权，请点击“定位授权设置”允许位置信息，并选择允许在使用小程序时和离开后获取位置。'))
        if (typeof wx.authorize !== 'function') return reject(new Error('当前微信版本无法申请定位授权，请升级微信'))
        wx.authorize({ scope: 'scope.userLocation', success: resolve, fail: (error) => reject(new Error(this.trackingLocationError(error))) })
      }, fail: (error) => reject(new Error(`读取手机定位授权失败：${locationErrorText(error)}`))
    }))
  },

  trackingLocationError(error) {
    const raw = locationErrorText(error), hints = []
    try {
      if (typeof wx.getSystemSetting === 'function' && wx.getSystemSetting().locationEnabled === false) hints.push('手机系统定位服务已关闭，请在系统设置开启')
      if (typeof wx.getAppAuthorizeSetting === 'function' && wx.getAppAuthorizeSetting().locationAuthorized === 'denied') hints.push('微信未获系统定位权限，请在手机设置中允许微信访问位置')
      const device = typeof wx.getDeviceInfo === 'function' ? wx.getDeviceInfo() : null
      if (device && device.platform === 'devtools') hints.push('请用微信真机验证后台定位')
    } catch (ignored) {}
    if (/auth|deny|denied|permission|authorize|权限/i.test(raw)) hints.push('请点击“定位授权设置”，允许在使用小程序时和离开后获取位置；平台接口审批不等于手机授权')
    if (/not declared|requiredPrivateInfos|config|api scope|无权限|未开通/i.test(raw)) hints.push('请核对当前小程序AppID的接口权限、隐私声明，并重新编译发布含后台定位配置的版本')
    return [raw, ...hints].join('；')
  },

  onTrackingSettingsOpened(event) {
    if (/fail/i.test(event.detail && event.detail.errMsg || '')) return showError(new Error(event.detail.errMsg))
    return this.retryBackgroundTracking()
  },

  stopNativeLocationUpdates() {
    const stop = (method) => new Promise((resolve) => {
      if (typeof wx[method] !== 'function') {
        resolve()
        return
      }
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      try {
        wx[method]({ success: finish, fail: finish, complete: finish })
      } catch (error) {
        finish()
      }
    })
    return Promise.all([stop('stopLocationUpdate'), stop('stopLocationUpdateBackground')])
  },

  showPendingTrackingNotice() {
    if (!this._pendingTrackingNotice || this._pageHidden || this.data.trackingState === 'starting' || this.data.trackingState === 'idle') return
    this._pendingTrackingNotice = false
    let content = '自动轨迹未开启，请检查微信和系统定位权限，并在服务过程中手动补记当前位置。'
    if (this.data.trackingState === 'background') {
      content = '后台轨迹已开启。可返回微信或使用浮窗，但请保持微信运行及系统定位开启；结束小程序、关闭微信或系统回收进程后，轨迹可能中断。'
    } else if (this.data.trackingState === 'foreground') {
      content = '当前仅支持前台定位，请不要离开服务页面。返回微信、使用浮窗或关闭小程序都会暂停轨迹记录，请点击页面中的“重试后台定位”检查权限。'
    }
    wx.showModal({ title: '服务轨迹记录', content, showCancel: false, confirmText: '知道了' })
  },

  retryBackgroundTracking() {
    if (this.trackingBackgroundRequested || this.data.trackingState === 'starting') return
    if (!this.data.order || this.data.order.status !== 'in_service') return
    return this.stopAutoTracking().then(() => {
      if (this.data.order && this.data.order.status === 'in_service') return this.startAutoTracking()
      return null
    })
  },

  stopAutoTracking() {
    const existingStop = this.trackingStopPromise
    const pendingStart = this.trackingStartPromise
    const pendingUpload = this.trackUploadDrainPromise
    this.trackingStarted = false
    this.trackingBackgroundRequested = false
    this.trackingMode = ''
    this.trackSegmentId = ''
    this.trackWarmupPoint = null
    if (this.handleLocationChange && typeof wx.offLocationChange === 'function') {
      wx.offLocationChange(this.handleLocationChange)
    }
    this.handleLocationChange = null
    if (this.trackTimer) clearInterval(this.trackTimer)
    this.trackTimer = null
    this.setData({
      autoTracking: false,
      backgroundTracking: false,
      trackingState: 'idle',
      trackingErrorText: '',
      trackingWarningText: '',
      trackStatusText: '轨迹记录已停止'
    })
    if (existingStop) return existingStop

    const stopPromise = Promise.all([
      Promise.resolve(pendingStart).catch(() => null),
      Promise.resolve(pendingUpload).catch(() => null)
    ]).then(() => this.stopNativeLocationUpdates())
      .finally(() => {
        if (this.trackingStopPromise === stopPromise) this.trackingStopPromise = null
      })
    this.trackingStopPromise = stopPromise
    return stopPromise
  },

  shouldUploadTrackPoint(point, force) {
    if (!isGoodTrackPoint(point) || Math.abs(Date.now() - pointTime(point.recordedAt)) > 15000) return false
    const previous = this.lastTrackPoint
    if (!previous || pointTime(point.recordedAt) - pointTime(previous.recordedAt) > MAX_GAP_MS) {
      const warmup = this.trackWarmupPoint
      this.trackWarmupPoint = point
      if (!warmup || pointTime(point.recordedAt) - pointTime(warmup.recordedAt) > 60000 || !isPlausibleStep(warmup, point)) return false
    } else if (!isPlausibleStep(previous, point)) return false
    if (force || !previous) return true
    const elapsed = Date.now() - this.lastTrackUploadedAt
    if (elapsed < TRACK_MIN_INTERVAL_MS) return false
    if (elapsed >= TRACK_INTERVAL_MS) return true
    const distance = calcDistanceM(this.lastTrackPoint.latitude, this.lastTrackPoint.longitude, point.latitude, point.longitude)
    // Accuracy is an uncertainty radius, not a reason to wait for a whole
    // accuracy radius of movement. Cap its contribution so slow walking still
    // produces enough vertices for a faithful polyline.
    return distance >= Math.max(TRACK_MIN_DISTANCE_M, Math.min(6, (point.accuracy + previous.accuracy) / 3))
  },

  getRealtimeLocation() {
    return requirePrivacyAuthorize().then(() => new Promise((resolve, reject) => {
      wx.getLocation({
        type: 'gcj02',
        isHighAccuracy: true,
        highAccuracyExpireTime: 6000,
        success: resolve,
        fail: reject
      })
    }))
  },

  uploadAutoTrackPoint() {
    if (this.autoTrackRequest) return this.autoTrackRequest
    const segmentId = this.trackSegmentId
    this.autoTrackRequest = this.getRealtimeLocation()
      .then((loc) => this.trackingStarted && segmentId === this.trackSegmentId ? this.recordTrackPoint(loc, false) : null)
      .then((res) => this.flushOfflineTasks().then(() => res))
      .catch(() => null)
      .finally(() => { this.autoTrackRequest = null })
    return this.autoTrackRequest
  },

  recordTrackPoint(location, force) {
    if (!this.data.order || this.data.order.status !== 'in_service') return Promise.resolve(null)
    const point = toTrackPoint(location)
    if (!point || !this.shouldUploadTrackPoint(point, force)) {
      this.setData({ trackStatusText: '等待稳定定位，低精度或跳跃位置不会记录' })
      if (force) wx.showToast({ title: '定位尚不稳定，请到开阔处稍后重试', icon: 'none' })
      return Promise.resolve(null)
    }
    point.segmentId = this.trackSegmentId || createClientRequestId('manual_segment')
    point.clientPointId = createClientRequestId('track')
    point.forceUpload = Boolean(force)
    // Preserve the sampling anchor even when the upload is queued offline.
    this.lastTrackPoint = point
    this.lastTrackUploadedAt = Date.now()
    this.trackWarmupPoint = null
    if (!Array.isArray(this.trackUploadQueue)) this.trackUploadQueue = []
    this.trackUploadQueue.push(point)
    return this.flushTrackUploadQueue()
  },

  flushTrackUploadQueue() {
    if (this.trackUploadInFlight) return this.trackUploadDrainPromise || Promise.resolve(null)
    const queue = this.trackUploadQueue || []
    if (!queue.length) return Promise.resolve(null)
    const batch = queue.splice(0, TRACK_UPLOAD_BATCH_SIZE)
    const batchSegmentId = batch[0] && batch[0].segmentId
    const forceUpload = batch.some((point) => point.forceUpload)
    const uploadPoints = batch.map((point) => {
      const uploadPoint = { ...point }
      delete uploadPoint.forceUpload
      return uploadPoint
    })
    this.trackUploadInFlight = true
    let uploadRequest
    try {
      // Invoke immediately so a precise point captured in the native callback
      // is handed to the network layer before another callback can arrive.
      uploadRequest = callFunction('track', 'batchUploadTrack', { orderId: this.data.id, batchId: createClientRequestId('batch'), points: uploadPoints })
    } catch (error) {
      uploadRequest = Promise.reject(error)
    }
    this.trackUploadDrainPromise = Promise.resolve(uploadRequest)
      .then((res = {}) => {
        const acceptedCount = Number(res.count || 0)
        const isCurrentSegment = this.trackingStarted && batchSegmentId && batchSegmentId === this.trackSegmentId
        if (!acceptedCount) {
          if (res.rejectedCount && isCurrentSegment) {
            this.lastTrackPoint = null
            this.trackWarmupPoint = null
            this.lastTrackUploadedAt = 0
          }
          if (isCurrentSegment) {
            this.setData({ trackStatusText: res.rejectedCount ? '定位质量不足，已忽略本次位置' : '位置已记录' })
          }
          return null
        }
        const latestPoint = batch[batch.length - 1]
        const updates = {
          pointCount: this.data.pointCount + acceptedCount,
          offlineTaskCount: getOfflineTaskCount(this.data.id)
        }
        if (isCurrentSegment) {
          updates.trackStatusText = this.data.trackingState === 'background' ? '后台轨迹记录中' : '前台轨迹记录中'
          updates.latestTrackText = `最近记录：${formatDateTime(latestPoint.recordedAt).slice(6)}，精度${Math.round(latestPoint.accuracy || 0)}m`
        }
        this.setData(updates)
        return res
      })
      .catch((error) => {
        if (isNetworkError(error)) {
          batch.forEach((point) => enqueueOfflineTask('track', {
            orderId: this.data.id,
            point: { ...point, isBackfilled: true },
            clientPointId: point.clientPointId
          }))
        }
        this.setData({ offlineTaskCount: getOfflineTaskCount(this.data.id) })
        if (forceUpload) showError(error)
        return null
      })
      .then(() => {
        this.trackUploadInFlight = false
        this.trackUploadDrainPromise = null
        // Return the next drain promise so callers such as finishService wait
        // for every location already captured, instead of only the first one.
        return this.trackUploadQueue && this.trackUploadQueue.length ? this.flushTrackUploadQueue() : null
      })
    return this.trackUploadDrainPromise
  },

  flushOfflineTasks() {
    return withOfflineFlush(this.data.id, ownerId => this.flushOwnedOfflineTasks(ownerId))
  },

  retryOfflineUploads() {
    wx.showModal({ title: '重试补传', content: '重新上传当前订单的待补传数据？', success: result => {
      if (!result.confirm) return
      retryOfflineTasks(this.data.id)
      this.flushOfflineTasks()
    } })
  },

  flushOwnedOfflineTasks(ownerId) {
    const allTasks = getOfflineTasks(this.data.id)
    const tasks = allTasks.filter(task => task.status !== 'blocked' && Number(task.nextAttemptAt || 0) <= Date.now())
    this.setData({ offlineBlockedCount: allTasks.filter(task => task.status === 'blocked').length,
      offlineUnownedCount: getUnownedOfflineTaskCount(this.data.id) })
    if (!tasks.length) {
      this.setData({ offlineTaskCount: allTasks.length })
      return Promise.resolve()
    }
    let flushed = false
    return tasks.reduce((chain, task) => chain.then(() => {
      if (!isOfflineOwner(ownerId)) return null
      if (task.type === 'track') {
        return callFunction('track', 'batchUploadTrack', { orderId: task.orderId, batchId: createClientRequestId('backfill'), points: [task.payload.point] })
          .then(result => {
            if (!Number(result.count || 0) && !Number(result.duplicateCount || 0)) throw new Error('轨迹未通过校验，请核对记录')
            flushed = true; removeOfflineTask(task.id, ownerId)
          })
      }
      if (task.type === 'checkin') {
        return callFunction('checkin', 'createCheckin', { ...task.payload, isBackfilled: true })
          .then(() => { flushed = true; removeOfflineTask(task.id, ownerId) })
      }
      if (task.type === 'key_return') {
        return callFunction('homeSecurity', 'recordKeyReturned', task.payload)
          .then(() => { flushed = true; removeOfflineTask(task.id, ownerId) })
      }
      throw new Error('待补传数据类型无法识别，请联系管理员')
    }).catch(error => {
      failOfflineTask(task, error, isNetworkError(error))
    }), Promise.resolve()).then(() => {
      if (!isOfflineOwner(ownerId)) return null
      this.setData({ offlineTaskCount: getOfflineTaskCount(this.data.id),
        offlineBlockedCount: getOfflineTasks(this.data.id).filter(task => task.status === 'blocked').length })
      if (!flushed) return null
      return callFunction('order', 'getOrderDetail', { id: this.data.id, role: 'staff' })
        .then((order) => this.setData({ order: withServiceActionState(order), pointCount: Number(order.trackCount || 0), earlyStartRequest: order.earlyStartRequest || null }))
        .catch(() => null)
    })
  },

  uploadPoint(options = {}) {
    if (!this.data.order || !this.data.order.serviceStarted) return Promise.resolve(null)
    return this.getRealtimeLocation()
      .then((loc) => this.recordTrackPoint(loc, true))
      .then((res) => {
        if (res && !options.silent) wx.showToast({ title: '已记录位置' })
      })
      .catch((error) => {
        if (!options.silent) showError(error)
      })
  },

  async checkin(e) {
    if (this.data.openingCheckinType) return
    const order = this.data.order
    const eventType = e.currentTarget.dataset.type
    if (!order || !this.data.id || !eventType) {
      wx.showToast({ title: '订单信息未就绪，请刷新后重试', icon: 'none' })
      return
    }
    const isSanitization = eventType === 'sanitization'
    if (isSanitization ? !['assigned', 'on_the_way', 'day_completed', 'in_service'].includes(order.status) : !order.serviceStarted) {
      wx.showToast({ title: isSanitization ? '当前订单状态不可进行消毒打卡' : '请先开始服务再进行打卡', icon: 'none' })
      return
    }
    const requestSeq = this._checkinNavigationSeq = (this._checkinNavigationSeq || 0) + 1
    const isActive = () => requestSeq === this._checkinNavigationSeq
    const orderId = this.data.id
    this.setData({ openingCheckinType: eventType })
    try {
      if (isSanitization && order.status !== 'in_service') {
        await callFunction('order', 'checkServiceTimeReadyForCheckin', { id: orderId })
      }
      if (!isActive()) return
      await new Promise((resolve, reject) => {
        wx.navigateTo({
          url: '/pages/staff/checkin/camera/index?id=' + encodeURIComponent(orderId) + '&eventType=' + encodeURIComponent(eventType),
          success: resolve,
          fail: reject
        })
      })
    } catch (error) {
      if (isActive()) showError(error)
    } finally {
      if (isActive()) this.setData({ openingCheckinType: '' })
    }
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
    wx.showModal({
      title: '确认离开并完成服务？',
      content: '请确认已妥善关好门窗并离开客户家中。确认后系统将对门锁密码进行自动脱敏销毁，您将无法再次查看门锁密码。',
      confirmText: '确认离开',
      cancelText: '再检查下',
      success: (modalRes) => {
        if (!modalRes.confirm) return
        this._doFinish()
      }
    })
  },

  _doFinish() {
    if (this._finishingLock || this.data.finishing) return
    this._finishingLock = true
    this.setData({ finishing: true })
    showLoading({ title: '正在完成服务...', mask: true })
    this.uploadAutoTrackPoint()
      .then(() => this.flushOfflineTasks())
      .then(() => {
        if (getOfflineTaskCount(this.data.id) > 0) wx.showToast({ title: '仍有数据待补传，网络恢复后会继续上传', icon: 'none' })
      })
      .then(() => callFunction('order', 'finishService', { id: this.data.id, clientRequestId: createClientRequestId('finish_service') }))
      .then((res) => {
        hideLoading()
        this._finishingLock = false
        this.stopServiceElapsedTimer()
        this.stopAutoTracking()
        wx.showToast({ title: res && res.status === 'day_completed' ? '服务已完成，密码已销毁' : '服务已完成，密码已销毁', icon: 'success' })
        this.setData({ finishing: false, unlock: null })
        this.loadOrder()
      })
      .catch((error) => {
        hideLoading()
        this._finishingLock = false
        this.setData({ finishing: false })
        showError(error)
      })
  },

  departForService() {
    if (this.data.departing || !this.data.id) return
    wx.showModal({
      title: '出发前往服务地点',
      content: '点击出发后，系统将开启“时空雷达”，向宠物主实时同步您的预计到达时间。请确保准时出行。',
      confirmText: '现在出发',
      cancelText: '稍后再去',
      success: (modalRes) => {
        if (!modalRes.confirm) return
        this.setData({ departing: true })
        showLoading({ title: '获取当前定位中...', mask: true })

        const doDepart = (loc) => {
          showLoading({ title: '正在开启行程雷达...', mask: true })
          return callFunction('order', 'departForService', {
            orderId: this.data.id,
            latitude: loc && loc.latitude,
            longitude: loc && loc.longitude
          })
            .then(() => {
              wx.showToast({ title: '已出发前往，雷达已启动', icon: 'success' })
              this.loadOrder()
            })
            .catch((err) => {
              showError(err)
            })
            .finally(() => {
              hideLoading()
              this.setData({ departing: false })
            })
        }

        // 优先使用页面内置的 getRealtimeLocation，带 4 秒超时防护
        const locationTimeout = new Promise((resolve) => setTimeout(() => resolve(null), 4000))
        Promise.race([
          this.getRealtimeLocation().catch(() => null),
          locationTimeout
        ])
          .then((loc) => {
            if (loc && loc.latitude && loc.longitude) {
              return doDepart(loc)
            }
            // 降级尝试普通的 wx.getLocation
            return new Promise((resolve) => {
              wx.getLocation({
                type: 'gcj02',
                success: (fallbackLoc) => resolve(fallbackLoc),
                fail: () => resolve(null)
              })
            }).then((fallbackLoc) => {
              if (fallbackLoc && fallbackLoc.latitude && fallbackLoc.longitude) {
                return doDepart(fallbackLoc)
              }
              // 定位不可用时（模拟器或未开GPS），允许免定位直接出发（后端雷达会自动默认估算时间）
              return doDepart(null)
            })
          })
          .catch(() => {
            return doDepart(null)
          })
      }
    })
  },

  updateTravelLocation() {
    if (this.data.updatingTravelLocation || !this.data.id) return
    this.setData({ updatingTravelLocation: true })
    showLoading({ title: '正在更新行程位置...', mask: true })

    const locationTimeout = new Promise((resolve) => setTimeout(() => resolve(null), 4000))
    Promise.race([
      this.getRealtimeLocation().catch(() => null),
      locationTimeout
    ])
      .then((loc) => {
        if (!loc || !loc.latitude) {
          return new Promise((resolve) => {
            wx.getLocation({
              type: 'gcj02',
              success: resolve,
              fail: () => resolve(null)
            })
          })
        }
        return loc
      })
      .then((loc) => {
        if (!loc || !loc.latitude) {
          hideLoading()
          this.setData({ updatingTravelLocation: false })
          wx.showToast({ title: '无法获取当前位置', icon: 'none' })
          return
        }
        return callFunction('order', 'updateTravelLocation', {
          orderId: this.data.id,
          latitude: loc.latitude,
          longitude: loc.longitude
        })
          .then(() => {
            wx.showToast({ title: '位置与ETA已更新', icon: 'none' })
            this.loadOrder()
          })
          .catch(showError)
          .finally(() => {
            hideLoading()
            this.setData({ updatingTravelLocation: false })
          })
      })
      .catch(() => {
        hideLoading()
        this.setData({ updatingTravelLocation: false })
      })
  },

  openPrivacyCall() {
    if (!this.data.id) return
    showLoading('获取虚拟隐私通话...')
    callFunction('order', 'getPrivacyCallInfo', { orderId: this.data.id })
      .then((info) => {
        hideLoading()
        this.setData({ privacyCallInfo: info, showCallModal: true })
      })
      .catch((err) => {
        hideLoading()
        showError(err)
      })
  },

  confirmPrivacyCall() {
    const info = this.data.privacyCallInfo
    if (!info || !info.privacyNumber) return
    wx.makePhoneCall({
      phoneNumber: info.privacyNumber,
      complete: () => {
        this.setData({ showCallModal: false })
      }
    })
  },

  closePrivacyCallModal() {
    this.setData({ showCallModal: false })
  },

  ...sessionChatMethods(callFunction, requestSubscribeTemplates),

  onChatInput(e) {
    this.setData({ sessionInputText: e.detail.value })
  },

  sendChatMessage() {
    if (this.data.sendingChatMessage) return
    const content = (this.data.sessionInputText || '').trim()
    if (!content) {
      wx.showToast({ title: '请输入消息内容', icon: 'none' })
      return
    }
    this.setData({ sendingChatMessage: true })
    callFunction('order', 'sendOrderSessionMessage', {
      orderId: this.data.id,
      content
    })
      .then(() => {
        this._chatForceScroll = true
        this.setData({ sendingChatMessage: false, sessionInputText: '' })
        this.loadSessionMessages()
      })
      .catch((err) => {
        this.setData({ sendingChatMessage: false })
        const msg = (err && (err.message || err.errMsg)) || '发送失败，请稍后重试'
        const isRisk = msg.includes('平台安全拦截') || msg.includes('风控')
        wx.showModal({
          title: isRisk ? '风控合规拦截' : '发送失败',
          content: msg,
          showCancel: false
        })
      })
  },

  cancelAcceptedOrder() {
    if (this.data.cancelling) return
    const orderId = this.data.id
    if (!orderId) return
    showLoading('正在获取取消规则...')
    callFunction('staff', 'getStaffCancellationQuote', { orderId })
      .then((quote) => {
        hideLoading()
        if (!quote.canCancel) {
          wx.showModal({
            title: '不可取消',
            content: quote.ruleText || '当前订单不可取消，请联系平台客服协助处理',
            showCancel: false
          })
          return
        }

        const isDirect = quote.publishMode === 'direct'
        const title = isDirect ? '确认取消指定订单？' : '确认取消接单？'
        const content = isDirect
          ? '这是客户指定预约您的订单。您享有接单1小时内免责取消容错时间，取消后订单将关闭并全额退款给客户，不会进入公共抢单池。\n\n确认取消该订单吗？'
          : (quote.amountPendingReview
            ? '接单已超过10分钟，取消后订单将返回接单大厅供其他宠托师接单，您将无法再次抢该订单，且可能扣除保证金（需平台审核）。\n\n确认取消接单吗？'
            : '取消后订单将返回接单大厅供其他宠托师接单，您将无法再次抢该订单。\n\n确认取消接单吗？')

        wx.showModal({
          title,
          content,
          confirmText: '确认取消',
          confirmColor: '#ef4444',
          cancelText: '再想想',
          success: (res) => {
            if (res.confirm) {
              this.setData({ cancelling: true })
              showLoading('正在处理取消...')
              const requestId = `cancel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
              callFunction('staff', 'cancelStaffAcceptedOrder', {
                orderId,
                assignmentToken: quote.assignmentToken,
                reason: '宠托师主动取消',
                requestId
              })
                .then(() => {
                  hideLoading()
                  this.setData({ cancelling: false })
                  wx.showToast({ title: isDirect ? '已取消并全额退款' : '已取消并返回抢单池', icon: 'success' })
                  setTimeout(() => {
                    wx.navigateBack({
                      fail: () => {
                        wx.redirectTo({ url: '/pages/staff/orders/list/index' })
                      }
                    })
                  }, 1200)
                })
                .catch((err) => {
                  hideLoading()
                  this.setData({ cancelling: false })
                  showError(err)
                })
            }
          }
        })
      })
      .catch((err) => {
        hideLoading()
        showError(err)
      })
  },

  ...navMethods()
})
