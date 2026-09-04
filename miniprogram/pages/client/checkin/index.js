const { callFunction, showError, ensureLogin, savePendingInvite } = require('../../../utils/cloud')

const weekLabels = ['一', '二', '三', '四', '五', '六', '日']

function getCurrentMonthKey() {
  const date = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function getMonthLabel(monthKey) {
  const [year, month] = String(monthKey || '').split('-')
  return year && month ? `${year} 年 ${month} 月` : ''
}

function rewardText(item) {
  if (!item) return ''
  if (item.rewardType === 'coupon') {
    const coupon = item.rewardSnapshot && item.rewardSnapshot.couponSnapshot ? item.rewardSnapshot.couponSnapshot : item.couponSnapshot
    return coupon && coupon.name ? coupon.name : '优惠券奖励'
  }
  if (item.rewardType === 'none') return '无奖励'
  const points = Number((item.rewardSnapshot && item.rewardSnapshot.finalPoints) || item.points || 0)
  return `${points} 积分`
}

function getStatusText(item) {
  if (!item) return ''
  if (item.checked) return item.checkinType === 'retro' ? '已补签' : '已签到'
  if (item.canCheckin) return '今日可签'
  if (item.canRetro) return '可补签'
  return '未解锁'
}

function getRewardBadge(item) {
  if (!item) return ''
  if (item.rewardType === 'coupon') return '券'
  if (item.rewardType === 'none') return '—'
  const points = Number((item.rewardSnapshot && item.rewardSnapshot.finalPoints) || item.points || 0)
  return points ? `${points}` : '0'
}

function enrichDays(days) {
  return (days || []).map((item) => ({
    ...item,
    rewardText: rewardText(item),
    statusText: getStatusText(item),
    rewardBadge: getRewardBadge(item)
  }))
}

function buildCalendarCells(monthKey, days, selectedDay) {
  const [yearText, monthText] = String(monthKey || '').split('-')
  const year = Number(yearText)
  const month = Number(monthText)
  const firstDay = new Date(year, month - 1, 1)
  const offset = (firstDay.getDay() + 6) % 7
  const cells = []
  for (let i = 0; i < offset; i += 1) cells.push({ empty: true, id: `empty-${i}` })
  days.forEach((item) => {
    const statusClass = item.checked ? 'checked' : (item.canCheckin ? 'today' : (item.canRetro ? 'retro' : 'locked'))
    cells.push({
      ...item,
      id: `day-${item.day}`,
      empty: false,
      selected: Number(item.day) === Number(selectedDay),
      statusClass
    })
  })
  while (cells.length % 7 !== 0) {
    cells.push({ empty: true, id: `tail-${cells.length}` })
  }
  return cells
}

function pickSelectedDay(days, currentSelectedDay) {
  const matched = days.find((item) => Number(item.day) === Number(currentSelectedDay))
  if (matched) return matched.day
  const preferred = days.find((item) => item.canCheckin) || days.find((item) => item.canRetro) || days.find((item) => item.checked) || days[0]
  return preferred ? preferred.day : 0
}

function buildSelectedDayDetail(days, selectedDay) {
  const item = days.find((record) => Number(record.day) === Number(selectedDay))
  if (!item) return null
  let actionText = ''
  if (item.canCheckin) actionText = '立即签到'
  if (item.canRetro) actionText = '使用补签卡'
  return {
    ...item,
    dateLabel: `${item.day} 日`,
    actionText
  }
}

Page({
  data: {
    monthKey: '',
    monthLabel: '',
    points: 0,
    retroCardCount: 0,
    inviteCode: '',
    memberLevelName: '普通会员',
    weekLabels,
    days: [],
    calendarCells: [],
    selectedDay: 0,
    selectedDayDetail: null,
    loading: false,
    submitting: false
  },

  onLoad(query = {}) {
    if (query.inviteCode || query.inviterOpenid) {
      savePendingInvite({ inviteCode: query.inviteCode, inviterOpenid: query.inviterOpenid })
    }
  },

  onShow() {
    ensureLogin({ content: '登录后可查看签到奖励。' })
      .then((user) => {
        const monthKey = this.data.monthKey || getCurrentMonthKey()
        this.setData({ monthKey, monthLabel: getMonthLabel(monthKey), inviteCode: user.inviteCode || '' })
        this.loadCalendar()
      })
      .catch(() => {})
  },

  loadCalendar() {
    this.setData({ loading: true })
    callFunction('checkin', 'getMonthCalendar', { monthKey: this.data.monthKey })
      .then((res) => {
        const days = enrichDays(res.days)
        const selectedDay = pickSelectedDay(days, this.data.selectedDay)
        this.setData({
          points: Number(res.points || 0),
          retroCardCount: Number(res.retroCardCount || 0),
          memberLevelName: res.memberLevelName || '普通会员',
          days,
          calendarCells: buildCalendarCells(res.monthKey || this.data.monthKey, days, selectedDay),
          selectedDay,
          selectedDayDetail: buildSelectedDayDetail(days, selectedDay),
          monthKey: res.monthKey || this.data.monthKey,
          monthLabel: getMonthLabel(res.monthKey || this.data.monthKey),
          shareTitle: res.shareTitle || '来签到领福利，补签卡也能拿',
          shareImageUrl: res.shareImageUrl || '',
          loading: false,
          submitting: false
        })
      })
      .catch((err) => {
        this.setData({ loading: false, submitting: false })
        showError(err)
      })
  },

  tapDay(e) {
    const day = Number(e.currentTarget.dataset.day || 0)
    if (!day) return
    const item = this.data.days.find((record) => Number(record.day) === day)
    if (!item) return
    this.setData({
      selectedDay: day,
      selectedDayDetail: buildSelectedDayDetail(this.data.days, day),
      calendarCells: buildCalendarCells(this.data.monthKey, this.data.days, day)
    })
  },

  handleSelectedAction() {
    const item = this.data.selectedDayDetail
    if (!item || this.data.submitting) return
    if (item.canCheckin) {
      this.checkinToday()
      return
    }
    if (item.canRetro) {
      this.retroCheckin(item.day)
    }
  },

  checkinToday() {
    if (this.data.submitting) return
    this.setData({ submitting: true })
    callFunction('checkin', 'checkinToday')
      .then((res) => {
        const points = Number((res.rewardSnapshot && (res.rewardSnapshot.finalPoints || res.rewardSnapshot.points)) || res.pointsDelta || 0)
        wx.showToast({ title: points ? `签到成功 +${points}` : '签到成功', icon: 'none' })
        this.loadCalendar()
      })
      .catch((err) => {
        this.setData({ submitting: false })
        showError(err)
      })
  },

  retroCheckin(day) {
    if (this.data.submitting) return
    wx.showModal({
      title: '使用补签卡',
      content: `确认补签 ${day} 日奖励吗？将消耗 1 张补签卡。`,
      success: (res) => {
        if (!res.confirm) return
        this.setData({ submitting: true })
        const clientRequestId = `retro_${this.data.monthKey}_${day}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        callFunction('checkin', 'retroCheckin', { monthKey: this.data.monthKey, day, clientRequestId })
          .then(() => {
            wx.showToast({ title: '补签成功', icon: 'none' })
            this.loadCalendar()
          })
          .catch((err) => {
            this.setData({ submitting: false })
            showError(err)
          })
      }
    })
  },

  openPoints() {
    wx.navigateTo({ url: '/pages/client/points/index' })
  },

  onShareAppMessage() {
    const inviteCode = this.data.inviteCode
    const query = inviteCode ? `?inviteCode=${encodeURIComponent(inviteCode)}` : ''
    const shareObj = {
      title: this.data.shareTitle || '来签到领福利，补签卡也能拿',
      path: `/pages/client/checkin/index${query}`
    }
    if (this.data.shareImageUrl) {
      shareObj.imageUrl = this.data.shareImageUrl
    }
    return shareObj
  }
})
