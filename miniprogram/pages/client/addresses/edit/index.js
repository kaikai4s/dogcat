const { callFunction, showError } = require('../../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../../utils/nav')

Page({
  data: {
    id: '',
    sectionHomeUrl: '',
    canGoBack: false,
    form: {
      label: '家',
      contactName: '',
      contactPhone: '',
      serviceAddress: '',
      addressDetail: '',
      doorplate: '',
      latitude: 0,
      longitude: 0,
      isDefault: false
    }
  },

  onLoad(query) {
    const id = query.id || ''
    this.setData({ ...createPageNav(query), id })
    if (id) this.load(id)
    else this.prepareNewAddressDefault()
  },

  load(id) {
    callFunction('client', 'listAddresses')
      .then((addresses) => {
        const address = addresses.find((item) => item._id === id)
        if (address) this.setData({ form: { ...this.data.form, ...address } })
      })
      .catch(showError)
  },

  prepareNewAddressDefault() {
    callFunction('client', 'listAddresses')
      .then((addresses) => {
        if (!addresses.length) this.setData({ ['form.isDefault']: true })
      })
      .catch(() => {})
  },

  input(e) {
    this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value })
  },

  toggleDefault(e) {
    this.setData({ ['form.isDefault']: e.detail.value })
  },

  chooseLocation() {
    wx.chooseLocation({
      success: (loc) => {
        this.setData({
          ['form.serviceAddress']: loc.name || loc.address || '',
          ['form.latitude']: loc.latitude,
          ['form.longitude']: loc.longitude
        })
      },
      fail: showError
    })
  },

  save() {
    const form = this.data.form
    callFunction('client', 'saveAddress', { ...form, id: this.data.id })
      .then(() => {
        wx.showToast({ title: '已保存' })
        wx.navigateBack()
      })
      .catch(showError)
  },

  ...navMethods()
})
