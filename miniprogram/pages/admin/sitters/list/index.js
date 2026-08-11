const { callFunction, showError } = require('../../../../utils/cloud')

const statusTabs = [
  { label: '全部', value: '' },
  { label: '已通过', value: 'approved' },
  { label: '待审核', value: 'pending' },
  { label: '未通过', value: 'rejected' }
]

function withDisplay(profile) {
  const reviewCount = Number(profile.reviewCount || 0)
  return {
    ...profile,
    reviewCount,
    ratingText: reviewCount ? `${Number(profile.ratingAverage || 0)}分 / ${reviewCount}条评价` : '暂无评分',
    featuredActionText: profile.isFeatured ? '取消精选' : '设为精选',
    actionText: profile.auditStatus === 'pending' ? '去审核' : '查看资料',
    avatarText: (profile.userNickname || profile.realName || '托').slice(0, 1)
  }
}

Page({
  data: {
    profiles: [],
    keyword: '',
    auditStatus: '',
    statusTabs,
    loading: false
  },

  onShow() {
    this.load()
  },

  load() {
    this.setData({ loading: true })
    callFunction('admin', 'listStaffProfiles', { keyword: this.data.keyword, auditStatus: this.data.auditStatus })
      .then((profiles) => this.setData({ profiles: profiles.map(withDisplay), loading: false }))
      .catch((err) => {
        this.setData({ loading: false })
        showError(err)
      })
  },

  inputKeyword(e) {
    this.setData({ keyword: e.detail.value })
  },

  search() {
    this.load()
  },

  switchStatus(e) {
    this.setData({ auditStatus: e.currentTarget.dataset.value || '' })
    this.load()
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
            this.load()
          })
          .catch(showError)
      }
    })
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  }
})
