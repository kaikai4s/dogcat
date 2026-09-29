const { callFunction, showError, chooseSelectedLocation } = require('../../../utils/cloud')
const { withStaffWorkflowText } = require('../../../utils/format')
const { applyTheme, getThemeState } = require('../../../utils/theme')
const { loadMessageUnread } = require('../../../utils/client-nav')
const { DEFAULT_CARD_STYLE, isHexColor, normalizeCardStyle, buildCardStyle } = require('../utils/profileCardStyle')

const statusMap = {
  pending: { title: '审核中', tip: '资料已提交，请等待平台审核' },
  approved: { title: '待完成培训', tip: '资料已通过，请完成答题、视频学习和线上视频审核' },
  rejected: { title: '审核未通过', tip: '请修改资料后重新提交' }
}

function profileStatusInfo(profile) {
  if (!profile) return { title: '未入驻', tip: '完善资料后申请成为宠托师' }
  if (profile.auditStatus !== 'approved') return statusMap[profile.auditStatus] || { title: '未入驻', tip: '完善资料后申请成为宠托师' }
  if (profile.staffLevel === 'certified') return { title: '认证宠托师', tip: '已完成认证，可正常接单服务' }
  if (profile.staffLevel === 'intern') return { title: '实习宠托师', tip: '完成 3 单后可申请晋升认证宠托师' }
  if (profile.videoAuditStatus === 'pending') return { title: '视频审核中', tip: '等待管理员完成线上视频审核' }
  return { title: profile.onboardingStatusText || '待完成培训', tip: '请完成答题、视频学习和线上视频审核' }
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

function uploadProfileBackground(filePath) {
  const ext = filePath.includes('.') ? filePath.substring(filePath.lastIndexOf('.')) : '.jpg'
  return new Promise((resolve, reject) => {
    wx.cloud.uploadFile({
      cloudPath: `staff_profile_backgrounds/${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`,
      filePath,
      success: (res) => resolve(res.fileID),
      fail: reject
    })
  })
}

Page({
  data: {
    themeClass: 'theme-day',
    user: null,
    profile: null,
    displayName: '宠托师',
    avatarUrl: '',
    statusTitle: '未入驻',
    statusTip: '完善资料后申请成为宠托师',
    missingAddressNotice: false,
    depositNotice: null,
    showConfigModal: false,
    weekdays: WEEKDAYS,
    radiusOptions,
    hourLabels,
    profileCardStyle: buildCardStyle(DEFAULT_CARD_STYLE),
    configForm: {
      ...DEFAULT_CARD_STYLE,
      serviceAddress: '',
      publicServiceAddress: '',
      serviceLatitude: 0,
      serviceLongitude: 0,
      serviceRadiusKm: 5,
      profileBackgroundFileId: '',
      profileIntro: '',
      rejectUnvaccinatedPets: false,
      weeklySchedule: { '1': [], '2': [], '3': [], '4': [], '5': [], '6': [], '7': [] }
    },
    activeDay: 1,
    startHourIndex: 10,
    endHourIndex: 12,
    messageUnreadCount: 0,
    messageHasUnread: false
  },

  onShow() {
    this.applyCurrentTheme()
    this.loadProfile()
    loadMessageUnread(this, 'staff')
  },

  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },

  loadProfile() {
    Promise.all([
      callFunction('auth', 'me'),
      callFunction('staff', 'getStaffProfile'),
      callFunction('finance', 'getStaffBalance').catch(() => null)
    ])
      .then(([user, profile, balance]) => {
        const isStaffActive = user && Array.isArray(user.roles) && user.roles.includes('staff')
        const isProfileValid = profile && (profile.auditStatus === 'approved' || profile.auditStatus === 'intern' || profile.videoAuditStatus === 'approved')
        if (!profile || (!isStaffActive && !isProfileValid)) {
          wx.showToast({ title: '未通过宠托师认证，即将返回', icon: 'none' })
          setTimeout(() => {
            wx.redirectTo({ url: '/pages/staff/certification/index' })
          }, 1200)
          return
        }
        const profileView = withStaffWorkflowText(profile)
        const status = profileView?.auditStatus
        const info = profileStatusInfo(profileView)
        const nickname = String(user.nickname || '').trim()
        const hasAddr = Boolean(profileView?.serviceAddress && profileView?.serviceLatitude && profileView?.serviceLongitude)
        const isApproved = status === 'approved'

        const balanceData = balance ? {
          ...balance,
          availableText: Number(balance.available || 0).toFixed(2),
          pendingText: Number(balance.pending || 0).toFixed(2),
          withdrawnText: Number(balance.withdrawn || 0).toFixed(2)
        } : null

        this.setData({
          user,
          profile: profileView,
          balance: balanceData,
          displayName: nickname || profileView?.realName || '宠托师',
          avatarUrl: user.avatarUrl || '',
          badgeTag: user.badgeTag || '',
          badgeStyle: user.badgeStyle || '',
          memberLevelName: user.memberLevelName || '',
          nameColor: user.nameColor || '',
          nameEffect: user.nameEffect || '',
          statusTitle: info.title,
          statusTip: profileView?.auditRemark || info.tip,
          missingAddressNotice: isApproved && !hasAddr,
          depositNotice: profileView?.depositNotice || null
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
      profileCardStyle: buildCardStyle(p),
      configForm: {
        ...normalizeCardStyle(p),
        serviceAddress: p.serviceAddress || '',
        publicServiceAddress: p.publicServiceAddress || '',
        serviceLatitude: Number(p.serviceLatitude || 0),
        serviceLongitude: Number(p.serviceLongitude || 0),
        serviceRadiusKm: Number(p.serviceRadiusKm || 5),
        acceptDirectOrders: p.acceptDirectOrders !== false,
        rejectUnvaccinatedPets: p.rejectUnvaccinatedPets === true,
        profileBackgroundFileId: p.profileBackgroundFileId || '',
        profileIntro: p.profileIntro || '',
        weeklySchedule: JSON.parse(JSON.stringify(schedule))
      },
      activeDay: 1
    })
  },

  toggleAcceptDirectOrders(e) {
    this.setData({ 'configForm.acceptDirectOrders': Boolean(e.detail.value) })
  },

  toggleRejectUnvaccinatedPets(e) {
    this.setData({ 'configForm.rejectUnvaccinatedPets': Boolean(e.detail.value) })
  },

  onConfigInput(e) {
    const field = e.currentTarget.dataset.field
    const value = field === 'profileIntro' ? String(e.detail.value || '').slice(0, 60) : e.detail.value
    this.setData({ [`configForm.${field}`]: value })
  },

  inputCardColor(e) {
    const { field } = e.currentTarget.dataset
    if (!['profileCardColor', 'profileCardTextColor'].includes(field)) return
    this.setData({ [`configForm.${field}`]: String(e.detail.value || '').trim() }, this.updateCardPreview)
  },

  changeCardOpacity(e) {
    const configForm = { ...this.data.configForm, profileCardOpacity: Number(e.detail.value) }
    this.setData({ 'configForm.profileCardOpacity': configForm.profileCardOpacity, profileCardStyle: buildCardStyle(configForm) })
  },

  changeCardBlur(e) {
    const configForm = { ...this.data.configForm, profileCardBlur: Number(e.detail.value) }
    this.setData({ 'configForm.profileCardBlur': configForm.profileCardBlur, profileCardStyle: buildCardStyle(configForm) })
  },

  onPaletteColorChange(e) {
    const field = e.currentTarget.dataset.field
    const color = e.detail.value
    if (!['profileCardColor', 'profileCardTextColor'].includes(field) || !isHexColor(color)) return
    const configForm = { ...this.data.configForm, [field]: color }
    this.setData({ [`configForm.${field}`]: color, profileCardStyle: buildCardStyle(configForm) })
  },

  updateCardPreview() {
    this.setData({ profileCardStyle: buildCardStyle(this.data.configForm) })
  },

  resetCardStyle() {
    this.setData({ configForm: { ...this.data.configForm, ...DEFAULT_CARD_STYLE } }, this.updateCardPreview)
  },

  chooseProfileBackground() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const filePath = res.tempFiles && res.tempFiles[0] && res.tempFiles[0].tempFilePath
        if (!filePath) return
        wx.showLoading({ title: '上传背景中...' })
        uploadProfileBackground(filePath)
          .then((fileId) => {
            wx.hideLoading()
            this.setData({ ['configForm.profileBackgroundFileId']: fileId })
          })
          .catch((err) => {
            wx.hideLoading()
            showError(err)
          })
      },
      fail: (err) => {
        if (err && err.errMsg && err.errMsg.includes('cancel')) return
        showError(err)
      }
    })
  },

  removeProfileBackground() {
    this.setData({ ['configForm.profileBackgroundFileId']: '' })
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
    if (!isHexColor(this.data.configForm.profileCardColor) || !isHexColor(this.data.configForm.profileCardTextColor)) {
      wx.showToast({ title: '请输入完整色值，如 #ffffff', icon: 'none' })
      return
    }
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
    const pages = getCurrentPages()
    const current = pages[pages.length - 1]
    const currentRoute = current && current.route ? '/' + current.route : ''
    if (currentRoute === url) return
    const mainNavUrls = ['/pages/staff/home/index', '/pages/staff/orders/list/index', '/pages/staff/messages/index', '/pages/staff/certification/index', '/pages/staff/profile/index']
    const method = mainNavUrls.includes(url) ? 'redirectTo' : 'navigateTo'
    wx[method]({ url })
  },

  openCertification() {
    if (this.data.profile && this.data.profile.auditStatus === 'approved' && this.data.profile.staffLevel !== 'certified') {
      wx.navigateTo({ url: '/pages/staff/training/index' })
      return
    }
    if (this.data.profile && this.data.profile.staffLevel === 'certified') {
      wx.showToast({ title: '已成为认证宠托师', icon: 'none' })
      return
    }
    wx.redirectTo({ url: '/pages/staff/certification/index' })
  },

  editProfile() {
    wx.navigateTo({ url: '/pages/client/profile/edit/index?from=staff' })
  },

  backClientProfile() {
    const app = getApp()
    if (app && app.globalData) app.globalData.activeRole = 'client'
    wx.reLaunch({ url: '/pages/client/profile/index' })
  }
})
