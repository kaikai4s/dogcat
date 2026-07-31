const { callFunction, showError, ensureLogin } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')

const CONTEXT_KEY = 'vip_pet_coupon_select_context'
const SELECTED_KEY = 'vip_pet_selected_coupon'

Page({
  data: {
    coupons: [],
    selectedCouponId: '',
    loading: false,
    canGoBack: false
  },

  onLoad(query) {
    this.setData({ ...createPageNav(query), selectedCouponId: query.selectedCouponId || '' })
  },

  onShow() {
    ensureLogin({ content: '登录后可选择优惠券。' })
      .then(() => this.load())
      .catch(() => wx.navigateBack())
  },

  load() {
    const context = wx.getStorageSync(CONTEXT_KEY) || {}
    this.setData({ loading: true })
    callFunction('coupon', 'listApplicableCoupons', context)
      .then((coupons) => this.setData({ coupons, loading: false }))
      .catch((error) => {
        this.setData({ loading: false })
        showError(error)
      })
  },

  select(e) {
    const coupon = this.data.coupons[e.currentTarget.dataset.index]
    if (!coupon || !coupon.applicable) {
      wx.showToast({ title: coupon ? coupon.reason : '优惠券不可用', icon: 'none' })
      return
    }
    wx.setStorageSync(SELECTED_KEY, coupon)
    wx.navigateBack()
  },

  clearCoupon() {
    wx.setStorageSync(SELECTED_KEY, { clear: true })
    wx.navigateBack()
  },

  ...navMethods()
})
