const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { ensureLogin } = require('../../../../utils/cloud')
const { withOrderText } = require('../../../../utils/format')

Page({
  data: { id: '', order: null, timeline: [], review: null, sectionHomeUrl: '', canGoBack: false },
  onLoad(q) { this.setData({ ...createPageNav(q), id: q.id }) },
  onShow() {
    ensureLogin({ content: '登录后可查看订单详情。' })
      .then(() => this.load())
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },
  load() {
    Promise.all([
      callFunction('order', 'getOrderDetail', { id: this.data.id }),
      callFunction('order', 'getOrderTimeline', { orderId: this.data.id }),
      callFunction('order', 'getOrderReview', { orderId: this.data.id })
    ])
      .then(([order, timeline, review]) => this.setData({ order: withOrderText(order), timeline, review }))
      .catch(showError)
  },
  pay() { callFunction('payment', 'mockPayOrder', { orderId: this.data.id }).then(() => { wx.showToast({ title: '已支付' }); this.load() }).catch(showError) },
  tracking() { wx.navigateTo({ url: '/pages/client/orders/tracking/index?id=' + this.data.id }) },
  report() { wx.navigateTo({ url: '/pages/client/orders/report/index?id=' + this.data.id }) },
  rebook() { wx.navigateTo({ url: '/pages/client/orders/create/index?rebookOrderId=' + this.data.id }) },
  reviewOrder() { wx.navigateTo({ url: '/pages/client/orders/review/index?id=' + this.data.id }) },
  cancelOrder() {
    callFunction('order', 'getCancelQuote', { orderId: this.data.id })
      .then((quote) => {
        if (!quote.canCancel) {
          wx.showToast({ title: quote.ruleText, icon: 'none' })
          return
        }
        wx.showModal({
          title: '取消订单',
          content: `${quote.ruleText}，预计退款 ¥${quote.refundAmount}。确认取消吗？`,
          success: (res) => {
            if (!res.confirm) return
            callFunction('order', 'cancelOrder', { orderId: this.data.id, reason: '宠物主取消' })
              .then(() => {
                wx.showToast({ title: '已取消' })
                this.load()
              })
              .catch(showError)
          }
        })
      })
      .catch(showError)
  },

  ...navMethods()
})
