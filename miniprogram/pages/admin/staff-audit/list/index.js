const { callFunction, showError } = require('../../../../utils/cloud')
Page({
  data: { staff: [] },
  onShow() { callFunction('admin', 'listStaffAudits').then((staff) => this.setData({ staff })).catch(showError) },
  detail(e) { wx.navigateTo({ url: '/pages/admin/staff-audit/detail/index?id=' + e.currentTarget.dataset.id }) }
})
