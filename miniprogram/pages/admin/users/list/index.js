const { callFunction, showError } = require('../../../../utils/cloud')

const roleTabs = [
  { label: '全部', value: '' },
  { label: '用户', value: 'client' },
  { label: '宠托师', value: 'staff' },
  { label: '管理员', value: 'admin' }
]

function withDisplay(user) {
  return {
    ...user,
    avatarText: (user.nickname || '用').slice(0, 1)
  }
}

Page({
  data: {
    users: [],
    keyword: '',
    role: '',
    roleTabs,
    loading: false
  },

  onShow() {
    this.load()
  },

  load() {
    this.setData({ loading: true })
    callFunction('admin', 'listUsers', { keyword: this.data.keyword, role: this.data.role })
      .then((users) => this.setData({ users: users.map(withDisplay), loading: false }))
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

  switchRole(e) {
    this.setData({ role: e.currentTarget.dataset.value || '' })
    this.load()
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  }
})
