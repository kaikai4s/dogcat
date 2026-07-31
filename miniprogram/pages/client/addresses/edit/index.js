const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { chooseSelectedLocation } = require('../../../../utils/cloud')
const { ensureLogin } = require('../../../../utils/cloud')

Page({
  data: {
    id: '',
    initialized: false,
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
  },

  onShow() {
    ensureLogin({ content: '登录后可编辑常用地址。' })
      .then(() => {
        if (this.data.initialized) return
        this.setData({ initialized: true })
        if (this.data.id) this.load(this.data.id)
        else this.prepareNewAddressDefault()
      })
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
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
    chooseSelectedLocation()
      .then((loc) => {
        this.setData({
          ['form.serviceAddress']: loc.name || loc.address || '',
          ['form.latitude']: loc.latitude,
          ['form.longitude']: loc.longitude
        })
      })
      .catch(showError)
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
