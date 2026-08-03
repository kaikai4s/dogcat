const { callFunction, showError } = require('../../../../utils/cloud')

const statusTabs = [
  { label: '全部', value: '' },
  { label: '已通过', value: 'approved' },
  { label: '待审核', value: 'pending' },
  { label: '未通过', value: 'rejected' }
]

function withDisplay(profile) {
  return {
    ...profile,
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

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  }
})
