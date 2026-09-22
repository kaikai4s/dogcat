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
    submittingRefund: false,
    showUrgentModal: false,
    urgentStaffRewardInput: '',
    urgentStartTimeInput: '',
    urgentEndTimeInput: '',
    urgentRemarkInput: '',
    submittingUrgent: false,
    showEvidenceModal: false,
    evidenceStaffList: [],
    selectedStaffIndex: 0,
    evidenceReasonTypes: [
      { key: 'start_overdue', label: '接单超时未开始/爽约' },
      { key: 'checkin_missing', label: '超期未完成打卡' },
      { key: 'service_violation', label: '服务质量违规/客诉' },
      { key: 'private_order', label: '引导私下交易/私单' },
      { key: 'pet_safety', label: '宠物安全与失职问题' },
      { key: 'other', label: '其他服务违规' }
    ],
    selectedReasonTypeIndex: 0,
    evidenceDeductAmountInput: '50',
    evidenceReasonTextInput: '',
    evidenceImages: [],
    submittingEvidence: false
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
        const notifyMap = { sent: '已发送', success: '发送成功', failed: '发送失败', skipped: '无需发送' }
        order.acceptedNotifyStatusText = notifyMap[order.acceptedNotifyStatus] || (order.acceptedNotifyStatus ? '已处理' : '未记录')
        order.acceptedNotifyErrorText = order.acceptedNotifyError || '无'
        const refundStatusMap = { success: '退款成功', processing: '处理中', failed: '退款失败', pending: '申请中' }
        const mappedRefunds = (refunds || []).map((r) => ({
          ...r,
          statusText: refundStatusMap[r.status] || '处理中'
        }))
        this.setData({ detail: { ...detail, order }, refunds: mappedRefunds })
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

  openUrgentModal() {
    const order = this.data.detail && this.data.detail.order
    if (!order) return
    const defaultReward = order.urgentStaffReward || Math.round(Number(order.payAmount || 60) * 0.7 * 100) / 100
    this.setData({
      showUrgentModal: true,
      urgentStaffRewardInput: String(defaultReward),
      urgentStartTimeInput: order.startTime || '',
      urgentEndTimeInput: order.endTime || '',
      urgentRemarkInput: order.urgentRemark || ''
    })
  },

  closeUrgentModal() {
    this.setData({ showUrgentModal: false, submittingUrgent: false })
  },

  inputUrgentReward(e) {
    this.setData({ urgentStaffRewardInput: e.detail.value })
  },

  inputUrgentStartTime(e) {
    this.setData({ urgentStartTimeInput: e.detail.value })
  },

  inputUrgentEndTime(e) {
    this.setData({ urgentEndTimeInput: e.detail.value })
  },

  inputUrgentRemark(e) {
    this.setData({ urgentRemarkInput: e.detail.value })
  },

  submitUrgentRepublish() {
    const order = this.data.detail && this.data.detail.order
    if (!order) return
    const staffReward = Number(this.data.urgentStaffRewardInput)
    if (!Number.isFinite(staffReward) || staffReward <= 0) {
      wx.showToast({ title: '请输入有效的宠托师收益金额', icon: 'none' })
      return
    }

    const startTime = String(this.data.urgentStartTimeInput || '').trim()
    const endTime = String(this.data.urgentEndTimeInput || '').trim()
    const urgentRemark = String(this.data.urgentRemarkInput || '').trim()

    wx.showModal({
      title: '确认转为加急公共抢单',
      content: `宠托师可获收益：¥${staffReward.toFixed(2)}\n用户支付金额：¥${Number(order.payAmount || 0).toFixed(2)}（保持不变，无需用户补付）\n确定重新发布到加急公共单吗？`,
      confirmColor: '#ea580c',
      success: (res) => {
        if (!res.confirm) return
        this.setData({ submittingUrgent: true })
        callFunction('admin', 'republishOrderAsUrgent', {
          id: this.data.id,
          staffReward,
          startTime,
          endTime,
          urgentRemark
        })
          .then(() => {
            wx.showToast({ title: '已转为加急公共单' })
            this.closeUrgentModal()
            this.load()
          })
          .catch(showError)
          .finally(() => this.setData({ submittingUrgent: false }))
      }
    })
  },

  callOriginalStaff() {
    const phone = this.data.detail && this.data.detail.order && this.data.detail.order.originalStaffContact && this.data.detail.order.originalStaffContact.phone
    if (!phone) {
      wx.showToast({ title: '原宠托师电话未绑定', icon: 'none' })
      return
    }
    wx.makePhoneCall({ phoneNumber: phone })
  },

  openEvidenceModal() {
    const order = this.data.detail && this.data.detail.order
    if (!order) return
    const staffList = []
    if (order.originalStaffOpenid) {
      staffList.push({
        openid: order.originalStaffOpenid,
        label: `${order.originalStaffName || '原宠托师'}（原接单人·违规转单）`
      })
    }
    if (order.staffOpenid && order.staffOpenid !== order.originalStaffOpenid) {
      staffList.push({
        openid: order.staffOpenid,
        label: `${(order.staffContact && order.staffContact.displayName) || order.staffName || '当前宠托师'}（当前接单人）`
      })
    }
    if (Array.isArray(order.previousStaffRecords)) {
      order.previousStaffRecords.forEach((r) => {
        if (!staffList.some((s) => s.openid === r.staffOpenid)) {
          staffList.push({
            openid: r.staffOpenid,
            label: `${r.staffName || '历史宠托师'}（曾指派）`
          })
        }
      })
    }
    if (!staffList.length) {
      wx.showToast({ title: '该订单暂未关联宠托师', icon: 'none' })
      return
    }

    const defaultReason = order.isStartOverdue
      ? '订单超出预约时间30分钟以上未按时到岗开始服务，严重超时违规'
      : (order.isFinishOverdue ? '订单超出预计结束时间60分钟以上且未完成必要打卡' : (order.urgentRemark ? `加急调度违约留证：${order.urgentRemark}` : ''))

    this.setData({
      showEvidenceModal: true,
      evidenceStaffList: staffList,
      selectedStaffIndex: 0,
      selectedReasonTypeIndex: order.isStartOverdue ? 0 : (order.isFinishOverdue ? 1 : 0),
      evidenceDeductAmountInput: '50',
      evidenceReasonTextInput: defaultReason,
      evidenceImages: []
    })
  },

  closeEvidenceModal() {
    this.setData({ showEvidenceModal: false, submittingEvidence: false })
  },

  onEvidenceStaffChange(e) {
    this.setData({ selectedStaffIndex: Number(e.detail.value || 0) })
  },

  onEvidenceReasonTypeChange(e) {
    this.setData({ selectedReasonTypeIndex: Number(e.detail.value || 0) })
  },

  inputEvidenceDeductAmount(e) {
    this.setData({ evidenceDeductAmountInput: e.detail.value })
  },

  inputEvidenceReasonText(e) {
    this.setData({ evidenceReasonTextInput: e.detail.value })
  },

  chooseEvidenceImages() {
    const remain = 4 - (this.data.evidenceImages || []).length
    if (remain <= 0) return
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const files = (res.tempFiles || []).map((f) => f.tempFilePath)
        this.setData({ evidenceImages: [...(this.data.evidenceImages || []), ...files] })
      }
    })
  },

  removeEvidenceImage(e) {
    const index = Number(e.currentTarget.dataset.index)
    const list = [...(this.data.evidenceImages || [])]
    list.splice(index, 1)
    this.setData({ evidenceImages: list })
  },

  previewEvidenceImage(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.previewImage({ urls: [url] })
  },

  submitDepositEvidence() {
    const order = this.data.detail && this.data.detail.order
    if (!order) return
    const targetStaff = this.data.evidenceStaffList[this.data.selectedStaffIndex]
    if (!targetStaff || !targetStaff.openid) {
      wx.showToast({ title: '请选择责任宠托师', icon: 'none' })
      return
    }
    const reasonTypeObj = this.data.evidenceReasonTypes[this.data.selectedReasonTypeIndex] || this.data.evidenceReasonTypes[0]
    const reasonText = String(this.data.evidenceReasonTextInput || '').trim()
    if (!reasonText) {
      wx.showToast({ title: '请填写违规留证说明', icon: 'none' })
      return
    }
    const deductAmount = Math.max(0, Number(this.data.evidenceDeductAmountInput || 0))

    wx.showModal({
      title: '确认录入保证金违规证据',
      content: `责任宠托师：${targetStaff.label}\n违规类型：${reasonTypeObj.label}\n建议扣除保证金：¥${deductAmount.toFixed(2)}\n确定保存留证并在宠托师管理界面同步展示吗？`,
      confirmColor: '#ef4444',
      success: (res) => {
        if (!res.confirm) return
        this.setData({ submittingEvidence: true })
        callFunction('admin', 'addOrderDepositPenaltyEvidence', {
          orderId: this.data.id,
          staffOpenid: targetStaff.openid,
          reasonType: reasonTypeObj.key,
          reasonText,
          deductAmount,
          evidenceImages: this.data.evidenceImages
        })
          .then(() => {
            wx.showToast({ title: '已录入违规留证' })
            this.closeEvidenceModal()
            this.load()
          })
          .catch(showError)
          .finally(() => this.setData({ submittingEvidence: false }))
      }
    })
  },

  ...navMethods()
})
