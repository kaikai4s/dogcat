const serviceTracking = require('../../utils/serviceTrackingManager')

function isCurrentServicePage(orderId) {
  const pages = getCurrentPages()
  const current = pages[pages.length - 1] || {}
  const route = current.route || ''
  const options = current.options || {}
  return route === 'pages/staff/orders/service/index' && options.id === orderId
}

Component({
  data: {
    visible: false,
    activeService: null,
    trackingDescription: ''
  },

  lifetimes: {
    attached() {
      this._trackingDetached = false
      this._unsubscribeTracking = serviceTracking.subscribe(state => {
        if (this._trackingDetached) return
        const orderId = state.orderId
        this.setData({
          activeService: orderId ? { orderId } : null,
          visible: Boolean(orderId) && !isCurrentServicePage(orderId),
          trackingDescription: state.backgroundTracking
            ? '后台定位已开启，可切换页面或返回微信'
            : state.trackingState === 'starting'
              ? '正在开启服务定位'
              : '后台定位未开启，请前往服务页面设置'
        })
      })
      this.loadActiveService()
    },
    detached() {
      this._trackingDetached = true
      if (this._unsubscribeTracking) this._unsubscribeTracking()
      this._unsubscribeTracking = null
    }
  },

  pageLifetimes: {
    show() {
      this.loadActiveService()
    }
  },

  methods: {
    loadActiveService() {
      const state = serviceTracking.getSnapshot()
      this.setData({ visible: Boolean(state.orderId) && !isCurrentServicePage(state.orderId) })
      return serviceTracking.reconcileActiveService()
    },

    goService() {
      const orderId = this.data.activeService && this.data.activeService.orderId
      if (!orderId) return
      wx.navigateTo({ url: '/pages/staff/orders/service/index?id=' + orderId })
    }
  }
})
