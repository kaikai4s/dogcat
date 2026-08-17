const { callFunction, showError } = require('../../../../utils/cloud')

const statusOptions = [
  { label: '正常', value: 'active' },
  { label: '禁用', value: 'disabled' }
]

const roleOptions = [
  { label: '用户', value: 'client' },
  { label: '宠托师', value: 'staff' },
  { label: '管理员', value: 'admin' }
]

function numberText(value) {
  return String(Math.max(Math.round(Number(value || 0)), 0))
}

Page({
  data: {
    openid: '',
    loading: false,
    saving: false,
    user: null,
    form: {
      nickname: '',
      phone: '',
      avatarUrl: '',
      status: 'active',
      memberLevelName: '普通会员',
      points: '0',
      totalPoints: '0',
      retroCardCount: '0',
      roles: ['client']
    },
    statusOptions,
    roleOptions,
    statusIndex: 0,
    statsRows: []
  },

  onLoad(query = {}) {
    const openid = decodeURIComponent(query.openid || '')
    this.setData({ openid })
    this.load()
  },

  load() {
    if (!this.data.openid) return
    this.setData({ loading: true })
    callFunction('admin', 'getUserDetail', { openid: this.data.openid })
      .then((user) => {
        const status = user.status === 'disabled' ? 'disabled' : (user.status === 'deleted' ? 'deleted' : 'active')
        const statusIndex = Math.max(statusOptions.findIndex((item) => item.value === status), 0)
        this.setData({
          user,
          form: {
            nickname: user.nickname || '',
            phone: user.phone || '',
            avatarUrl: user.avatarUrl || '',
            status,
            memberLevelName: user.memberLevelName || '普通会员',
            points: numberText(user.points),
            totalPoints: numberText(user.totalPoints),
            retroCardCount: numberText(user.retroCardCount),
            roles: Array.isArray(user.roles) && user.roles.length ? user.roles : ['client']
          },
          statusIndex,
          statsRows: this.buildStatsRows(user.stats || {}),
          loading: false
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        showError(err)
      })
  },

  buildStatsRows(stats) {
    return [
      { label: '宠物资料', value: stats.pets || 0 },
      { label: '地址资料', value: stats.addresses || 0 },
      { label: '居家安全资料', value: stats.homeSecurity || 0 },
      { label: '优惠券', value: stats.coupons || 0 },
      { label: '签到记录', value: stats.checkins || 0 },
      { label: '积分流水', value: stats.pointLogs || 0 },
      { label: '奖励邮件', value: stats.rewardMails || 0 },
      { label: '关注宠托师', value: stats.favorites || 0 },
      { label: '客户订单', value: stats.clientOrders || 0 },
      { label: '宠托师订单', value: stats.staffOrders || 0 },
      { label: '宠托师资料', value: stats.staffProfiles || 0 }
    ]
  },

  inputField(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    this.setData({ [`form.${key}`]: e.detail.value })
  },

  changeStatus(e) {
    const index = Number(e.detail.value || 0)
    const option = statusOptions[index] || statusOptions[0]
    this.setData({ statusIndex: index, 'form.status': option.value })
  },

  changeRoles(e) {
    const roles = e.detail.value && e.detail.value.length ? e.detail.value : ['client']
    this.setData({ 'form.roles': roles })
  },

  save() {
    if (!this.data.user || this.data.user.status === 'deleted') return
    this.setData({ saving: true })
    callFunction('admin', 'updateUserProfile', {
      openid: this.data.openid,
      ...this.data.form,
      points: Number(this.data.form.points || 0),
      totalPoints: Number(this.data.form.totalPoints || 0),
      retroCardCount: Number(this.data.form.retroCardCount || 0)
    })
      .then(() => {
        wx.showToast({ title: '已保存', icon: 'none' })
        this.load()
      })
      .catch(showError)
      .finally(() => this.setData({ saving: false }))
  },

  deleteUser() {
    if (!this.data.user || this.data.user.status === 'deleted') return
    wx.showModal({
      title: '删除用户',
      content: '删除后将清理用户宠物、地址、签到、优惠券、积分流水等个人数据；订单记录会保留。确认删除？',
      confirmText: '删除',
      confirmColor: '#f4436b',
      success: (res) => {
        if (!res.confirm) return
        callFunction('admin', 'deleteUser', { openid: this.data.openid })
          .then(() => {
            wx.showToast({ title: '已删除', icon: 'none' })
            wx.navigateBack()
          })
          .catch(showError)
      }
    })
  }
})
