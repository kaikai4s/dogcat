const { callFunction, showError, chooseSelectedLocation } = require('../../../utils/cloud')

const statusMap = {
  pending: { title: '审核中', tip: '资料已提交，请等待平台审核' },
  approved: { title: '已认证宠托师', tip: '可以接收指定订单和附近可接订单' },
  rejected: { title: '审核未通过', tip: '请修改资料后重新提交' }
}

const WEEKDAYS = [
  { day: 1, label: '周一' },
  { day: 2, label: '周二' },
  { day: 3, label: '周三' },
  { day: 4, label: '周四' },
  { day: 5, label: '周五' },
  { day: 6, label: '周六' },
  { day: 7, label: '周日' }
]

const radiusOptions = [
  { label: '3公里', value: 3 },
  { label: '5公里', value: 5 },
  { label: '10公里', value: 10 },
  { label: '15公里', value: 15 },
  { label: '20公里', value: 20 }
]

const hourLabels = Array.from({ length: 25 }, (_, i) => `${String(i).padStart(2, '0')}:00`)

Page({
  data: {
    user: null,
    profile: null,
    displayName: '宠托师',
    avatarUrl: '',
    statusTitle: '未入驻',
    statusTip: '完善资料后申请成为宠托师',
    missingAddressNotice: false,
    showConfigModal: false,
    weekdays: WEEKDAYS,
    radiusOptions,
    hourLabels,
    configForm: {
      serviceAddress: '',
      serviceLatitude: 0,
      serviceLongitude: 0,
      serviceRadiusKm: 5,
      weeklySchedule: { '1': [], '2': [], '3': [], '4': [], '5': [], '6': [], '7': [] }
    },
    activeDay: 1,
    startHourIndex: 10,
    endHourIndex: 12
  },

  onShow() {
    this.loadProfile()
  },

  loadProfile() {
    Promise.all([
      callFunction('auth', 'me'),
      callFunction('staff', 'getStaffProfile')
    ])
      .then(([user, profile]) => {
        const status = profile?.auditStatus
        const info = statusMap[status] || { title: '未入驻', tip: '完善资料后申请成为宠托师' }
        const nickname = String(user.nickname || '').trim()
        const hasAddr = Boolean(profile?.serviceAddress && profile?.serviceLatitude && profile?.serviceLongitude)
        const isApproved = status === 'approved'

        this.setData({
          user,
          profile,
          displayName: nickname || profile?.realName || '宠托师',
          avatarUrl: user.avatarUrl || '',
          statusTitle: info.title,
          statusTip: profile?.auditRemark || info.tip,
          missingAddressNotice: isApproved && !hasAddr
        })
      })
      .catch(showError)
  },

  openConfigModal() {
    const p = this.data.profile || {}
    const defaultSchedule = { '1': [], '2': [], '3': [], '4': [], '5': [], '6': [], '7': [] }
    const schedule = p.weeklySchedule ? { ...defaultSchedule, ...p.weeklySchedule } : defaultSchedule

    this.setData({
      showConfigModal: true,
      configForm: {
        serviceAddress: p.serviceAddress || '',
        serviceLatitude: Number(p.serviceLatitude || 0),
        serviceLongitude: Number(p.serviceLongitude || 0),
        serviceRadiusKm: Number(p.serviceRadiusKm || 5),
        weeklySchedule: JSON.parse(JSON.stringify(schedule))
      },
      activeDay: 1
    })
  },

  closeConfigModal() {
    this.setData({ showConfigModal: false })
  },

  chooseConfigAddress() {
    chooseSelectedLocation()
      .then((loc) => {
        this.setData({
          ['configForm.serviceAddress']: loc.name || loc.address || '',
          ['configForm.serviceLatitude']: loc.latitude,
          ['configForm.serviceLongitude']: loc.longitude
        })
      })
      .catch((err) => {
        if (err && err.errMsg && err.errMsg.includes('cancel')) return
        showError(err)
      })
  },

  selectConfigRadius(e) {
    const radius = Number(e.currentTarget.dataset.radius || 5)
    this.setData({ ['configForm.serviceRadiusKm']: radius })
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

  addTimeSlot() {
    const { activeDay, startHourIndex, endHourIndex, configForm } = this.data
    if (endHourIndex <= startHourIndex) {
      wx.showToast({ title: '结束时间必须大于开始时间', icon: 'none' })
      return
    }
    const dayKey = String(activeDay)
    const list = Array.isArray(configForm.weeklySchedule[dayKey]) ? configForm.weeklySchedule[dayKey] : []
    const updated = [...list, { start: startHourIndex, end: endHourIndex }]
    updated.sort((a, b) => a.start - b.start)

    this.setData({
      [`configForm.weeklySchedule.${dayKey}`]: updated
    })
  },

  removeTimeSlot(e) {
    const { activeDay, configForm } = this.data
    const index = Number(e.currentTarget.dataset.index)
    const dayKey = String(activeDay)
    const list = Array.isArray(configForm.weeklySchedule[dayKey]) ? configForm.weeklySchedule[dayKey] : []
    const updated = list.filter((_, i) => i !== index)

    this.setData({
      [`configForm.weeklySchedule.${dayKey}`]: updated
    })
  },

  presetWeekdaySchedule() {
    const { configForm } = this.data
    const preset = [{ start: 8, end: 22 }]
    const updatedSchedule = { ...configForm.weeklySchedule }
    for (let day = 1; day <= 7; day += 1) {
      updatedSchedule[String(day)] = [...preset]
    }
    this.setData({ ['configForm.weeklySchedule']: updatedSchedule })
    wx.showToast({ title: '已设置为全天 08:00-22:00', icon: 'none' })
  },

  clearCurrentDaySchedule() {
    const { activeDay } = this.data
    this.setData({ [`configForm.weeklySchedule.${String(activeDay)}`]: [] })
  },

  saveConfig() {
    const { serviceAddress, serviceLatitude, serviceLongitude } = this.data.configForm
    if (!serviceAddress || !serviceLatitude || !serviceLongitude) {
      wx.showToast({ title: '请选择固定服务地址', icon: 'none' })
      return
    }

    callFunction('staff', 'updateStaffProfileConfig', this.data.configForm)
      .then(() => {
        wx.showToast({ title: '配置已更新', icon: 'none' })
        this.closeConfigModal()
        this.loadProfile()
      })
      .catch(showError)
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  },

  openCertification() {
    wx.redirectTo({ url: '/pages/staff/certification/index' })
  },

  editProfile() {
    wx.navigateTo({ url: '/pages/client/profile/edit/index?from=staff' })
  },

  backClientProfile() {
    wx.redirectTo({ url: '/pages/client/profile/index' })
  }
})
