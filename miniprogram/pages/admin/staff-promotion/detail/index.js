const { callFunction, showError } = require('../../../../utils/cloud')
const { withOrderText, withCheckinText, formatDateTime } = require('../../../../utils/format')

Page({
  data: { id: '', application: null, profile: null, orders: [], remark: '' },
  onLoad(q) { this.setData({ id: q.id || '' }); this.load() },
  load() {
    callFunction('admin', 'getPromotionApplicationDetail', { applicationId: this.data.id })
      .then((res) => {
        const orders = (res.orders || []).map((item) => ({
          ...item,
          order: withOrderText(item.order),
          checkins: (item.checkins || []).map(withCheckinText),
          checkinCount: (item.checkins || []).length,
          trackCount: (item.tracks || []).length,
          reviewText: item.review ? `${item.review.rating || 0}分 ${item.review.content || ''}` : '暂无评价'
        }))
        this.setData({ application: { ...res.application, createdAtText: formatDateTime(res.application.createdAt) }, profile: res.profile, orders })
      })
      .catch(showError)
  },
  inputRemark(e) { this.setData({ remark: e.detail.value }) },
  audit(e) {
    const status = e.currentTarget.dataset.status
    wx.showModal({
      title: status === 'approved' ? '通过晋升申请' : '拒绝晋升申请',
      content: status === 'approved' ? '通过后该宠托师将成为认证宠托师。' : '确认拒绝本次晋升申请？',
      success: (res) => {
        if (!res.confirm) return
        callFunction('admin', 'auditPromotionApplication', { applicationId: this.data.id, status, remark: this.data.remark })
          .then(() => { wx.showToast({ title: '已处理', icon: 'none' }); wx.navigateBack() })
          .catch(showError)
      }
    })
  }
})
