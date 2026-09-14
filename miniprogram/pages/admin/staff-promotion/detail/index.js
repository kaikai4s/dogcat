const { callFunction, showError } = require('../../../../utils/cloud')
const { withOrderText, withCheckinText, formatDateTime } = require('../../../../utils/format')

Page({
  data: { id: '', application: null, profile: null, orders: [], remark: '', showAuditModal: false, auditStatus: '' },
  onLoad(q) { this.setData({ id: q.id || '' }); this.load() },
  load() {
    callFunction('admin', 'getPromotionApplicationDetail', { applicationId: this.data.id })
      .then((res) => {
        const orders = (res.orders || []).map((item, index) => ({
          ...item,
          order: withOrderText(item.order),
          checkins: (item.checkins || []).map(withCheckinText),
          checkinCount: (item.checkins || []).length,
          trackCount: (item.tracks || []).length,
          reviewText: item.review ? `${item.review.rating || 0}分 ${item.review.content || ''}` : '暂无评价',
          expanded: index === 0
        }))
        this.setData({ application: { ...res.application, createdAtText: formatDateTime(res.application.createdAt) }, profile: res.profile, orders })
      })
      .catch(showError)
  },
  noop() {},
  inputRemark(e) { this.setData({ remark: e.detail.value }) },
  toggleOrder(e) {
    const index = Number(e.currentTarget.dataset.index)
    const item = this.data.orders[index]
    if (!item) return
    this.setData({ [`orders[${index}].expanded`]: !item.expanded })
  },
  openAuditModal(e) {
    this.setData({ auditStatus: e.currentTarget.dataset.status, showAuditModal: true })
  },
  closeAuditModal() {
    this.setData({ showAuditModal: false, auditStatus: '', remark: '' })
  },
  audit() {
    const status = this.data.auditStatus
    if (!status) return
    callFunction('admin', 'auditPromotionApplication', { applicationId: this.data.id, status, remark: this.data.remark })
      .then(() => { wx.showToast({ title: '已处理', icon: 'none' }); wx.navigateBack() })
      .catch(showError)
  }
})
