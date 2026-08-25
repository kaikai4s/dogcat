const { callFunction, showError } = require('../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../utils/nav')
const { ensureLogin } = require('../../../utils/cloud')

Page({
  data: { history: [], loading: false, sectionHomeUrl: '', canGoBack: false },
  onLoad(query) { this.setData(createPageNav(query)) },
  onShow() {
    ensureLogin({ content: '登录后可查看家庭安防历史。' })
      .then(() => this.load())
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },
  load() {
    this.setData({ loading: true })
    callFunction('homeSecurity', 'listHomeSecurityHistory', { limit: 50 })
      .then((history) => this.setData({ history: history || [], loading: false }))
      .catch((error) => {
        this.setData({ loading: false })
        showError(error)
      })
  },
  rebook(e) {
    const orderId = e.currentTarget.dataset.id
    if (orderId) wx.navigateTo({ url: '/pages/client/orders/create/index?rebookOrderId=' + orderId })
  },
  ...navMethods()
})
