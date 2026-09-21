const { callFunction, showError, requestSubscribeTemplates, loadSystemSettings } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { createClientRequestId } = require('../../../../utils/offlineQueue')
const { ensureLogin } = require('../../../../utils/cloud')
const { withOrderText, formatCheckinEvent } = require('../../../../utils/format')
const { applyTheme, getThemeState } = require('../../../../utils/theme')

function getRefundText(order = {}) {
  if (!order.refundStatus || order.refundStatus === 'not_required') return ''
  if (order.refundStatus === 'processing') return `退款处理中 ¥${order.refundAmount || 0}`
  if (order.refundStatus === 'success') return `已退款 ¥${order.refundAmount || 0}`
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

function showRemoteUnlockSubscribeTip(result, retryCallback) {
  // 如果未发起订阅请求，显示原因但允许继续
  if (!result || !result.requested) {
    const reasonMap = {
      subscription_disabled: '后台未启用订阅消息，你将无法收到服务通知。',
      request_api_unavailable: '当前微信版本不支持订阅消息接口，你将无法收到服务通知。',
      template_not_configured: '后台未配置开锁请求模板，你将无法收到服务通知。',
      request_failed: '微信订阅授权接口调用失败，你将无法收到服务通知。',
      settings_load_failed: '系统设置加载失败，你将无法收到服务通知。'
    }
    const message = reasonMap[result && result.reason] || '未能发起订阅授权，你将无法收到服务通知。'
    return new Promise((resolve, reject) => {
      wx.showModal({
        title: '提醒',
        content: message + '\n\n是否继续支付？',
        confirmText: '继续支付',
        cancelText: '取消',
        success: (res) => {
          if (res.confirm) resolve()
          else reject(new Error('用户取消支付'))
        },
        fail: reject
      })
    })
  }

  // 检查开锁通知是否授权
  const index = (result.templateKeys || []).indexOf('remoteUnlock')
  const templateId = index >= 0 ? result.templateIds[index] : ''
  const status = templateId ? result.results[templateId] : ''

  if (templateId && status !== 'accept') {
    return new Promise((resolve, reject) => {
      wx.showModal({
        title: '开锁通知未授权',
        content: '你没有允许”开锁请求通知”，宠托师请求开门时微信不会推送通知。\n\n建议授权以便及时收到开锁提醒。',
        confirmText: '重新授权',
        cancelText: '暂不授权',
        success: (res) => {
          if (res.confirm && typeof retryCallback === 'function') {
            // 用户选择重新授权，重新发起订阅请求
            retryCallback()
              .then(resolve)
              .catch(reject)
          } else if (res.confirm) {
            // 没有回调函数，继续支付
            resolve()
          } else {
            // 用户选择暂不授权，显示二次确认
            wx.showModal({
              title: '确认继续',
              content: '不授权将无法收到宠托师的开锁通知，可能影响服务体验。\n\n确定继续支付吗？',
              confirmText: '继续支付',
              cancelText: '取消支付',
              success: (res2) => {
                if (res2.confirm) resolve()
                else reject(new Error('用户取消支付'))
              },
              fail: reject
            })
          }
        },
        fail: reject
      })
    })
  }

  return Promise.resolve()
}

Page({
  data: { themeClass: 'theme-day', id: '', order: null, timeline: [], review: null, paying: false, cancelling: false, handlingEarlyStart: false, resettingCode: false, resetCodeForm: { code: '', effectiveStart: '', effectiveEnd: '' }, sectionHomeUrl: '', canGoBack: false },
  onLoad(q) {
    loadSystemSettings().catch(() => null)
    this.setData({ ...createPageNav(q), id: q.id })
  },
  onShow() {
    this.applyCurrentTheme()
    ensureLogin({ content: '登录后可查看订单详情。' })
      .then(() => this.load())
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },
  onHide() {
    this.stopEarlyStartPolling()
  },
  onUnload() {
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
      callFunction('order', 'getOrderReview', { orderId: this.data.id })
    ])
      .then(([order, timeline, review]) => {
        const displayOrder = withOrderText(order)
        this.setData({ order: { ...displayOrder, refundText: getRefundText(displayOrder) }, timeline: withTimelineText(timeline), review })
        callFunction('message', 'markOrderThreadRead', { orderId: this.data.id }).catch(() => {})
        if (displayOrder.earlyStartRequest && displayOrder.earlyStartRequest.status === 'pending') {
          this.checkPromptEarlyStart(displayOrder.earlyStartRequest)
        }
        if (['assigned', 'day_completed'].includes(displayOrder.status)) {
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
    if (!order || !['assigned', 'day_completed'].includes(order.status)) return

    this.earlyStartPollTimer = setInterval(() => {
      if (!this.data.id || this.data.handlingEarlyStart || this.data.paying) return
      callFunction('order', 'getEarlyStartStatus', { id: this.data.id })
        .then((earlyStart) => {
          if (!earlyStart) return
          const currentReq = this.data.order && this.data.order.earlyStartRequest
          if (!currentReq || currentReq.status !== earlyStart.status || currentReq._id !== earlyStart._id) {
            this.setData({
              'order.earlyStartRequest': earlyStart
            })
            if (earlyStart.status === 'pending') {
              this.checkPromptEarlyStart(earlyStart)
            } else {
              this.load()
            }
          }
        })
        .catch(() => {})
    }, 5000)
  },
  stopEarlyStartPolling() {
    if (this.earlyStartPollTimer) {
      clearInterval(this.earlyStartPollTimer)
      this.earlyStartPollTimer = null
    }
  },
  pay() {
    if (this.data.paying) return
    this.setData({ paying: true })
    const clientRequestId = createClientRequestId('pay')

    // 定义重新授权的函数
    const requestSubscribe = () => requestSubscribeTemplates(['orderAccepted', 'serviceStart', 'remoteUnlock'], 'client_pay')

    requestSubscribe()
      .then((subscribeResult) => {
        // 传入重新授权的回调函数
        return showRemoteUnlockSubscribeTip(subscribeResult, requestSubscribe)
      })
      .then(() => callFunction('payment', 'createPayment', { orderId: this.data.id, clientRequestId }))
      .then((payment) => {
        if (payment.paid) return payment
        if (payment.mock) {
          return callFunction('payment', 'mockPayOrder', { orderId: this.data.id, paymentNo: payment.paymentNo })
        }
        if (!payment.payParams) throw new Error(payment.message || '微信支付参数未配置')
        return new Promise((resolve, reject) => {
          wx.requestPayment({
            ...payment.payParams,
            success: resolve,
            fail: reject
          })
        }).then(() => callFunction('payment', 'getPaymentStatus', { orderId: this.data.id }))
      })
      .then((result) => {
        const paid = result && (result.paid || result.paymentStatus === 'paid' || result.status === 'paid')
        wx.showToast({ title: paid ? '已支付' : '支付处理中，请稍后刷新订单状态', icon: paid ? 'success' : 'none' })
        this.setData({ paying: false })
        this.load()
      })
      .catch((error) => {
        this.setData({ paying: false })
        const errorMessage = (error && (error.errMsg || error.message)) || ''
        if (errorMessage.includes('cancel') || errorMessage.includes('取消')) {
          wx.showToast({ title: '已取消支付', icon: 'none' })
        } else if (errorMessage.includes('配置') || errorMessage.includes('未完成')) {
          wx.showToast({ title: '微信支付暂未配置完成', icon: 'none' })
        } else if (errorMessage.includes('微信支付下单失败')) {
          wx.showToast({ title: '微信支付下单失败，请稍后重试', icon: 'none' })
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
    const security = this.data.order && this.data.order.orderHomeSecurity
    const code = security && security.oneTimeCode
    this.setData({
      resettingCode: true,
      resetCodeForm: {
        code: '',
        effectiveStart: code && code.effectiveStart ? code.effectiveStart : (this.data.order && this.data.order.startTime) || '',
        effectiveEnd: code && code.effectiveEnd ? code.effectiveEnd : (this.data.order && this.data.order.endTime) || ''
      }
    })
  },
  cancelResetOneTimeCode() { this.setData({ resettingCode: false }) },
  saveResetOneTimeCode() {
    const form = this.data.resetCodeForm
    if (!form.code || !form.effectiveStart || !form.effectiveEnd) {
      wx.showToast({ title: '请填写密码和有效区间', icon: 'none' })
      return
    }
    callFunction('homeSecurity', 'updateOrderOneTimeCode', { orderId: this.data.id, ...form })
      .then(() => {
        wx.showToast({ title: '已更新' })
        this.setData({ resettingCode: false })
        this.load()
      })
      .catch(showError)
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
            callFunction('order', 'cancelOrder', { orderId: this.data.id, reason: '宠物主取消', clientRequestId: createClientRequestId('cancel') })
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

  ...navMethods()
})
