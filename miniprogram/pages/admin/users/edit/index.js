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

function decorateRoleOptions(options = [], roles = []) {
  const set = new Set(roles || [])
  return (options || []).map((item) => ({
    ...item,
    checked: set.has(item.value)
  }))
}

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
    roleOptions: decorateRoleOptions(roleOptions, ['client']),
    statusIndex: 0,
    statusText: '正常',
    statsRows: [],
    userCommission: {
      available: 0,
      withdrawn: 0,
      expired: 0,
      total: 0,
      availableText: '0.00',
      withdrawnText: '0.00',
      expiredText: '0.00',
      totalText: '0.00',
      earningsCount: 0,
      withdrawsCount: 0,
      expiredCount: 0
    },
    activeDetailType: '',
    activeDetailTitle: '',
    activeDetailSubtitle: '',
    detailLoading: false,
    currentDetailList: [],
    relatedCache: {}
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
        const roles = Array.isArray(user.roles) && user.roles.length ? user.roles : ['client']
        const comm = user.commission || {}
        const userCommission = {
          available: Number(comm.available || 0),
          withdrawn: Number(comm.withdrawn || 0),
          expired: Number(comm.expired || 0),
          total: Number(comm.total || 0),
          availableText: Number(comm.available || 0).toFixed(2),
          withdrawnText: Number(comm.withdrawn || 0).toFixed(2),
          expiredText: Number(comm.expired || 0).toFixed(2),
          totalText: Number(comm.total || 0).toFixed(2),
          earningsCount: comm.earningsCount || 0,
          withdrawsCount: comm.withdrawsCount || 0,
          expiredCount: comm.expiredCount || 0
        }
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
            roles
          },
          statusIndex,
          statusText: ({ active: '正常', disabled: '已禁用', deleted: '已删除' })[user.status] || '账号状态未知',
          roleOptions: decorateRoleOptions(roleOptions, roles),
          statsRows: this.buildStatsRows(user.stats || {}),
          userCommission,
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
      { key: 'pets', label: '宠物资料', value: stats.pets || 0 },
      { key: 'addresses', label: '地址资料', value: stats.addresses || 0 },
      { key: 'homeSecurity', label: '居家安全资料', value: stats.homeSecurity || 0 },
      { key: 'coupons', label: '优惠券', value: stats.coupons || 0 },
      { key: 'checkins', label: '签到记录', value: stats.checkins || 0 },
      { key: 'pointLogs', label: '积分流水', value: stats.pointLogs || 0 },
      { key: 'rewardMails', label: '奖励邮件', value: stats.rewardMails || 0 },
      { key: 'favorites', label: '关注宠托师', value: stats.favorites || 0 },
      { key: 'clientOrders', label: '客户订单', value: stats.clientOrders || 0, isOrder: true },
      { key: 'staffOrders', label: '宠托师订单', value: stats.staffOrders || 0, isOrder: true },
      { key: 'staffProfiles', label: '宠托师资料', value: stats.staffProfiles || 0, isStaff: true }
    ]
  },

  tapStatsRow(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    if (key === 'clientOrders' || key === 'staffOrders') {
      wx.navigateTo({ url: `/pages/admin/orders/list/index?keyword=${encodeURIComponent(this.data.openid)}` })
      return
    }
    if (key === 'staffProfiles') {
      wx.navigateTo({ url: `/pages/admin/sitters/list/index?keyword=${encodeURIComponent(this.data.openid)}` })
      return
    }
    this.openDetailModalByType(key)
  },

  openDetailModal(e) {
    const type = e.currentTarget.dataset.type
    if (!type) return
    this.openDetailModalByType(type)
  },

  openDetailModalByType(type) {
    const titles = {
      coupons: '优惠券明细',
      pointLogs: '积分详细流水',
      addresses: '收货地址资料',
      pets: '宠物资料明细',
      commission_earnings: '佣金获得明细',
      commission_withdraws: '佣金提现记录',
      commission_expired: '过期佣金明细',
      homeSecurity: '居家安全资料',
      checkins: '签到记录明细',
      rewardMails: '奖励邮件明细',
      favorites: '关注宠托师明细'
    }
    const title = titles[type] || '详细资料'
    this.setData({
      activeDetailType: type,
      activeDetailTitle: title,
      activeDetailSubtitle: '',
      detailLoading: true,
      currentDetailList: []
    })

    if (this.data.relatedCache[type]) {
      const list = this.data.relatedCache[type]
      this.setData({
        currentDetailList: list,
        activeDetailSubtitle: `共 ${list.length} 条记录`,
        detailLoading: false
      })
      return
    }

    callFunction('admin', 'getUserRelatedDetails', { openid: this.data.openid, type })
      .then((data) => {
        let list = []
        if (type === 'coupons') list = data.coupons || []
        else if (type === 'pointLogs') list = data.pointLogs || []
        else if (type === 'addresses') list = data.addresses || []
        else if (type === 'pets') list = data.pets || []
        else if (type === 'commission_earnings') list = (data.commission && data.commission.earnings) || []
        else if (type === 'commission_withdraws') list = (data.commission && data.commission.withdraws) || []
        else if (type === 'commission_expired') list = (data.commission && data.commission.expiredRecords) || []
        else if (type === 'homeSecurity') list = data.homeSecurity || []
        else if (type === 'checkins') list = data.checkins || []
        else if (type === 'rewardMails') list = data.rewardMails || []
        else if (type === 'favorites') list = data.favorites || []
        else list = data[type] || []

        const cacheUpdate = { [`relatedCache.${type}`]: list }
        if (data.commission) {
          cacheUpdate['userCommission.earningsCount'] = (data.commission.earnings || []).length
          cacheUpdate['userCommission.withdrawsCount'] = (data.commission.withdraws || []).length
          cacheUpdate['userCommission.expiredCount'] = (data.commission.expiredRecords || []).length
        }
        this.setData({
          ...cacheUpdate,
          currentDetailList: list,
          activeDetailSubtitle: `共 ${list.length} 条记录`,
          detailLoading: false
        })
      })
      .catch((err) => {
        this.setData({ detailLoading: false })
        showError(err)
      })
  },

  closeDetailModal() {
    this.setData({ activeDetailType: '', currentDetailList: [] })
  },

  stopBubble() {},

  viewMemorials() {
    if (!this.data.openid) return
    wx.navigateTo({ url: '/pages/admin/memorial/user-archive?openid=' + encodeURIComponent(this.data.openid) })
  },

  viewPets() {
    if (!this.data.openid) return
    wx.navigateTo({ url: `/pages/admin/pets/list/index?keyword=${encodeURIComponent(this.data.openid)}` })
  },

  copyText(e) {
    const text = e.currentTarget.dataset.text
    if (!text) return
    wx.setClipboardData({
      data: String(text),
      success: () => wx.showToast({ title: '已复制', icon: 'none' })
    })
  },

  inputField(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    this.setData({ [`form.${key}`]: e.detail.value })
  },

  changeStatus(e) {
    const index = Number(e.detail.value || 0)
    const option = statusOptions[index] || statusOptions[0]
    this.setData({ statusIndex: index, statusText: option.label, 'form.status': option.value })
  },

  changeRoles(e) {
    const roles = e.detail.value && e.detail.value.length ? e.detail.value : ['client']
    this.setData({
      'form.roles': roles,
      roleOptions: decorateRoleOptions(roleOptions, roles)
    })
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
  },

  hardDeleteUser() {
    if (!this.data.user || this.data.user.status !== 'deleted') return
    wx.showModal({
      title: '彻底删除用户',
      content: '彻底删除会移除账号记录，并让该微信下次登录成为全新用户；旧订单会保留在后台，但会与该 openid 脱钩。该操作不可恢复，是否继续？',
      confirmText: '继续',
      confirmColor: '#f4436b',
      success: (first) => {
        if (!first.confirm) return
        wx.showModal({
          title: '最终确认',
          content: '彻底删除后可重新触发新人邀请奖励，历史订单不再属于新账号。确认彻底删除？',
          confirmText: '彻底删除',
          confirmColor: '#f4436b',
          success: (second) => {
            if (!second.confirm) return
            callFunction('admin', 'hardDeleteUser', { openid: this.data.openid })
              .then(() => {
                wx.showToast({ title: '已彻底删除', icon: 'none' })
                wx.navigateBack()
              })
              .catch(showError)
          }
        })
      }
    })
  }
})
