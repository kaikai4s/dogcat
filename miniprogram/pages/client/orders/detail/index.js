const { sessionChatMethods } = require('../utils/sessionChat')
const { callFunction, showError, requestSubscribeTemplates, loadSystemSettings, showLoading, hideLoading } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { createClientRequestId } = require('../../../../utils/offlineQueue')
const { ensureLogin } = require('../../../../utils/cloud')
const { withOrderText, formatCheckinEvent, buildOrderCareCards } = require('../../../../utils/format')
const { applyTheme, getThemeState } = require('../../../../utils/theme')

function getRefundText(order = {}) {
  if (!order.refundStatus || order.refundStatus === 'not_required') return ''
  if (order.refundStatus === 'processing') return `退款处理中 ¥${order.refundAmount || 0}`
  if (['success', 'full_refunded', 'partially_refunded'].includes(order.refundStatus)) return `${order.refundStatus === 'partially_refunded' ? '已部分退款' : '已退款'} ¥${order.refundedAmount == null ? (order.refundAmount || 0) : order.refundedAmount}`
  if (order.refundStatus === 'failed') return '退款失败，请联系平台'
  return '退款待处理'
}

function withTimelineText(list = []) {
  return list.map((item) => {
    if (item.title !== '服务打卡') return item
    const detailText = formatCheckinEvent(item.detail)
    return { ...item, detail: detailText || item.detail }
  })
}

const TRANSIT_FIELDS = [
  'travelLocation', 'travelDeparted', 'travelDepartedAt',
  'currentLocation', 'departureLocation', 'distanceFromDestinationKm',
  'travelDistanceKm', 'estimatedTravelMinutes', 'travelEtaMinutes',
  'estimatedArrivalTime', 'radarProximityNotifiedAt', 'radarProximityNotified',
  'radarApproachingNotifiedAt', 'radarApproachingNotified'
]

function clearTransitFields(order) {
  if (!order || order.status === 'on_the_way') return order
  return TRANSIT_FIELDS.reduce((next, key) => {
    next[key] = ['travelDeparted', 'radarProximityNotified', 'radarApproachingNotified'].includes(key) ? false : null
    return next
  }, { ...order })
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isPaidResult(result) {
  return result && (result.paid || result.paymentStatus === 'paid' || result.status === 'paid')
}

function showRemoteUnlockSubscribeTip(result, retryCallback) {
  if (!result || !result.requested) return Promise.resolve()
  // Keys may share an ID, so their indexes do not match the deduplicated ID list.
  const templateId = result.templateIdByKey && result.templateIdByKey.remoteUnlock
  if (templateId && result.results && result.results[templateId] !== 'accept') {
    return new Promise((resolve) => {
      wx.showModal({
        title: '远程开门提醒未开启',
        content: '可重新订阅，及时收到宠托师的开门请求；也可继续支付，稍后在消息中心开启。',
        confirmText: '重新授权',
        cancelText: '继续支付',
        success: (res) => {
          if (res.confirm && typeof retryCallback === 'function') {
            retryCallback().then(resolve).catch(() => resolve())
          } else {
            resolve()
          }
        },
        fail: () => resolve()
      })
    })
  }

  return Promise.resolve()
}

Page({
  data: {
    themeClass: 'theme-day',
    id: '',
    order: null,
    timeline: [],
    review: null,
    liveCheckins: [],
    sessionMessages: [],
    sessionScrollTarget: '',
    sessionUnreadCount: 0,
    sessionChatError: '',
    sessionInputText: '',
    showChatModal: false,
    sendingChatMessage: false,
    privacyCallInfo: null,
    showCallModal: false,
    paying: false,
    cancelling: false,
    handlingEarlyStart: false,
    resettingCode: false,
    resetSessionOptions: [],
    selectedResetSessionIdx: 0,
    resetCodeForm: { code: '', effectiveStart: '', effectiveEnd: '' },
    sectionHomeUrl: '',
    canGoBack: false
  },
  onLoad(q) {
    this.setData({ ...createPageNav(q), id: q.id })
    if (q.openChat === '1' || q.openChat === 'true' || q.openChat === true) {
      this._autoOpenChat = true
    }
  },
    onPullDownRefresh() {
    Promise.resolve(this.load()).finally(() => wx.stopPullDownRefresh())
  },

  onShow() {
    loadSystemSettings().catch(() => null)
    this._chatPageVisible = true
    this.applyCurrentTheme()
    ensureLogin({ content: '登录后可查看订单详情。' })
      .then(() => {
        this.load()
        if (this._autoOpenChat) {
          this._autoOpenChat = false
          setTimeout(() => {
            if (typeof this.openSessionChat === 'function') this.openSessionChat({ silent: true })
          }, 400)
        }
        if (this._chatPageVisible && this.data.showChatModal) this.startSessionChatRefresh()
      })
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },
  onHide() {
    this._chatPageVisible = false
    this.stopSessionChatRefresh()
    this.stopEarlyStartPolling()
  },
  onUnload() {
    this._chatPageVisible = false
    this.stopSessionChatRefresh()
    this.stopEarlyStartPolling()
  },
  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },
  load() {
    Promise.all([
      callFunction('order', 'getOrderDetail', { id: this.data.id }),
      callFunction('order', 'getOrderTimeline', { orderId: this.data.id }),
      callFunction('order', 'getOrderReview', { orderId: this.data.id }),
      callFunction('checkin', 'listOrderCheckins', { orderId: this.data.id }).catch(() => [])
    ])
      .then(([order, timeline, review, checkins]) => {
        if (!order) return
        const displayOrder = withOrderText(order)
        const careCards = buildOrderCareCards(displayOrder)
        const liveCheckins = (checkins || []).filter(item => item.mediaFileId)
        this.setData({
          order: { ...displayOrder, refundText: getRefundText(displayOrder), careCards, hasHighRiskCare: careCards.some((card) => card.isHighRisk) },
          timeline: withTimelineText(timeline),
          review,
          liveCheckins
        })
        callFunction('message', 'markOrderThreadRead', { orderId: this.data.id }).catch(() => {})
        if (displayOrder.earlyStartRequest && displayOrder.earlyStartRequest.status === 'pending') {
          this.checkPromptEarlyStart(displayOrder.earlyStartRequest)
        }
        if (['assigned', 'on_the_way', 'in_service', 'day_completed'].includes(displayOrder.status)) {
          this.startEarlyStartPolling()
        } else {
          this.stopEarlyStartPolling()
        }
      })
      .catch(showError)
  },
  checkPromptEarlyStart(earlyStartRequest) {
    if (!earlyStartRequest || earlyStartRequest.status !== 'pending') return
    const requestId = earlyStartRequest._id || 'pending'
    if (this.promptedEarlyStartId === requestId) return
    this.promptedEarlyStartId = requestId

    const staffName = (this.data.order && (this.data.order.staffName || this.data.order.requestedStaffName)) || '宠托师'
    const reason = earlyStartRequest.reason || '宠护师已到达，申请提前开始服务'
    wx.showModal({
      title: '提前开始服务申请',
      content: `${staffName}已到达并申请提前开始服务：\n"${reason}"\n\n是否同意提前开始？`,
      confirmText: '同意开始',
      cancelText: '拒绝',
      success: (res) => {
        if (res.confirm) {
          this.handleEarlyStartAction('approve')
        } else if (res.cancel) {
          this.handleEarlyStartAction('reject')
        }
      }
    })
  },
  startEarlyStartPolling() {
    this.stopEarlyStartPolling()
    const order = this.data.order
    if (!order || !['assigned', 'on_the_way', 'in_service', 'day_completed'].includes(order.status)) return

    this.earlyStartPollTimer = setInterval(() => {
      if (!this.data.id || this.data.handlingEarlyStart || this.data.paying || this._earlyStartPollRequest) return
      const pollSeq = this._earlyStartPollSeq = (this._earlyStartPollSeq || 0) + 1
      this._earlyStartPollRequest = callFunction('order', 'getOrderProgress', { id: this.data.id })
        .then((progress) => {
          if (!progress || pollSeq !== this._earlyStartPollSeq) return
          const currentOrder = this.data.order || {}
          const mergedOrder = clearTransitFields({
            ...currentOrder,
            status: progress.status || currentOrder.status,
            earlyStartRequest: progress.earlyStartRequest || null,
            trackRevision: progress.trackRevision,
            checkinRevision: progress.checkinRevision,
            currentSessionStartedAt: progress.currentSessionStartedAt || currentOrder.currentSessionStartedAt,
            activeSessionIndex: progress.activeSessionIndex || currentOrder.activeSessionIndex,
            serviceStarted: progress.serviceStarted === true
          })
          const displayOrder = withOrderText(mergedOrder)
          const careCards = buildOrderCareCards(displayOrder)
          const nextData = { order: { ...displayOrder, refundText: getRefundText(displayOrder), careCards, hasHighRiskCare: careCards.some((card) => card.isHighRisk) } }
          if (Array.isArray(progress.liveCheckins)) nextData.liveCheckins = progress.liveCheckins.filter(item => item.mediaFileId)
          this.setData(nextData)
          if (displayOrder.earlyStartRequest && displayOrder.earlyStartRequest.status === 'pending') {
            this.checkPromptEarlyStart(displayOrder.earlyStartRequest)
          }
          if (!['assigned', 'on_the_way', 'in_service', 'day_completed'].includes(displayOrder.status)) {
            this.stopEarlyStartPolling()
          }
        })
        .catch(() => {})
        .finally(() => { this._earlyStartPollRequest = null })
    }, 10000)
  },
  stopEarlyStartPolling() {
    if (this.earlyStartPollTimer) {
      clearInterval(this.earlyStartPollTimer)
      this.earlyStartPollTimer = null
    }
    this._earlyStartPollSeq = (this._earlyStartPollSeq || 0) + 1
  },
  syncPaymentStatusWithRetry() {
    const delays = [0, 800, 1600, 2500]
    let lastResult = null
    const run = (index) => {
      const delay = delays[index] || 0
      return wait(delay)
        .then(() => {
          if (index > 0) showLoading({ title: '正在确认支付结果...', mask: true })
          return callFunction('payment', 'getPaymentStatus', { orderId: this.data.id })
        })
        .then((result) => {
          lastResult = result
          if (isPaidResult(result) || index >= delays.length - 1) return result
          return run(index + 1)
        })
        .catch((error) => {
          if (index >= delays.length - 1) throw error
          lastResult = lastResult || { paymentStatus: 'paying' }
          return run(index + 1)
        })
    }
    return run(0)
  },
  subscribeServiceUpdates() {
    if (this._subscribingUpdates) return
    this._subscribingUpdates = true
    const keys = this.data.order && this.data.order.status === 'in_service'
      ? ['serviceFinish', 'serviceProgress', 'remoteUnlock']
      : ['staffDeparture', 'serviceStart', 'serviceFinish']
    return requestSubscribeTemplates(keys, 'client_order_detail_recharge', { waitForConsent: false })
      .then((res) => {
        const accepted = res && res.requested && (res.templateIds || []).filter(id => res.results && res.results[id] === 'accept').length || 0
        const departureId = res && res.templateIdByKey && res.templateIdByKey.staffDeparture
        const departureAccepted = departureId && res.results && res.results[departureId] === 'accept'
        const title = departureAccepted ? '已同意出发提醒' : accepted ? (accepted === (res.templateIds || []).length ? '已同意服务提醒' : '部分提醒已同意') : '未开启提醒，可重新订阅'
        wx.showToast({ title, icon: departureAccepted ? 'success' : 'none' })
      })
      .catch(showError)
      .finally(() => { this._subscribingUpdates = false })
  },
  pay() {
    if (this._payingLock || this.data.paying) return
    this._payingLock = true
    this.setData({ paying: true })
    showLoading({ title: '准备支付中...', mask: true })
    const clientRequestId = createClientRequestId('pay')

    // 定义重新授权的函数
    const requestSubscribe = () => requestSubscribeTemplates(['serviceFinish', 'remoteUnlock', 'refundResult'], 'client_pay')

    requestSubscribe()
      .then((subscribeResult) => {
        // 传入重新授权的回调函数
        return showRemoteUnlockSubscribeTip(subscribeResult, () => requestSubscribeTemplates(['remoteUnlock'], 'client_pay_remote_retry'))
      })
      .then(() => callFunction('payment', 'createPayment', { orderId: this.data.id, clientRequestId }))
      .then((payment) => {
        if (payment.paid) return payment
        if (payment.mock) {
          return callFunction('payment', 'mockPayOrder', { orderId: this.data.id, paymentNo: payment.paymentNo })
        }
        if (!payment.payParams) throw new Error(payment.message || '微信支付参数未配置')
        hideLoading()
        return new Promise((resolve, reject) => {
          wx.requestPayment({
            ...payment.payParams,
            success: resolve,
            fail: reject
          })
        }).then(() => {
          showLoading({ title: '正在同步支付结果...', mask: true })
          return this.syncPaymentStatusWithRetry()
        })
      })
      .then((result) => {
        hideLoading()
        this._payingLock = false
        const paid = isPaidResult(result)
        wx.showToast({ title: paid ? '已支付' : '支付处理中，请稍后刷新订单状态', icon: paid ? 'success' : 'none' })
        this.setData({ paying: false })
        this.load()
      })
      .catch((error) => {
        hideLoading()
        this._payingLock = false
        this.setData({ paying: false })
        const errorMessage = (error && (error.errMsg || error.message)) || ''
        if (errorMessage.includes('cancel') || errorMessage.includes('取消')) {
          wx.showToast({ title: '已取消支付', icon: 'none' })
        } else {
          showError(error)
        }
      })
  },
  tracking() { wx.navigateTo({ url: '/pages/client/orders/tracking/index?id=' + this.data.id }) },
  report() { wx.navigateTo({ url: '/pages/client/orders/report/index?id=' + this.data.id }) },
  rebook() { wx.navigateTo({ url: '/pages/client/orders/create/index?rebookOrderId=' + this.data.id }) },
  reviewOrder() { wx.navigateTo({ url: '/pages/client/orders/review/index?id=' + this.data.id }) },
  createIncident() { wx.navigateTo({ url: '/pages/client/incidents/create/index?id=' + this.data.id }) },
  inputResetCode(e) { this.setData({ ['resetCodeForm.' + e.currentTarget.dataset.field]: e.detail.value }) },
  showResetOneTimeCode() {
    const order = this.data.order || {}
    const security = order.orderHomeSecurity || {}
    const code = security.oneTimeCode
    const sessions = Array.isArray(order.serviceSessions) ? order.serviceSessions.filter(s => s.status !== 'cancelled') : []
    const resetSessionOptions = [{ label: sessions.length > 1 ? '整单通用/首场密码' : '本次服务开门密码', sessionIndex: null, date: '', startTime: (code && code.effectiveStart) || order.startTime || '', endTime: (code && code.effectiveEnd) || order.endTime || '' }]
    if (sessions.length > 1) {
      sessions.forEach(s => {
        const existingSessionCode = Array.isArray(security.sessionCodes) ? security.sessionCodes.find(item => Number(item.sessionIndex || item.index) === Number(s.index)) : null
        resetSessionOptions.push({
          label: `第${s.index}天专属密码 (${s.date || ''})`,
          sessionIndex: s.index,
          date: s.date || '',
          startTime: (existingSessionCode && existingSessionCode.effectiveStart) || s.startTime || '',
          endTime: (existingSessionCode && existingSessionCode.effectiveEnd) || s.endTime || ''
        })
      })
    }

    this.setData({
      resettingCode: true,
      resetSessionOptions,
      selectedResetSessionIdx: 0,
      resetCodeForm: {
        sessionIndex: null,
        date: '',
        code: '',
        effectiveStart: resetSessionOptions[0].startTime,
        effectiveEnd: resetSessionOptions[0].endTime
      }
    })
  },
  chooseResetSession(e) {
    const idx = Number(e.detail.value) || 0
    const opt = this.data.resetSessionOptions[idx] || this.data.resetSessionOptions[0]
    this.setData({
      selectedResetSessionIdx: idx,
      ['resetCodeForm.sessionIndex']: opt.sessionIndex,
      ['resetCodeForm.date']: opt.date || '',
      ['resetCodeForm.code']: '',
      ['resetCodeForm.effectiveStart']: opt.startTime || '',
      ['resetCodeForm.effectiveEnd']: opt.endTime || ''
    })
  },
  cancelResetOneTimeCode() { this.setData({ resettingCode: false }) },
  saveResetOneTimeCode() {
    if (this._savingCodeLock) return
    const form = this.data.resetCodeForm
    if (!form.code || !form.effectiveStart || !form.effectiveEnd) {
      wx.showToast({ title: '请填写智能锁临时密码和有效区间', icon: 'none' })
      return
    }
    this._savingCodeLock = true
    showLoading({ title: '正在保存密码...', mask: true })
    callFunction('homeSecurity', 'updateOrderOneTimeCode', { orderId: this.data.id, ...form })
      .then(() => {
        hideLoading()
        this._savingCodeLock = false
        wx.showToast({ title: '密码已更新' })
        this.setData({ resettingCode: false })
        this.load()
      })
      .catch((err) => {
        hideLoading()
        this._savingCodeLock = false
        showError(err)
      })
  },
  handleEarlyStart(e) {
    const action = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.action
    this.handleEarlyStartAction(action || 'approve')
  },
  handleEarlyStartAction(action) {
    if (this.data.handlingEarlyStart) return
    const approve = action === 'approve'
    this.setData({ handlingEarlyStart: true })

    // 定义重新授权的函数
    const requestSubscribe = () => requestSubscribeTemplates(['serviceStart'], 'client_early_start')

    // 如果用户同意提前服务，先请求订阅通知
    const subscribePromise = approve ? requestSubscribe() : Promise.resolve({ requested: false })

    subscribePromise
      .then((subscribeResult) => {
        // 如果是同意操作且未授权，提示用户
        if (approve && subscribeResult && subscribeResult.requested) {
          const index = (subscribeResult.templateKeys || []).indexOf('serviceStart')
          const templateId = index >= 0 ? subscribeResult.templateIds[index] : ''
          const status = templateId ? subscribeResult.results[templateId] : ''

          if (templateId && status !== 'accept') {
            return new Promise((resolve, reject) => {
              wx.showModal({
                title: '服务通知未授权',
                content: '你没有允许"服务开始通知"，宠托师开始服务时微信不会推送通知。\n\n建议授权以便及时了解服务进度。',
                confirmText: '重新授权',
                cancelText: '暂不授权',
                success: (res) => {
                  if (res.confirm) {
                    // 重新授权
                    requestSubscribe().then(resolve).catch(reject)
                  } else {
                    // 暂不授权，继续操作
                    resolve()
                  }
                },
                fail: reject
              })
            })
          }
        }
        return Promise.resolve()
      })
      .then(() => callFunction('order', approve ? 'approveEarlyStart' : 'rejectEarlyStart', { id: this.data.id }))
      .then(() => {
        wx.showToast({ title: approve ? '已同意提前开始' : '已拒绝', icon: 'none' })
        this.setData({ handlingEarlyStart: false })
        this.load()
      })
      .catch((error) => {
        this.setData({ handlingEarlyStart: false })
        showError(error)
      })
  },
  openOrderMessages() {
    if (!this.data.id) return
    wx.navigateTo({ url: '/pages/client/messages/thread/index?orderId=' + this.data.id })
  },
  cancelOrder() {
    if (this.data.cancelling) return
    this.setData({ cancelling: true })
    callFunction('order', 'getCancelQuote', { orderId: this.data.id })
      .then((quote) => {
        if (!quote.canCancel) {
          this.setData({ cancelling: false })
          wx.showToast({ title: quote.ruleText, icon: 'none' })
          return
        }
        wx.showModal({
          title: '取消订单',
          content: `${quote.ruleText}，预计退款 ¥${quote.refundAmount}。确认取消吗？`,
          success: (res) => {
            if (!res.confirm) {
              this.setData({ cancelling: false })
              return
            }
            const consent = Number(quote.refundAmount) > 0
              ? requestSubscribeTemplates(['refundResult'], 'client_cancel_refund', { waitForConsent: false }).catch(() => null)
              : Promise.resolve()
            consent.then(() => callFunction('order', 'cancelOrder', { orderId: this.data.id, reason: '宠物主取消', clientRequestId: createClientRequestId('cancel') }))
              .then(() => {
                wx.showToast({ title: '已取消' })
                this.setData({ cancelling: false })
                this.load()
              })
              .catch((error) => {
                this.setData({ cancelling: false })
                showError(error)
              })
          },
          fail: () => this.setData({ cancelling: false })
        })
      })
      .catch((error) => {
        this.setData({ cancelling: false })
        showError(error)
      })
  },

  previewLiveCheckinPhoto(e) {
    const current = e.currentTarget.dataset.url
    const urls = (this.data.liveCheckins || []).map(item => item.mediaFileId).filter(Boolean)
    if (current && urls.length) {
      wx.previewImage({ current, urls })
    }
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

  ...navMethods()
})
