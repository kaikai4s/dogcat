const { callFunction, showError } = require('../../../../utils/cloud')
const { formatDateTime, formatPromotionStatus } = require('../../../../utils/format')
const { buildPromotionOrder } = require('../../../../utils/promotionReview')
const { copyText } = require('../../../../utils/clipboard')
const { can } = require('../../../../utils/adminAccess')

Page({
  data: { id: '', application: null, profile: null, orders: [], remark: '', showAuditModal: false, auditStatus: '', loading: false, loadError: false, submitting: false, allExpanded: false },
  onLoad(q) { this.setData({ id: q.id || '' }); this.load() },
  load() {
    this.setData({ loading: true, loadError: false })
    return callFunction('admin', 'getPromotionApplicationDetail', { applicationId: this.data.id })
      .then((res) => {
        const orders = (res.orders || []).map(buildPromotionOrder)
        this.setData({
          application: { ...res.application, statusText: formatPromotionStatus(res.application.status), createdAtText: formatDateTime(res.application.createdAt) },
          profile: res.profile, orders, allExpanded: orders.length === 1,
          totalPhotos: orders.reduce((sum, o) => sum + o.photoCount, 0),
          totalCheckins: orders.reduce((sum, o) => sum + o.checkinCount, 0),
          warningOrders: orders.filter(o => o.warnings.length).length
        })
      })
      .catch(error => { this.setData({ loadError: true }); showError(error) })
      .finally(() => this.setData({ loading: false }))
  },
  noop() {},
  inputRemark(e) { this.setData({ remark: e.detail.value }) },
  toggleOrder(e) {
    const index = Number(e.currentTarget.dataset.index)
    const item = this.data.orders[index]
    if (!item) return
    const orders = this.data.orders.map((o, i) => i === index ? { ...o, expanded: !o.expanded } : o)
    this.setData({ orders, allExpanded: orders.every(o => o.expanded) })
  },
  toggleAllOrders() {
    const expanded = !this.data.allExpanded
    this.setData({ orders: this.data.orders.map(o => ({ ...o, expanded })), allExpanded: expanded })
  },
  toggleDetails(e) {
    const index = Number(e.currentTarget.dataset.index), item = this.data.orders[index]
    if (item) this.setData({ [`orders[${index}].detailsExpanded`]: !item.detailsExpanded })
  },
  previewPhoto(e) {
    const { index, checkin, original } = e.currentTarget.dataset
    const item = this.data.orders[Number(index)]
    const record = item && item.checkins[Number(checkin)]
    if (!record || !record.photoUrl) return
    wx.previewImage({ current: original ? record.originalUrl : record.photoUrl, urls: original ? item.originalUrls : item.photoUrls, fail: () => wx.showToast({ title: '照片暂时无法预览，请重试', icon: 'none' }) })
  },
  photoError(e) {
    const { index, checkin } = e.currentTarget.dataset
    if (!this.data.orders[Number(index)]?.checkins[Number(checkin)]) return
    this.setData({ [`orders[${Number(index)}].checkins[${Number(checkin)}].photoFailed`]: true })
  },
  retryPhoto(e) {
    const { index, checkin } = e.currentTarget.dataset
    if (!this.data.orders[Number(index)]?.checkins[Number(checkin)]) return
    this.setData({ [`orders[${Number(index)}].checkins[${Number(checkin)}].photoFailed`]: false })
  },
  openLocation(e) {
    const { index, checkin, track } = e.currentTarget.dataset
    const item = this.data.orders[Number(index)]
    const record = item && (track !== undefined ? item.tracks[Number(track)] : item.checkins[Number(checkin)])
    if (!record || !record.canOpenLocation) return
    wx.openLocation({ latitude: record.latitude, longitude: record.longitude, name: record.eventTypeText || '服务轨迹点', scale: 16, fail: () => wx.showToast({ title: '地图打开失败，请重试', icon: 'none' }) })
  },
  toggleTracks(e) {
    const index = Number(e.currentTarget.dataset.index), item = this.data.orders[index]
    if (item) this.setData({ [`orders[${index}].tracksExpanded`]: !item.tracksExpanded })
  },
  moreTracks(e) {
    const index = Number(e.currentTarget.dataset.index), item = this.data.orders[index]
    if (!item) return
    const count = Math.min(item.trackVisibleCount + 20, item.tracks.length)
    this.setData({ [`orders[${index}].trackPreview`]: item.tracks.slice(0, count), [`orders[${index}].trackVisibleCount`]: count })
  },
  openOrder(e) {
    const item = this.data.orders[Number(e.currentTarget.dataset.index)]
    if (!item || item.unavailable || !can(this.data.adminAccess, 'admin.getOrderDetail')) return
    wx.navigateTo({ url: '/pages/admin/orders/detail/index?id=' + encodeURIComponent(item.orderId), fail: showError })
  },
  copyOrderNo(e) {
    const item = this.data.orders[Number(e.currentTarget.dataset.index)]
    if (item) copyText(item.order.orderNo || item.orderId, { successTitle: '订单号已复制' })
  },
  openAuditModal(e) {
    if (this.data.application?.status !== 'pending' || this.data.submitting) return
    this.setData({ auditStatus: e.currentTarget.dataset.status, showAuditModal: true })
  },
  closeAuditModal() {
    if (this.data.submitting) return
    this.setData({ showAuditModal: false, auditStatus: '', remark: '' })
  },
  audit() {
    const status = this.data.auditStatus
    if (!status || this.data.submitting) return
    this.setData({ submitting: true })
    return callFunction('admin', 'auditPromotionApplication', { applicationId: this.data.id, status, remark: this.data.remark })
      .then(() => { wx.showToast({ title: '已处理', icon: 'none' }); wx.navigateBack() })
      .catch(showError)
      .finally(() => this.setData({ submitting: false }))
  }
})
