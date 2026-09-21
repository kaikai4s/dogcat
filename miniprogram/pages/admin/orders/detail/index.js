const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { withOrderText } = require('../../../../utils/format')
const { copyText } = require('../../../../utils/clipboard')

const SERVICE_ORDER_STATUS_OPTIONS = [
  { value: 'pending_pay', label: '待支付' },
  { value: 'paid', label: '待接单（已支付）' },
  { value: 'assigned', label: '待服务（已派单/接单）' },
  { value: 'in_service', label: '服务中' },
  { value: 'completed', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
  { value: 'refunded', label: '已退款' }
]

Page({
  data: {
    id: '',
    detail: null,
    paymentStatus: null,
    refunds: [],
    sectionHomeUrl: '',
    canGoBack: false,
    showStatusModal: false,
    statusOptions: SERVICE_ORDER_STATUS_OPTIONS,
    selectedStatusIndex: 0,
    statusRemark: '',
    submittingStatus: false,
    showRefundModal: false,
    refundAmountInput: '',
    refundReasonInput: '',
    submittingRefund: false
  },

  onLoad(q) {
    this.setData({ ...createPageNav(q), id: q.id })
    this.load()
  },

  load() {
    Promise.all([
      callFunction('admin', 'getOrderDetail', { id: this.data.id }),
      callFunction('payment', 'listRefunds', { orderId: this.data.id })
    ])
      .then(([detail, refunds]) => {
        const order = withOrderText(detail.order)
        order.acceptedNotifyStatusText = order.acceptedNotifyStatus || '未记录'
        order.acceptedNotifyErrorText = order.acceptedNotifyError || '无'
        this.setData({ detail: { ...detail, order }, refunds: refunds || [] })
      })
      .catch(showError)
  },

  callClient() {
    const phone = this.data.detail && this.data.detail.order && this.data.detail.order.clientContact && this.data.detail.order.clientContact.phone
    if (!phone) {
      wx.showToast({ title: '用户电话未绑定', icon: 'none' })
      return
    }
    wx.makePhoneCall({ phoneNumber: phone })
  },

  callStaff() {
    const phone = this.data.detail && this.data.detail.order && this.data.detail.order.staffContact && this.data.detail.order.staffContact.phone
    if (!phone) {
      wx.showToast({ title: '宠托师电话未绑定', icon: 'none' })
      return
    }
    wx.makePhoneCall({ phoneNumber: phone })
  },

  copyOrderNo() {
    const orderNo = this.data.detail && this.data.detail.order && this.data.detail.order.orderNo
    copyText(orderNo, { successTitle: '订单号已复制', emptyTitle: '暂无订单号' })
  },

  evidence() {
    wx.navigateTo({ url: '/pages/admin/evidence/detail/index?id=' + this.data.id })
  },

  incidents() {
    wx.navigateTo({ url: '/pages/admin/incidents/list/index?orderId=' + this.data.id })
  },

  // 修改状态弹窗
  openStatusModal() {
    const currentStatus = this.data.detail && this.data.detail.order && this.data.detail.order.status
    let idx = this.data.statusOptions.findIndex((opt) => opt.value === currentStatus)
    if (idx < 0) idx = 0
    this.setData({
      showStatusModal: true,
      selectedStatusIndex: idx,
      statusRemark: ''
    })
  },

  closeStatusModal() {
    this.setData({ showStatusModal: false, statusRemark: '' })
  },

  onStatusPickerChange(e) {
    this.setData({ selectedStatusIndex: Number(e.detail.value || 0) })
  },

  inputStatusRemark(e) {
    this.setData({ statusRemark: e.detail.value })
  },

  submitUpdateStatus() {
    const target = this.data.statusOptions[this.data.selectedStatusIndex]
    if (!target) return
    const currentStatus = this.data.detail && this.data.detail.order && this.data.detail.order.status
    if (target.value === currentStatus) {
      wx.showToast({ title: '所选状态与当前一致', icon: 'none' })
      return
    }
    const remark = String(this.data.statusRemark || '').trim()
    if (!remark) {
      wx.showToast({ title: '请填写操作说明', icon: 'none' })
      return
    }

    this.setData({ submittingStatus: true })
    callFunction('admin', 'updateOrderStatus', {
      orderId: this.data.id,
      status: target.value,
      remark
    })
      .then(() => {
        wx.showToast({ title: '状态已修改' })
        this.closeStatusModal()
        this.load()
      })
      .catch(showError)
      .finally(() => this.setData({ submittingStatus: false }))
  },

  // 手动退款弹窗
  openRefundModal() {
    const order = this.data.detail && this.data.detail.order
    const maxRefundable = order ? order.maxRefundable || 0 : 0
    if (maxRefundable <= 0) {
      wx.showToast({ title: '该订单已无剩余可退金额', icon: 'none' })
      return
    }
    this.setData({
      showRefundModal: true,
      refundAmountInput: String(maxRefundable),
      refundReasonInput: ''
    })
  },

  closeRefundModal() {
    this.setData({ showRefundModal: false, refundAmountInput: '', refundReasonInput: '' })
  },

  inputRefundAmount(e) {
    this.setData({ refundAmountInput: e.detail.value })
  },

  inputRefundReason(e) {
    this.setData({ refundReasonInput: e.detail.value })
  },

  setFullRefund() {
    const order = this.data.detail && this.data.detail.order
    const maxRefundable = order ? order.maxRefundable || 0 : 0
    this.setData({ refundAmountInput: String(maxRefundable) })
  },

  submitRefund() {
    const order = this.data.detail && this.data.detail.order
    const maxRefundable = order ? order.maxRefundable || 0 : 0
    const refundAmount = Number(this.data.refundAmountInput)
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
      wx.showToast({ title: '请输入有效退款金额', icon: 'none' })
      return
    }
    if (refundAmount > maxRefundable) {
      wx.showToast({ title: `不能超过最大可退 ¥${maxRefundable}`, icon: 'none' })
      return
    }
    const reason = String(this.data.refundReasonInput || '').trim()
    if (!reason) {
      wx.showToast({ title: '请填写退款说明', icon: 'none' })
      return
    }

    wx.showModal({
      title: '确认手动退款',
      content: `确定为该订单退款 ¥${refundAmount.toFixed(2)} 吗？款项将原路退回用户。`,
      confirmColor: '#ea580c',
      success: (res) => {
        if (!res.confirm) return
        this.setData({ submittingRefund: true })
        callFunction('admin', 'refundOrder', {
          orderId: this.data.id,
          refundAmount,
          reason
        })
          .then(() => {
            wx.showToast({ title: '退款已提交' })
            this.closeRefundModal()
            this.load()
          })
          .catch(showError)
          .finally(() => this.setData({ submittingRefund: false }))
      }
    })
  },

  ...navMethods()
})
