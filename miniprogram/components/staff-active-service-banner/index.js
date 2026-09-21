const { callFunction } = require('../../utils/cloud')

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
    activeService: null
  },

  lifetimes: {
    attached() {
      this.loadActiveService()
    }
  },

  pageLifetimes: {
    show() {
      this.loadActiveService()
    }
  },

  methods: {
    loadActiveService() {
      callFunction('order', 'getActiveService')
        .then((activeService) => {
          const orderId = activeService && activeService.orderId
          this.setData({
            activeService: activeService || null,
            visible: Boolean(orderId) && !isCurrentServicePage(orderId)
          })
        })
        .catch(() => this.setData({ activeService: null, visible: false }))
    },

    goService() {
      const orderId = this.data.activeService && this.data.activeService.orderId
      if (!orderId) return
      wx.navigateTo({ url: '/pages/staff/orders/service/index?id=' + orderId })
    }
  }
})
