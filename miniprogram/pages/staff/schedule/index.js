const { callFunction, showError } = require('../../../utils/cloud')
const { navMethods } = require('../../../utils/nav')

const hourLabels = Array.from({ length: 25 }, (_, i) => `${String(i).padStart(2, '0')}:00`)

function formatSlot(slot = {}) {
  return `${String(slot.start).padStart(2, '0')}:00-${String(slot.end).padStart(2, '0')}:00`
}

function enrichDay(day = {}) {
  const slots = Array.isArray(day.slots) ? day.slots : []
  const busyOrders = Array.isArray(day.busyOrders) ? day.busyOrders : []
  return {
    ...day,
    slotText: slots.length ? slots.map(formatSlot).join('、') : '不可预约',
    statusText: day.status === 'available' ? '可预约' : '休息',
    sourceText: day.source === 'exception' ? '日期例外' : '按周规则',
    busyText: busyOrders.length ? `${busyOrders.length} 个已接订单` : '暂无已接订单'
  }
}

Page({
  data: {
    loading: false,
    calendar: [],
    weeklyScheduleText: '',
    selectedDate: '',
    selectedDay: null,
    hourLabels,
    form: {
      status: 'unavailable',
      slots: [],
      remark: ''
    },
    startHourIndex: 9,
    endHourIndex: 18
  },

  ...navMethods,

  onLoad() {
    this.loadCalendar()
  },

  loadCalendar() {
    this.setData({ loading: true })
    callFunction('staff', 'getScheduleCalendar', { days: 14 })
      .then((res) => {
        const calendar = (res.availability || []).map(enrichDay)
        const selectedDate = this.data.selectedDate || (calendar[0] && calendar[0].dateKey) || ''
        this.setData({
          calendar,
          weeklyScheduleText: res.weeklyScheduleText || '',
          selectedDate,
          selectedDay: calendar.find((day) => day.dateKey === selectedDate) || calendar[0] || null
        })
      })
      .catch(showError)
      .finally(() => this.setData({ loading: false }))
  },

  selectDay(e) {
    const dateKey = e.currentTarget.dataset.date
    const day = this.data.calendar.find((item) => item.dateKey === dateKey)
    if (!day) return
    this.setData({
      selectedDate: dateKey,
      selectedDay: day,
      form: {
        status: day.status === 'available' ? 'available' : 'unavailable',
        slots: JSON.parse(JSON.stringify(day.slots || [])),
        remark: day.remark || ''
      }
    })
  },

  setAvailable() {
    const slots = this.data.form.slots.length ? this.data.form.slots : [{ start: 9, end: 18 }]
    this.setData({ 'form.status': 'available', 'form.slots': slots })
  },

  setUnavailable() {
    this.setData({ 'form.status': 'unavailable', 'form.slots': [] })
  },

  bindStartHourChange(e) {
    this.setData({ startHourIndex: Number(e.detail.value) })
  },

  bindEndHourChange(e) {
    this.setData({ endHourIndex: Number(e.detail.value) })
  },

  inputRemark(e) {
    this.setData({ 'form.remark': e.detail.value })
  },

  addSlot() {
    const { startHourIndex, endHourIndex, form } = this.data
    if (form.status !== 'available') {
      wx.showToast({ title: '请先选择可预约', icon: 'none' })
      return
    }
    if (endHourIndex <= startHourIndex) {
      wx.showToast({ title: '结束时间必须大于开始时间', icon: 'none' })
      return
    }
    const slots = [...form.slots, { start: startHourIndex, end: endHourIndex }].sort((a, b) => a.start - b.start)
    this.setData({ 'form.slots': slots })
  },

  removeSlot(e) {
    const index = Number(e.currentTarget.dataset.index)
    this.setData({ 'form.slots': this.data.form.slots.filter((_, i) => i !== index) })
  },

  saveException() {
    if (!this.data.selectedDate) return
    callFunction('staff', 'saveScheduleException', {
      dateKey: this.data.selectedDate,
      status: this.data.form.status,
      slots: this.data.form.slots,
      remark: this.data.form.remark
    })
      .then(() => {
        wx.showToast({ title: '排班已保存', icon: 'none' })
        this.loadCalendar()
      })
      .catch(showError)
  },

  resetException() {
    if (!this.data.selectedDate) return
    callFunction('staff', 'deleteScheduleException', { dateKey: this.data.selectedDate })
      .then(() => {
        wx.showToast({ title: '已恢复按周规则', icon: 'none' })
        this.loadCalendar()
      })
      .catch(showError)
  }
})
