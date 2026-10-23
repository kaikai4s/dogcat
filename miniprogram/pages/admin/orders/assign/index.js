const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')

Page({
  data: { orderId: '', staff: [], staffProfileId: '', selectedStaffName: '', staffIndex: 0, assigning: false, sectionHomeUrl: '', canGoBack: false },
  onLoad(q) { this.setData({ ...createPageNav(q), orderId: q.id }); callFunction('admin', 'listStaffAudits', { auditStatus: 'approved' }).then((staff) => this.setData({ staff, staffProfileId: staff[0]?._id || '', selectedStaffName: staff[0]?.realName || staff[0]?.nickname || '', staffIndex: 0 })).catch(showError) },
  choose(e) { const index = Number(e.detail.value), member = this.data.staff[index]; if (member) this.setData({ staffProfileId: member._id, selectedStaffName: member.realName || member.nickname || '宠托师', staffIndex: index }) },
  assign() {
    if (this.data.assigning || !this.data.orderId || !this.data.staffProfileId) return
    wx.showModal({
      title: '确认派单',
      content: '确认将该订单指派给选中的宠托师？',
      success: (res) => {
        if (!res.confirm || this.data.assigning) return
        this.setData({ assigning: true })
        callFunction('admin', 'assignOrder', { orderId: this.data.orderId, staffProfileId: this.data.staffProfileId })
          .then(() => {
            wx.showToast({ title: '已派单' })
            if (getCurrentPages().length > 1) wx.navigateBack()
            else wx.redirectTo({ url: '/pages/admin/orders/list/index' })
          })
          .catch(showError).finally(() => this.setData({ assigning: false }))
      }
    })
  },
  ...navMethods()
})
