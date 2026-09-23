const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { withAuditText } = require('../../../../utils/format')

Page({
  data: { id: '', staff: null, remark: '', gender: '', genderReason: '', savingGender: false, sectionHomeUrl: '', canGoBack: false },
  onLoad(q) {
    this.setData({ ...createPageNav(q), id: q.id })
    callFunction('admin', 'listStaffAudits', { staffProfileId: q.id })
      .then((list) => {
        const found = list.find((item) => item._id === q.id)
        if (found) {
          const staff = withAuditText(found)
          this.setData({ staff, gender: staff.gender || '', remark: staff.auditRemark || '' })
        }
      })
      .catch(showError)
  },
  input(e) { this.setData({ remark: e.detail.value }) },
  chooseGender(e) { this.setData({ gender: e.detail.value }) },
  inputGenderReason(e) { this.setData({ genderReason: e.detail.value }) },
  completeGender() {
    if (this.data.savingGender) return
    if (!['male', 'female'].includes(this.data.gender) || !this.data.genderReason.trim()) {
      wx.showToast({ title: '请选择性别并填写核实说明', icon: 'none' })
      return
    }
    this.setData({ savingGender: true })
    callFunction('admin', 'completeStaffGender', { staffProfileId: this.data.id, gender: this.data.gender, reason: this.data.genderReason })
      .then((res) => {
        this.setData({ 'staff.gender': res.gender })
        wx.showToast({ title: '性别已核实补录' })
      })
      .catch(showError)
      .finally(() => this.setData({ savingGender: false }))
  },
  preview(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.previewImage({ urls: [url] })
  },
  audit(e) { callFunction('admin', 'auditStaff', { staffProfileId: this.data.id, auditStatus: e.currentTarget.dataset.status, auditRemark: this.data.remark }).then(() => { wx.showToast({ title: '已处理' }); wx.navigateBack() }).catch(showError) },
  ...navMethods()
})
