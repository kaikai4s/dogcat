const { callFunction, showError } = require('../../../../utils/cloud')
Page({
  data: { pets: [], form: { petId: '', serviceType: 'walk', serviceAddress: '', startTime: '', endTime: '' }, quote: null },
  onShow() { callFunction('pet', 'listPets').then((pets) => this.setData({ pets, ['form.petId']: pets[0]?._id || '' })).catch(showError) },
  input(e) { this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value }) },
  choosePet(e) { this.setData({ ['form.petId']: this.data.pets[e.detail.value]._id }) },
  chooseType(e) { this.setData({ ['form.serviceType']: e.currentTarget.dataset.type }) },
  quoteOrder() { callFunction('order', 'quoteOrder', this.data.form).then((quote) => this.setData({ quote })).catch(showError) },
  create() { callFunction('order', 'createOrder', this.data.form).then((order) => wx.redirectTo({ url: '/pages/client/orders/detail/index?id=' + order._id })).catch(showError) }
})
