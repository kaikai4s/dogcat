const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')

Page({
  data: { orderId: '', staff: [], staffProfileId: '', sectionHomeUrl: '', canGoBack: false },
  onLoad(q) { this.setData({ ...createPageNav(q), orderId: q.id }); callFunction('admin', 'listStaffAudits', { auditStatus: 'approved' }).then((staff) => this.setData({ staff, staffProfileId: staff[0]?._id || '' })).catch(showError) },
  choose(e) { this.setData({ staffProfileId: this.data.staff[e.detail.value]._id }) },
  assign() {
    if (!this.data.orderId || !this.data.staffProfileId) return
    wx.showModal({
      title: '确认派单',
      content: '确认将该订单指派给选中的宠托师？',
      success: (res) => {
        if (!res.confirm) return
        callFunction('admin', 'assignOrder', { orderId: this.data.orderId, staffProfileId: this.data.staffProfileId })
          .then(() => {
            wx.showToast({ title: '已派单' })
            if (getCurrentPages().length > 1) wx.navigateBack()
            else wx.redirectTo({ url: '/pages/admin/orders/list/index' })
          })
          .catch(showError)
      }
    })
  },
  ...navMethods()
})
