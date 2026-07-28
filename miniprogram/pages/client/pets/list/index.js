const { callFunction, showError } = require('../../../../utils/cloud')
Page({
  data: { pets: [] },
  onShow() { this.load() },
  load() { callFunction('pet', 'listPets').then((pets) => this.setData({ pets })).catch(showError) },
  create() { wx.navigateTo({ url: '/pages/client/pets/edit/index' }) },
  edit(e) { wx.navigateTo({ url: '/pages/client/pets/edit/index?id=' + e.currentTarget.dataset.id }) }
})
