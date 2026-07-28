const { callFunction, showError } = require('../../../../utils/cloud')
Page({
  data: { id: '', staff: null, remark: '' },
  onLoad(q) { this.setData({ id: q.id }); callFunction('admin', 'listStaffAudits').then((list) => this.setData({ staff: list.find((item) => item._id === q.id) })).catch(showError) },
  input(e) { this.setData({ remark: e.detail.value }) },
  audit(e) { callFunction('admin', 'auditStaff', { staffProfileId: this.data.id, auditStatus: e.currentTarget.dataset.status, auditRemark: this.data.remark }).then(() => { wx.showToast({ title: '已处理' }); wx.navigateBack() }).catch(showError) }
})
