const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')

Page({
  data: { pets: [], sectionHomeUrl: '', canGoBack: false },
  onLoad(query) { this.setData(createPageNav(query)) },
  onShow() { this.load() },
  load() { callFunction('pet', 'listPets').then((pets) => this.setData({ pets })).catch(showError) },
  create() { wx.navigateTo({ url: '/pages/client/pets/edit/index' }) },
  edit(e) { wx.navigateTo({ url: '/pages/client/pets/edit/index?id=' + e.currentTarget.dataset.id }) },
  ...navMethods()
})
