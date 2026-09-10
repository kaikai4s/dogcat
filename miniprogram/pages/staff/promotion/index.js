const { callFunction, showError } = require('../../../utils/cloud')
const { withOrderText, withStaffWorkflowText } = require('../../../utils/format')
const { applyTheme, getThemeState } = require('../../../utils/theme')

Page({
  data: {
    themeClass: 'theme-day',
    profile: null,
    orders: [],
    count: 0,
    canSubmitPromotion: false,
    remark: '',
    loading: false
  },

  onShow() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
    this.load()
  },

  load() {
    this.setData({ loading: true })
    callFunction('staff', 'getTrainingStatus')
      .then((res) => {
        const orders = (res.completedInternOrders || []).map(withOrderText)
        this.setData({
          profile: withStaffWorkflowText(res.profile),
          orders,
          count: res.completedInternOrderCount || orders.length,
          canSubmitPromotion: res.canSubmitPromotion,
          loading: false
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        showError(err)
      })
  },

  inputRemark(e) {
    this.setData({ remark: e.detail.value })
  },

  submit() {
    wx.showModal({
      title: '申请晋升认证宠托师',
      content: '提交后管理员将审核最近三单服务报告质量，确认提交吗？',
      success: (res) => {
        if (!res.confirm) return
        callFunction('staff', 'submitPromotionApplication', { remark: this.data.remark })
          .then(() => {
            wx.showToast({ title: '已提交申请', icon: 'none' })
            this.load()
          })
          .catch(showError)
      }
    })
  }
})
