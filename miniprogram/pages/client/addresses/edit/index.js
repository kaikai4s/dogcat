const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { chooseSelectedLocation } = require('../../../../utils/cloud')
const { ensureLogin } = require('../../../../utils/cloud')
function locationCity(point = {}) {
  if (point.city) return String(point.city).trim()
  const text = `${point.address || ''}${point.name || ''}`
  return text.match(/北京市|上海市|天津市|重庆市|香港特别行政区|澳门特别行政区/)?.[0] ||
    text.match(/(?:.*省|.*自治区)?([^省自治区特别行政区]{2,20}市|[^省自治区特别行政区]{2,20}自治州|[^省自治区特别行政区]{2,20}地区|[^省自治区特别行政区]{2,20}盟)/)?.[1] || ''
}

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
      city: '',
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
    const seq = this._locationSeq = (this._locationSeq || 0) + 1
    return callFunction('client', 'listAddresses')
      .then((addresses) => {
        if (this._closed || seq !== this._locationSeq) return
        const address = addresses.find((item) => item._id === id)
        if (address) this.setData({ form: { ...this.data.form, ...address } })
      })
      .catch(error => { if (!this._closed && seq === this._locationSeq) showError(error) })
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
    if (this._closed) return
    const seq = this._locationSeq = (this._locationSeq || 0) + 1
    return chooseSelectedLocation()
      .then((loc) => {
        if (this._closed || seq !== this._locationSeq) return
        this.setData({
          ['form.serviceAddress']: loc.name || loc.address || '',
          ['form.city']: locationCity(loc),
          ['form.latitude']: loc.latitude,
          ['form.longitude']: loc.longitude
        })
      })
      .catch(error => { if (!this._closed && seq === this._locationSeq) showError(error) })
  },

  onUnload() { this._closed = true; this._locationSeq = (this._locationSeq || 0) + 1 },

  save() {
    const form = this.data.form
    if (!form.serviceAddress) {
      wx.showToast({ title: '请选择服务地址', icon: 'none' })
      return
    }
    if (!form.latitude || !form.longitude || (Number(form.latitude) === 0 && Number(form.longitude) === 0)) {
      wx.showToast({ title: '请点击定位选择地图位置', icon: 'none' })
      return
    }
    if (!form.addressDetail) {
      wx.showToast({ title: '请填写详细地址', icon: 'none' })
      return
    }
    if (!form.doorplate) {
      wx.showToast({ title: '请填写门牌号或入户说明', icon: 'none' })
      return
    }
    callFunction('client', 'saveAddress', { ...form, id: this.data.id })
      .then(() => {
        wx.showToast({ title: '已保存' })
        wx.navigateBack()
      })
      .catch(showError)
  },

  ...navMethods()
})
