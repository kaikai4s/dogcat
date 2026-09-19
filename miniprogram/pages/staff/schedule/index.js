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

Page({
  data: {
    themeClass: 'theme-day',
    loading: false,
    saving: false,
    weekdays: WEEKDAYS,
    hourLabels,
    activeDay: 1,
    startHourIndex: 8,
    endHourIndex: 22,
    weeklySchedule: { '1': [], '2': [], '3': [], '4': [], '5': [], '6': [], '7': [] },
    canGoBack: false
  },

  onLoad(q) {
    const { createPageNav } = require('../../../utils/nav')
    this.setData(createPageNav(q))
    this.applyCurrentTheme()
    this.loadWeeklySchedule()
  },

  ...navMethods(),

  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },

  loadWeeklySchedule() {
    this.setData({ loading: true })
    callFunction('staff', 'getStaffProfile')
      .then((profile) => {
        if (!profile || profile.auditStatus !== 'approved') {
          wx.showToast({ title: '未通过宠托师认证', icon: 'none' })
          setTimeout(() => {
            wx.navigateBack()
          }, 1200)
          return
        }

        // 加载当前的按周规则
        const weeklySchedule = profile.weeklySchedule || {}
        const defaultSchedule = { '1': [], '2': [], '3': [], '4': [], '5': [], '6': [], '7': [] }
        const normalizedSchedule = { ...defaultSchedule }
        for (let day = 1; day <= 7; day++) {
          const key = String(day)
          normalizedSchedule[key] = Array.isArray(weeklySchedule[key]) ? weeklySchedule[key] : []
        }

        this.setData({
          weeklySchedule: normalizedSchedule,
          loading: false
        })
      })
      .catch((error) => {
        this.setData({ loading: false })
        showError(error)
      })
  },

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
        wx.showToast({ title: '保存成功', icon: 'success' })
        this.setData({ saving: false })
        // 1秒后返回上一页
        setTimeout(() => {
          wx.navigateBack()
        }, 1000)
      })
      .catch((error) => {
        this.setData({ saving: false })
        showError(error)
      })
  }
})
