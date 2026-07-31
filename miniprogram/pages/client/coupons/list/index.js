const { callFunction, showError, ensureLogin } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')

const tabs = [
  { label: '可用', value: 'available' },
  { label: '已使用', value: 'used' },
  { label: '已过期', value: 'expired' }
]

Page({
  data: {
    tabs,
    activeStatus: 'available',
    coupons: [],
    loading: false,
    canGoBack: false
  },

  onLoad(query) {
    this.setData(createPageNav(query))
  },

  onShow() {
    ensureLogin({ content: '登录后可查看优惠券。' })
      .then(() => this.load())
      .catch(() => wx.redirectTo({ url: '/pages/client/profile/index' }))
  },

  chooseStatus(e) {
    this.setData({ activeStatus: e.currentTarget.dataset.status }, this.load)
  },

  load() {
    this.setData({ loading: true })
    callFunction('coupon', 'listMyCoupons', { status: this.data.activeStatus })
      .then((coupons) => this.setData({ coupons, loading: false }))
      .catch((error) => {
        this.setData({ loading: false })
        showError(error)
      })
  },

  ...navMethods()
})
