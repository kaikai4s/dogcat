const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { withAuditText } = require('../../../../utils/format')

Page({
  data: { id: '', staff: null, remark: '', sectionHomeUrl: '', canGoBack: false },
  onLoad(q) { this.setData({ ...createPageNav(q), id: q.id }); callFunction('admin', 'listStaffAudits').then((list) => this.setData({ staff: withAuditText(list.find((item) => item._id === q.id)) })).catch(showError) },
  input(e) { this.setData({ remark: e.detail.value }) },
  preview(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.previewImage({ urls: [url] })
  },
  audit(e) { callFunction('admin', 'auditStaff', { staffProfileId: this.data.id, auditStatus: e.currentTarget.dataset.status, auditRemark: this.data.remark }).then(() => { wx.showToast({ title: '已处理' }); wx.navigateBack() }).catch(showError) },
  ...navMethods()
})
