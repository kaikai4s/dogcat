const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { ensureLogin } = require('../../../../utils/cloud')

Page({
  data: { pets: [], sectionHomeUrl: '', canGoBack: false },
  onLoad(query) { this.setData(createPageNav(query)) },
  onShow() {
    ensureLogin({ content: '登录后可管理宠物档案。' })
      .then(() => this.load())
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },
  load() { callFunction('pet', 'listPets').then((pets) => this.setData({ pets })).catch(showError) },
  create() { wx.navigateTo({ url: '/pages/client/pets/edit/index' }) },
  edit(e) { wx.navigateTo({ url: '/pages/client/pets/edit/index?id=' + e.currentTarget.dataset.id }) },
  ...navMethods()
})
