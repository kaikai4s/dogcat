const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { withOrderText } = require('../../../../utils/format')
const { copyText } = require('../../../../utils/clipboard')

const SERVICE_ORDER_STATUS_OPTIONS = [
  { value: 'pending_pay', label: '待支付' },
  { value: 'paid', label: '待接单（已支付）' },
  { value: 'assigned', label: '待服务（已派单/接单）' },
  { value: 'on_the_way', label: '前往服务地点中' },
  { value: 'in_service', label: '服务中' },
  { value: 'completed', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
  { value: 'refunded', label: '已退款' }
]

function parseBeijingDate(value) {
  if (!value) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  const text = String(value).trim()
  if (/^\d{10,13}$/.test(text)) {
    const num = Number(text)
    return new Date(text.length === 10 ? num * 1000 : num)
  }
  const localMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/)
  if (localMatch) {
    const [, year, month, day, hour = '0', minute = '0', second = '0'] = localMatch
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 8, Number(minute), Number(second)))
  }
  const time = new Date(text).getTime()
  return Number.isFinite(time) ? new Date(time) : null
}

function formatFullBeijingDateTime(date) {
  if (!date || Number.isNaN(date.getTime())) return ''
  const beijing = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const y = beijing.getUTCFullYear()
  const m = String(beijing.getUTCMonth() + 1).padStart(2, '0')
  const d = String(beijing.getUTCDate()).padStart(2, '0')
  const h = String(beijing.getUTCHours()).padStart(2, '0')
  const min = String(beijing.getUTCMinutes()).padStart(2, '0')
  return `${y}-${m}-${d} ${h}:${min}`
}

function computeInitialUrgentTime(order, durationMinutes = 60) {
  const now = new Date()
  const cstDate = new Date(now.getTime() + 8 * 3600 * 1000)
  const minutes = cstDate.getUTCMinutes()
  // 向上对齐到下一个整点或半点，并预留至少30分钟
  const deltaMinutes = (30 - (minutes % 30)) + 30
  const startObj = new Date(now.getTime() + deltaMinutes * 60 * 1000)
  const endObj = new Date(startObj.getTime() + durationMinutes * 60 * 1000)

  // 如果原订单开始时间有效且在当前时间30分钟之后，可优先使用原时间，否则使用计算出的合规加急时间
  if (order && order.startTime) {
    const origStart = parseBeijingDate(order.startTime)
    if (origStart && origStart.getTime() >= now.getTime() + 30 * 60 * 1000) {
      return {
        startTime: order.startTime,
        endTime: order.endTime || formatFullBeijingDateTime(new Date(origStart.getTime() + durationMinutes * 60 * 1000))
      }
    }
  }

  return {
    startTime: formatFullBeijingDateTime(startObj),
    endTime: formatFullBeijingDateTime(endObj)
  }
}

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
    urgentStartDate: '',
    urgentStartTimeClock: '',
    urgentEndDate: '',
    urgentEndTimeClock: '',
    minUrgentDate: '',
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
    submittingEvidence: false,
    showManualCompleteModal: false,
    standardStaffReward: 0,
    manualDeductAmountInput: '0',
    computedFinalReward: '0.00',
    manualCompleteRemarkInput: '',
    manualCompleteImages: [],
    submittingManualComplete: false,
    sessionMessages: [],
    riskBypassLogs: [],
    showChatModal: false
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
        const standardStaffReward = Number(order.standardStaffReward || 0)
        this.setData({
          detail: { ...detail, order },
          refunds: mappedRefunds,
          sessionMessages: detail.sessionMessages || [],
          riskBypassLogs: detail.riskBypassLogs || [],
          standardStaffReward,
          computedFinalReward: standardStaffReward.toFixed(2)
        })
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
    if (!['paid', 'assigned', 'on_the_way', 'day_completed'].includes(order.status)) {
      wx.showToast({ title: '订单已开始服务或已结束，无法转加急单', icon: 'none' })
      return
    }
    const defaultReward = order.urgentStaffReward || Math.round(Number(order.payAmount || 60) * 0.7 * 100) / 100
    const durationMinutes = Number(order.durationMinutes || 60) || 60
    const initialTimes = computeInitialUrgentTime(order, durationMinutes)

    const [startDate = '', startTimeClock = ''] = (initialTimes.startTime || '').split(' ')
    const [endDate = '', endTimeClock = ''] = (initialTimes.endTime || '').split(' ')

    const now = new Date()
    const beijing = new Date(now.getTime() + 8 * 3600 * 1000)
    const y = beijing.getUTCFullYear()
    const m = String(beijing.getUTCMonth() + 1).padStart(2, '0')
    const d = String(beijing.getUTCDate()).padStart(2, '0')
    const todayStr = `${y}-${m}-${d}`

    this.setData({
      showUrgentModal: true,
      urgentStaffRewardInput: String(defaultReward),
      urgentStartTimeInput: initialTimes.startTime,
      urgentEndTimeInput: initialTimes.endTime,
      urgentStartDate: startDate,
      urgentStartTimeClock: startTimeClock,
      urgentEndDate: endDate,
      urgentEndTimeClock: endTimeClock,
      minUrgentDate: todayStr,
      urgentRemarkInput: order.urgentRemark || ''
    })
  },

  closeUrgentModal() {
    this.setData({ showUrgentModal: false, submittingUrgent: false })
  },

  inputUrgentReward(e) {
    this.setData({ urgentStaffRewardInput: e.detail.value })
  },

  onUrgentStartDateChange(e) {
    const dateVal = e.detail.value
    const timeVal = this.data.urgentStartTimeClock || '12:00'
    const newStart = `${dateVal} ${timeVal}`
    this.setData({
      urgentStartDate: dateVal,
      urgentStartTimeClock: timeVal,
      urgentStartTimeInput: newStart
    })
    this.syncUrgentEndTime(newStart)
  },

  onUrgentStartTimeClockChange(e) {
    const dateVal = this.data.urgentStartDate || this.data.minUrgentDate
    const timeVal = e.detail.value
    const newStart = `${dateVal} ${timeVal}`
    this.setData({
      urgentStartDate: dateVal,
      urgentStartTimeClock: timeVal,
      urgentStartTimeInput: newStart
    })
    this.syncUrgentEndTime(newStart)
  },

  onUrgentEndDateChange(e) {
    const dateVal = e.detail.value
    const timeVal = this.data.urgentEndTimeClock || '13:00'
    this.setData({
      urgentEndDate: dateVal,
      urgentEndTimeClock: timeVal,
      urgentEndTimeInput: `${dateVal} ${timeVal}`
    })
  },

  onUrgentEndTimeClockChange(e) {
    const dateVal = this.data.urgentEndDate || this.data.urgentStartDate || this.data.minUrgentDate
    const timeVal = e.detail.value
    this.setData({
      urgentEndDate: dateVal,
      urgentEndTimeClock: timeVal,
      urgentEndTimeInput: `${dateVal} ${timeVal}`
    })
  },

  syncUrgentEndTime(startTimeStr) {
    const parsed = parseBeijingDate(startTimeStr)
    if (!parsed) return
    const order = this.data.detail && this.data.detail.order
    const durationMinutes = Number((order && order.durationMinutes) || 60) || 60
    const endObj = new Date(parsed.getTime() + durationMinutes * 60 * 1000)
    const endFull = formatFullBeijingDateTime(endObj)
    const [endDate = '', endTimeClock = ''] = endFull.split(' ')
    this.setData({
      urgentEndTimeInput: endFull,
      urgentEndDate: endDate,
      urgentEndTimeClock: endTimeClock
    })
  },

  quickSetUrgentTime(e) {
    const type = e.currentTarget.dataset.type
    const now = new Date()
    const order = this.data.detail && this.data.detail.order
    const durationMinutes = Number((order && order.durationMinutes) || 60) || 60
    let startObj

    if (type === '30m') {
      startObj = new Date(now.getTime() + 30 * 60 * 1000)
    } else if (type === '1h') {
      startObj = new Date(now.getTime() + 60 * 60 * 1000)
    } else if (type === '2h') {
      startObj = new Date(now.getTime() + 120 * 60 * 1000)
    } else if (type === 'tomorrow_9') {
      const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000 + 8 * 3600 * 1000)
      const y = tomorrow.getUTCFullYear()
      const m = tomorrow.getUTCMonth()
      const d = tomorrow.getUTCDate()
      startObj = new Date(Date.UTC(y, m, d, 9 - 8, 0, 0))
    }
    if (!startObj) return
    const endObj = new Date(startObj.getTime() + durationMinutes * 60 * 1000)
    const startFull = formatFullBeijingDateTime(startObj)
    const endFull = formatFullBeijingDateTime(endObj)
    const [startDate = '', startTimeClock = ''] = startFull.split(' ')
    const [endDate = '', endTimeClock = ''] = endFull.split(' ')

    this.setData({
      urgentStartTimeInput: startFull,
      urgentEndTimeInput: endFull,
      urgentStartDate: startDate,
      urgentStartTimeClock: startTimeClock,
      urgentEndDate: endDate,
      urgentEndTimeClock: endTimeClock
    })
  },

  inputUrgentStartTime(e) {
    const val = String(e.detail.value || '').trim()
    this.setData({ urgentStartTimeInput: val })
    const parsed = parseBeijingDate(val)
    if (parsed) {
      const [startDate = '', startTimeClock = ''] = val.split(' ')
      this.setData({ urgentStartDate: startDate, urgentStartTimeClock: startTimeClock })
      this.syncUrgentEndTime(val)
    }
  },

  inputUrgentEndTime(e) {
    const val = String(e.detail.value || '').trim()
    this.setData({ urgentEndTimeInput: val })
    const parsed = parseBeijingDate(val)
    if (parsed) {
      const [endDate = '', endTimeClock = ''] = val.split(' ')
      this.setData({ urgentEndDate: endDate, urgentEndTimeClock: endTimeClock })
    }
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

    if (!startTime) {
      wx.showToast({ title: '请填写服务开始时间', icon: 'none' })
      return
    }
    const startDateObj = parseBeijingDate(startTime)
    if (!startDateObj) {
      wx.showToast({ title: '开始时间格式有误，需为 YYYY-MM-DD HH:mm', icon: 'none' })
      return
    }
    const nowMs = Date.now()
    if (startDateObj.getTime() < nowMs) {
      wx.showToast({ title: '服务开始时间不能早于当前时间', icon: 'none' })
      return
    }
    if (startDateObj.getTime() < nowMs + 30 * 60 * 1000) {
      wx.showToast({ title: '加急开始时间至少需在当前时间的30分钟后', icon: 'none' })
      return
    }
    if (endTime) {
      const endDateObj = parseBeijingDate(endTime)
      if (endDateObj && endDateObj.getTime() <= startDateObj.getTime()) {
        wx.showToast({ title: '服务结束时间必须晚于开始时间', icon: 'none' })
        return
      }
    }

    const isReUrgent = Boolean(order.isUrgent)
    const modalTitle = isReUrgent ? '确认重新发布加急抢单' : '确认转为加急公共抢单'
    const modalContent = `服务开始时间：${startTime}\n宠托师可获收益：¥${staffReward.toFixed(2)}\n用户支付金额：¥${Number(order.payAmount || 0).toFixed(2)}（保持不变，无需用户补付）\n确定${isReUrgent ? '重新发布加急单' : '重新发布到加急公共单'}吗？`

    wx.showModal({
      title: modalTitle,
      content: modalContent,
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
            wx.showToast({ title: isReUrgent ? '已重新发布加急单' : '已转为加急公共单' })
            this.closeUrgentModal()
            this.load()
          })
          .catch((err) => {
            showError(err)
            this.load()
          })
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

  callPreviousStaff(e) {
    const phone = e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.phone
    if (!phone) {
      wx.showToast({ title: '该宠托师电话未绑定', icon: 'none' })
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
      evidenceImages: [],
      currentStaffDepositBalance: null
    })
    if (staffList[0] && staffList[0].openid) {
      this.loadStaffDepositBalance(staffList[0].openid)
    }
  },

  loadStaffDepositBalance(staffOpenid) {
    if (!staffOpenid) {
      this.setData({ currentStaffDepositBalance: 0 })
      return
    }
    callFunction('admin', 'getStaffDepositDetail', { staffOpenid })
      .then((res) => {
        const balance = res && res.availableRefundAmount != null ? Number(res.availableRefundAmount) : 0
        this.setData({ currentStaffDepositBalance: balance })
      })
      .catch(() => {
        this.setData({ currentStaffDepositBalance: 0 })
      })
  },

  closeEvidenceModal() {
    this.setData({ showEvidenceModal: false, submittingEvidence: false })
  },

  onEvidenceStaffChange(e) {
    const idx = Number(e.detail.value || 0)
    this.setData({ selectedStaffIndex: idx })
    const staff = this.data.evidenceStaffList && this.data.evidenceStaffList[idx]
    if (staff && staff.openid) {
      this.loadStaffDepositBalance(staff.openid)
    }
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
          .then((res) => {
            wx.showToast({ title: '已录入违规留证' })
            this.closeEvidenceModal()
            this.load()
            if (deductAmount > 0) {
              const evidenceId = (res && (res.evidenceId || res._id)) || ''
              const reason = encodeURIComponent(`${reasonTypeObj.label}: ${reasonText}`)
              wx.showModal({
                title: '留证已录入',
                content: `已成功保存违规出险留证记录。是否立即前往财务管理执行保证金扣款？\n责任宠托师：${targetStaff.label}\n建议扣款：¥${deductAmount.toFixed(2)}`,
                confirmText: '去财务扣款',
                cancelText: '稍后处理',
                confirmColor: '#ef4444',
                success: (mRes) => {
                  if (mRes.confirm) {
                    wx.navigateTo({
                      url: `/pages/admin/finance/index?tab=deposits&staffOpenid=${targetStaff.openid}&evidenceId=${evidenceId}&suggestAmount=${deductAmount}&reason=${reason}`
                    })
                  }
                }
              })
            }
          })
          .catch(showError)
          .finally(() => this.setData({ submittingEvidence: false }))
      }
    })
  },

  openManualCompleteModal() {
    const order = this.data.detail && this.data.detail.order
    if (!order) return
    const reward = Number(order.standardStaffReward || this.data.standardStaffReward || 0)
    this.setData({
      showManualCompleteModal: true,
      standardStaffReward: reward,
      manualDeductAmountInput: '0',
      computedFinalReward: reward.toFixed(2),
      manualCompleteRemarkInput: '',
      manualCompleteImages: [],
      submittingManualComplete: false
    })
  },

  closeManualCompleteModal() {
    this.setData({ showManualCompleteModal: false })
  },

  inputManualDeductAmount(e) {
    const val = e.detail.value
    const deduct = Math.max(0, Number(val || 0))
    const base = Number(this.data.standardStaffReward || 0)
    const finalReward = Math.max(0, base - deduct)
    this.setData({
      manualDeductAmountInput: val,
      computedFinalReward: finalReward.toFixed(2)
    })
  },

  quickSetDeduct(e) {
    const type = e.currentTarget.dataset.type
    const base = Number(this.data.standardStaffReward || 0)
    let deduct = 0
    if (type === 'zero') deduct = 0
    else if (type === 'twenty') deduct = Math.round(base * 0.2 * 100) / 100
    else if (type === 'half') deduct = Math.round(base * 0.5 * 100) / 100
    else if (type === 'all') deduct = base

    const finalReward = Math.max(0, base - deduct)
    this.setData({
      manualDeductAmountInput: String(deduct),
      computedFinalReward: finalReward.toFixed(2)
    })
  },

  inputManualCompleteRemark(e) {
    this.setData({ manualCompleteRemarkInput: e.detail.value })
  },

  chooseManualCompleteImages() {
    const remain = 4 - (this.data.manualCompleteImages || []).length
    if (remain <= 0) return
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const files = (res.tempFiles || []).map((f) => f.tempFilePath)
        this.setData({ manualCompleteImages: [...(this.data.manualCompleteImages || []), ...files] })
      }
    })
  },

  removeManualCompleteImage(e) {
    const index = Number(e.currentTarget.dataset.index)
    const list = [...(this.data.manualCompleteImages || [])]
    list.splice(index, 1)
    this.setData({ manualCompleteImages: list })
  },

  previewManualCompleteImage(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.previewImage({ urls: [url] })
  },

  submitManualComplete() {
    const order = this.data.detail && this.data.detail.order
    if (!order) return
    const remark = String(this.data.manualCompleteRemarkInput || '').trim()
    if (!remark) {
      wx.showToast({ title: '请填写核实说明与原因', icon: 'none' })
      return
    }
    const deductAmount = Math.max(0, Number(this.data.manualDeductAmountInput || 0))
    const base = Number(this.data.standardStaffReward || 0)
    if (deductAmount > base) {
      wx.showToast({ title: '扣除金额不可大于应得收益', icon: 'none' })
      return
    }
    const finalReward = Math.max(0, Math.round((base - deductAmount) * 100) / 100)

    wx.showModal({
      title: '确认核实并完成服务',
      content: `宠托师原本应得：¥${base.toFixed(2)}\n违规扣除金额：¥${deductAmount.toFixed(2)}\n最终实发收益：¥${finalReward.toFixed(2)}\n确认更新订单为已完成并执行收益结算吗？`,
      confirmColor: '#10b981',
      success: (res) => {
        if (!res.confirm) return
        this.setData({ submittingManualComplete: true })
        callFunction('admin', 'manualCompleteOrder', {
          orderId: this.data.id,
          remark,
          deductAmount,
          deductReason: remark,
          evidenceImages: this.data.manualCompleteImages
        })
          .then(() => {
            wx.showToast({ title: '已成功核实完单' })
            this.closeManualCompleteModal()
            this.load()
          })
          .catch(showError)
          .finally(() => this.setData({ submittingManualComplete: false }))
      }
    })
  },

  openChatModal() {
    this.setData({ showChatModal: true })
    this.refreshChatRecords()
  },

  closeChatModal() {
    this.setData({ showChatModal: false })
  },

  refreshChatRecords() {
    if (!this.data.id) return
    callFunction('admin', 'listOrderSessionMessages', { orderId: this.data.id })
      .then((res) => {
        this.setData({
          sessionMessages: (res && res.sessionMessages) || [],
          riskBypassLogs: (res && res.riskBypassLogs) || []
        })
      })
      .catch((err) => console.error('refreshChatRecords err:', err))
  },

  ...navMethods()
})
