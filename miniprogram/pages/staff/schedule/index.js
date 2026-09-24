const { callFunction, showError } = require('../../../utils/cloud')
const { navMethods } = require('../../../utils/nav')
const { applyTheme, getThemeState } = require('../../../utils/theme')

const hourLabels = Array.from({ length: 25 }, (_, i) => `${String(i).padStart(2, '0')}:00`)

const WEEKDAYS = [
  { day: 1, label: '周一' },
  { day: 2, label: '周二' },
  { day: 3, label: '周三' },
  { day: 4, label: '周四' },
  { day: 5, label: '周五' },
  { day: 6, label: '周六' },
  { day: 7, label: '周日' }
]

function formatTodayDate() {
  const d = new Date()
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

Page({
  data: {
    themeClass: 'theme-day',
    loading: false,
    saving: false,
    scheduleTab: 'weekly', // 'weekly' 或 'exceptions'
    weekdays: WEEKDAYS,
    hourLabels,
    activeDay: 1,
    startHourIndex: 8,
    endHourIndex: 22,
    weeklySchedule: { '1': [], '2': [], '3': [], '4': [], '5': [], '6': [], '7': [] },
    bookableUntilDate: '', // 接单截止日期（只接单到该日期）
    todayDate: formatTodayDate(),
    restPickerDate: formatTodayDate(),
    restDateList: [], // 已设置的特殊休息日列表
    canGoBack: false
  },

  onLoad(q) {
    const { createPageNav } = require('../../../utils/nav')
    this.setData(createPageNav(q))
    this.applyCurrentTheme()
    this.loadScheduleData()
  },

  ...navMethods(),

  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },

  switchScheduleTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (!tab || tab === this.data.scheduleTab) return
    this.setData({ scheduleTab: tab })
  },

  loadScheduleData() {
    this.setData({ loading: true })
    callFunction('staff', 'getScheduleCalendar', { days: 31 })
      .then((res) => {
        const weeklySchedule = res.weeklySchedule || {}
        const defaultSchedule = { '1': [], '2': [], '3': [], '4': [], '5': [], '6': [], '7': [] }
        const normalizedSchedule = { ...defaultSchedule }
        for (let day = 1; day <= 7; day++) {
          const key = String(day)
          normalizedSchedule[key] = Array.isArray(weeklySchedule[key]) ? weeklySchedule[key] : []
        }

        const availability = Array.isArray(res.availability) ? res.availability : []
        const restDateList = availability
          .filter((item) => item.source === 'exception' && item.status === 'unavailable')
          .map((item) => ({
            dateKey: item.dateKey,
            dayName: item.dayName,
            remark: item.remark || '休息不接单'
          }))

        this.setData({
          weeklySchedule: normalizedSchedule,
          bookableUntilDate: res.bookableUntilDate || '',
          restDateList,
          loading: false
        })
      })
      .catch((error) => {
        this.setData({ loading: false })
        showError(error)
      })
  },

  // 1. 接单截止日期操作
  bindUntilDateChange(e) {
    const date = e.detail.value
    this.setData({ bookableUntilDate: date })
  },

  clearUntilDate() {
    this.setData({ bookableUntilDate: '' })
  },

  saveUntilDate() {
    this.setData({ saving: true })
    callFunction('staff', 'updateStaffProfileConfig', {
      bookableUntilDate: this.data.bookableUntilDate
    })
      .then(() => {
        this.setData({ saving: false })
        wx.showToast({
          title: this.data.bookableUntilDate ? `已设置接单至 ${this.data.bookableUntilDate}` : '已清除截止限制（长期开放）',
          icon: 'none'
        })
        this.loadScheduleData()
      })
      .catch((err) => {
        this.setData({ saving: false })
        showError(err)
      })
  },

  // 2. 特殊休息日（不接单日期）操作
  bindRestPickerChange(e) {
    this.setData({ restPickerDate: e.detail.value })
  },

  addRestDate() {
    const dateKey = this.data.restPickerDate
    if (!dateKey) return wx.showToast({ title: '请选择日期', icon: 'none' })
    if (this.data.restDateList.some((item) => item.dateKey === dateKey)) {
      return wx.showToast({ title: '该日期已在不接单列表中', icon: 'none' })
    }

    wx.showLoading({ title: '设置中...' })
    callFunction('staff', 'saveScheduleException', {
      dateKey,
      status: 'unavailable',
      remark: '宠托师设置休息'
    })
      .then(() => {
        wx.hideLoading()
        wx.showToast({ title: `已设置 ${dateKey} 为休息不接单`, icon: 'none' })
        this.loadScheduleData()
      })
      .catch((err) => {
        wx.hideLoading()
        showError(err)
      })
  },

  deleteRestDate(e) {
    const dateKey = e.currentTarget.dataset.date
    if (!dateKey) return

    wx.showModal({
      title: '确认恢复接单',
      content: `确定恢复 ${dateKey} 正常接单吗？`,
      success: (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '处理中...' })
          callFunction('staff', 'deleteScheduleException', { dateKey })
            .then(() => {
              wx.hideLoading()
              wx.showToast({ title: `已恢复 ${dateKey} 正常接单`, icon: 'none' })
              this.loadScheduleData()
            })
            .catch((err) => {
              wx.hideLoading()
              showError(err)
            })
        }
      }
    })
  },

  // 3. 常规按周接单时间操作
  switchDay(e) {
    const day = Number(e.currentTarget.dataset.day || 1)
    this.setData({ activeDay: day })
  },

  bindStartHourChange(e) {
    this.setData({ startHourIndex: Number(e.detail.value) })
  },

  bindEndHourChange(e) {
    this.setData({ endHourIndex: Number(e.detail.value) })
  },

  addSlot() {
    const { activeDay, startHourIndex, endHourIndex, weeklySchedule } = this.data
    if (endHourIndex <= startHourIndex) {
      wx.showToast({ title: '结束时间必须大于开始时间', icon: 'none' })
      return
    }
    const dayKey = String(activeDay)
    const list = Array.isArray(weeklySchedule[dayKey]) ? weeklySchedule[dayKey] : []
    const updated = [...list, { start: startHourIndex, end: endHourIndex }]
    updated.sort((a, b) => a.start - b.start)

    this.setData({
      [`weeklySchedule.${dayKey}`]: updated
    })
  },

  removeSlot(e) {
    const { activeDay, weeklySchedule } = this.data
    const index = Number(e.currentTarget.dataset.index)
    const dayKey = String(activeDay)
    const list = Array.isArray(weeklySchedule[dayKey]) ? weeklySchedule[dayKey] : []
    const updated = list.filter((_, i) => i !== index)

    this.setData({
      [`weeklySchedule.${dayKey}`]: updated
    })
  },

  clearCurrentDay() {
    const { activeDay } = this.data
    this.setData({ [`weeklySchedule.${String(activeDay)}`]: [] })
    wx.showToast({ title: '已清空本日时间', icon: 'none' })
  },

  presetWeeklySchedule() {
    const preset = [{ start: 8, end: 22 }]
    const updatedSchedule = {}
    for (let day = 1; day <= 7; day += 1) {
      updatedSchedule[String(day)] = [...preset]
    }
    this.setData({ weeklySchedule: updatedSchedule })
    wx.showToast({ title: '已设置全周 08:00-22:00', icon: 'none' })
  },

  clearWeeklySchedule() {
    wx.showModal({
      title: '确认清空',
      content: '确定要清空所有时间吗？',
      success: (res) => {
        if (res.confirm) {
          const updatedSchedule = { '1': [], '2': [], '3': [], '4': [], '5': [], '6': [], '7': [] }
          this.setData({ weeklySchedule: updatedSchedule })
          wx.showToast({ title: '已清空所有时间', icon: 'none' })
        }
      }
    })
  },

  saveWeeklySchedule() {
    this.setData({ saving: true })

    callFunction('staff', 'updateStaffProfileConfig', {
      weeklySchedule: this.data.weeklySchedule
    })
      .then(() => {
        wx.showToast({ title: '按周排班已保存', icon: 'success' })
        this.setData({ saving: false })
      })
      .catch((error) => {
        this.setData({ saving: false })
        showError(error)
      })
  }
})
