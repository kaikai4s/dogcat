const { callFunction, showError } = require('../../../../utils/cloud')

const statusTabs = [
  { label: '全部', value: '' },
  { label: '已通过', value: 'approved' },
  { label: '待审核', value: 'pending' },
  { label: '未通过', value: 'rejected' },
  { label: '已移除', value: 'revoked' }
]

function withDisplay(profile) {
  const reviewCount = Number(profile.reviewCount || 0)
  return {
    ...profile,
    reviewCount,
    ratingText: reviewCount ? `${Number(profile.ratingAverage || 0)}分 / ${reviewCount}条评价` : '暂无评分',
    featuredActionText: profile.isFeatured ? '取消精选' : '设为精选',
    actionText: profile.auditStatus === 'pending' ? '去审核' : '查看资料',
    canRevokeStaff: profile.auditStatus === 'approved',
    avatarText: (profile.userNickname || profile.realName || '托').slice(0, 1),
    expanded: false
  }
}

function pageList(result) {
  return Array.isArray(result) ? { list: result, hasMore: false, page: 1, total: result.length } : (result || { list: [], hasMore: false, page: 1, total: 0 })
}

Page({
  data: {
    profiles: [],
    keyword: '',
    auditStatus: '',
    statusTabs,
    page: 1,
    pageSize: 20,
    hasMore: true,
    total: 0,
    loading: false
  },

  onShow() {
    this.load({ reset: true })
  },

  onReachBottom() {
    this.loadMore()
  },

  load(options = {}) {
    if (this.data.loading) return
    const reset = options.reset === true
    const page = reset ? 1 : this.data.page
    this.setData({ loading: true })
    callFunction('admin', 'listStaffProfiles', { keyword: this.data.keyword, auditStatus: this.data.auditStatus, page, pageSize: this.data.pageSize })
      .then((result) => {
        const pageData = pageList(result)
        const profiles = pageData.list.map(withDisplay)
        this.setData({
          profiles: reset ? profiles : this.data.profiles.concat(profiles),
          page: pageData.page,
          hasMore: pageData.hasMore,
          total: pageData.total,
          loading: false
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        showError(err)
      })
  },

  loadMore() {
    if (!this.data.hasMore || this.data.loading) return
    this.setData({ page: this.data.page + 1 }, () => this.load())
  },

  inputKeyword(e) {
    this.setData({ keyword: e.detail.value })
  },

  search() {
    this.load({ reset: true })
  },

  switchStatus(e) {
    this.setData({ auditStatus: e.currentTarget.dataset.value || '' })
    this.load({ reset: true })
  },

  toggleDetails(e) {
    const index = Number(e.currentTarget.dataset.index)
    const profile = this.data.profiles[index]
    if (!profile) return
    this.setData({ [`profiles[${index}].expanded`]: !profile.expanded })
  },

  detail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/admin/staff-audit/detail/index?id=${id}` })
  },

  toggleFeatured(e) {
    const staffProfileId = e.currentTarget.dataset.id
    const currentFeatured = e.currentTarget.dataset.featured === true || e.currentTarget.dataset.featured === 'true'
    const isFeatured = !currentFeatured
    if (!staffProfileId) return
    wx.showModal({
      title: isFeatured ? '设为精选宠托师' : '取消精选宠托师',
      content: isFeatured ? '精选宠托师会在前台列表所有排序中优先展示。' : '取消后将按普通排序展示。',
      success: (res) => {
        if (!res.confirm) return
        callFunction('admin', 'setSitterFeatured', { staffProfileId, isFeatured })
          .then(() => {
            wx.showToast({ title: isFeatured ? '已设为精选' : '已取消精选' })
            this.load({ reset: true })
          })
          .catch(showError)
      }
    })
  },

  revokeStaff(e) {
    const staffProfileId = e.currentTarget.dataset.id
    if (!staffProfileId) return
    wx.showModal({
      title: '移除宠托师身份',
      content: '确认后该用户会失去宠托师角色和接单资格；再次申请需重新审核、答题、观看培训视频并通过视频审核。',
      confirmText: '确认移除',
      confirmColor: '#ef4444',
      success: (res) => {
        if (!res.confirm) return
        callFunction('admin', 'revokeStaff', { staffProfileId })
          .then(() => {
            wx.showToast({ title: '已移除身份' })
            this.load({ reset: true })
          })
          .catch(showError)
      }
    })
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    const pages = getCurrentPages()
    const current = pages[pages.length - 1]
    const currentRoute = current && current.route ? '/' + current.route : ''
    if (currentRoute === url) return
    const mainNavUrls = ['/pages/admin/home/index', '/pages/admin/orders/list/index', '/pages/admin/staff-audit/list/index', '/pages/admin/incidents/list/index', '/pages/admin/coupons/index', '/pages/admin/member-levels/index', '/pages/admin/checkin-config/index', '/pages/admin/points/index', '/pages/admin/settings/index']
    const method = mainNavUrls.includes(url) ? 'redirectTo' : 'navigateTo'
    wx[method]({ url })
  }
})
