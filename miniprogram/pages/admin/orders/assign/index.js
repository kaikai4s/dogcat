const { callFunction, showError } = require('../../../../utils/cloud')
Page({
  data: { orderId: '', staff: [], staffProfileId: '' },
  onLoad(q) { this.setData({ orderId: q.id }); callFunction('admin', 'listStaffAudits', { auditStatus: 'approved' }).then((staff) => this.setData({ staff, staffProfileId: staff[0]?._id || '' })).catch(showError) },
  choose(e) { this.setData({ staffProfileId: this.data.staff[e.detail.value]._id }) },
  assign() { callFunction('admin', 'assignOrder', { orderId: this.data.orderId, staffProfileId: this.data.staffProfileId }).then(() => { wx.showToast({ title: '已派单' }); wx.navigateBack() }).catch(showError) }
})
