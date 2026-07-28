const { callFunction, showError } = require('../../../../utils/cloud')
Page({
  data: { id: '', form: { species: 'dog', name: '', breed: '', weight: '', specialNotes: '' } },
  onLoad(query) { if (query.id) { this.setData({ id: query.id }); callFunction('pet', 'getPet', { id: query.id }).then((form) => this.setData({ form })).catch(showError) } },
  input(e) { this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value }) },
  save() { const action = this.data.id ? 'updatePet' : 'createPet'; const data = { ...this.data.form, id: this.data.id }; callFunction('pet', action, data).then(() => { wx.showToast({ title: '已保存' }); wx.navigateBack() }).catch(showError) }
})
