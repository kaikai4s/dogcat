const { callFunction, showError, ensureLogin } = require('../../../utils/cloud')

const sourceTypeMap = {
  order_complete: '完成订单',
  order_review: '评价订单',
  admin_grant: '管理员操作',
  checkin_daily: '每日签到',
  reward_mail: '奖励邮箱'
}

function formatDate(val) {
  if (!val) return ''
  const d = new Date(val)
  if (isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

Page({
  data: {
    points: 0,
    totalPoints: 0,
    memberLevelName: '普通会员',
    pointMultiplier: 1,
    retroCardCount: 0,
    currentLevel: null,
    nextLevel: null,
    levels: [],
    logs: [],
    page: 1,
    total: 0,
    loading: false
  },

  onShow() {
    ensureLogin({ content: '登录后可查看积分。' })
      .then(() => this.load(1))
      .catch(() => {})
  },

  load(page) {
    this.setData({ loading: true })
    callFunction('memberLevel', 'myInfo', { page: page || 1 })
      .then((info) => {
        const newLogs = (info.logs || []).map((log) => ({
          ...log,
          sourceLabel: sourceTypeMap[log.sourceType] || log.sourceType,
          sign: log.delta > 0 ? '+' : '',
          createdAt: formatDate(log.createdAt)
        }))
        this.setData({
          points: info.points,
          totalPoints: info.totalPoints,
          memberLevelName: info.memberLevelName || '普通会员',
          pointMultiplier: Number(info.pointMultiplier || 1),
          retroCardCount: Number(info.retroCardCount || 0),
          currentLevel: info.currentLevel || null,
          nextLevel: info.nextLevel || null,
          levels: info.levels || [],
          logs: page === 1 ? newLogs : [...this.data.logs, ...newLogs],
          page: info.page,
          total: info.total,
          loading: false
        })
      })
      .catch((err) => { this.setData({ loading: false }); showError(err) })
  },

  loadMore() {
    if (this.data.loading) return
    if (this.data.logs.length >= this.data.total) return
    this.load(this.data.page + 1)
  },

  openCheckin() {
    wx.navigateTo({ url: '/pages/client/checkin/index' })
  },

  openLottery() {
    wx.navigateTo({ url: '/pages/client/lottery/index' })
  }
})
