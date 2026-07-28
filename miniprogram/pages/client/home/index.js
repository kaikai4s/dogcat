Page({
  go(e) { wx.navigateTo({ url: e.currentTarget.dataset.url }) },
  switchRole() { wx.redirectTo({ url: '/pages/role-select/index' }) }
})
