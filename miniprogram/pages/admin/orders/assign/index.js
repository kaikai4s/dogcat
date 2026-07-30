const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')

Page({
  data: { orderId: '', staff: [], staffProfileId: '', sectionHomeUrl: '', canGoBack: false },
  onLoad(q) { this.setData({ ...createPageNav(q), orderId: q.id }); callFunction('admin', 'listStaffAudits', { auditStatus: 'approved' }).then((staff) => this.setData({ staff, staffProfileId: staff[0]?._id || '' })).catch(showError) },
  choose(e) { this.setData({ staffProfileId: this.data.staff[e.detail.value]._id }) },
  assign() { callFunction('admin', 'assignOrder', { orderId: this.data.orderId, staffProfileId: this.data.staffProfileId }).then(() => { wx.showToast({ title: '已派单' }); wx.navigateBack() }).catch(showError) },
  ...navMethods()
})
