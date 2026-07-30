const { callFunction, showError } = require('../../../../utils/cloud')
const { withAuditText } = require('../../../../utils/format')
Page({
  data: { staff: [] },
  onShow() { callFunction('admin', 'listStaffAudits').then((staff) => this.setData({ staff: staff.map(withAuditText) })).catch(showError) },
  detail(e) { wx.navigateTo({ url: '/pages/admin/staff-audit/detail/index?id=' + e.currentTarget.dataset.id }) },
  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  }
})
