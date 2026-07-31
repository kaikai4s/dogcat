const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { getSelectedLocation, chooseSelectedLocation } = require('../../../../utils/cloud')
const { ensureLogin } = require('../../../../utils/cloud')

const COUPON_CONTEXT_KEY = 'vip_pet_coupon_select_context'
const SELECTED_COUPON_KEY = 'vip_pet_selected_coupon'

const durationOptions = [
  { label: '30分钟', value: 30 },
  { label: '60分钟', value: 60 },
  { label: '90分钟', value: 90 },
  { label: '120分钟', value: 120 },
  { label: '180分钟', value: 180 }
]

function formatDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatTime(date) {
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${hour}:${minute}`
}

function addMinutes(startDate, startClock, minutes) {
  const start = new Date(`${startDate}T${startClock}:00`)
  if (Number.isNaN(start.getTime())) return ''
  const end = new Date(start.getTime() + Number(minutes) * 60 * 1000)
  return `${formatDate(end)} ${formatTime(end)}`
}

function markSelected(options, selected) {
  return options.map((item) => ({ ...item, selected: selected.includes(item.key) }))
}

Page({
  data: {
    pets: [],
    serviceOptions: [],
    durationOptions,
    durationIndex: 1,
    form: {
      petId: '',
      serviceType: 'walk',
      serviceTypes: ['walk'],
      serviceAddress: '',
      publishMode: 'open',
      staffProfileId: '',
      addressDetail: '',
      doorplate: '',
      startDate: formatDate(new Date()),
      startClock: '10:00',
      startTime: '',
      endTime: '',
      durationMinutes: 60,
      addressLatitude: 0,
      addressLongitude: 0
    },
    quote: null,
    selectedCouponId: '',
    selectedCoupon: null,
    requestedSitter: null,
    saveAddress: false,
    locationReady: false,
    locationTip: '',
    initialized: false,
    pendingOptions: {},
    sectionHomeUrl: '',
    canGoBack: false
  },

  onLoad(options) {
    this.setData({ ...createPageNav(options), pendingOptions: options || {} })
    const publishMode = options.publishMode === 'direct' ? 'direct' : 'open'
    const staffProfileId = options.staffProfileId || ''
    this.setData({ ['form.publishMode']: publishMode, ['form.staffProfileId']: staffProfileId })
  },

  onShow() {
    this.consumeSelectedCoupon()
    ensureLogin({ content: '登录后可创建预约订单。' })
      .then(() => this.loadPageData())
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },

  consumeSelectedCoupon() {
    const selected = wx.getStorageSync(SELECTED_COUPON_KEY)
    if (!selected) return
    wx.removeStorageSync(SELECTED_COUPON_KEY)
    if (selected.clear) {
      this.setData({ selectedCouponId: '', selectedCoupon: null, quote: null })
      return
    }
    this.setData({ selectedCouponId: selected._id, selectedCoupon: selected, quote: null })
  },

  loadPageData() {
    this.prepareTime()
    const options = this.data.pendingOptions || {}
    if (!this.data.initialized) {
      this.setData({ initialized: true })
      if (this.data.form.publishMode === 'direct' && this.data.form.staffProfileId) this.loadRequestedSitter(this.data.form.staffProfileId)
      if (options.rebookOrderId) this.loadRebook(options.rebookOrderId)
      else this.loadDefaultAddress()
    }
    Promise.all([
      callFunction('pet', 'listPets'),
      callFunction('order', 'listServiceOptions')
    ])
      .then(([pets, serviceOptions]) => {
        const enabled = serviceOptions || []
        const selected = this.data.form.serviceTypes.filter((key) => enabled.some((item) => item.key === key))
        const serviceTypes = selected.length ? selected : [enabled[0]?.key || 'walk']
        this.setData({
          pets,
          serviceOptions: markSelected(enabled, serviceTypes),
          ['form.petId']: this.data.form.petId || pets[0]?._id || '',
          ['form.serviceTypes']: serviceTypes,
          ['form.serviceType']: serviceTypes[0]
        })
      })
      .catch(showError)
  },

  prepareTime() {
    const { startDate, startClock, durationMinutes } = this.data.form
    const startTime = `${startDate} ${startClock}`
    const endTime = addMinutes(startDate, startClock, durationMinutes)
    this.setData({ ['form.startTime']: startTime, ['form.endTime']: endTime })
  },

  input(e) {
    this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value, quote: null })
  },

  choosePublishMode(e) {
    const publishMode = e.currentTarget.dataset.mode
    if (publishMode === 'open') {
      this.setData({ ['form.publishMode']: 'open', ['form.staffProfileId']: '', requestedSitter: null, quote: null })
      return
    }
    this.setData({ ['form.publishMode']: 'direct', quote: null })
    if (!this.data.form.staffProfileId) this.chooseSitter()
  },

  chooseSitter() {
    wx.navigateTo({ url: '/pages/client/sitters/list/index' })
  },

  loadRequestedSitter(staffProfileId) {
    callFunction('staff', 'getPublicSitterDetail', { staffProfileId })
      .then((requestedSitter) => this.setData({ requestedSitter }))
      .catch(showError)
  },

  loadDefaultAddress() {
    callFunction('client', 'listAddresses')
      .then((addresses) => {
        const address = addresses.find((item) => item.isDefault)
        if (address) this.applyAddress(address)
        else this.applySelectedLocation()
      })
      .catch(() => this.applySelectedLocation())
  },

  applySelectedLocation() {
    const location = getSelectedLocation()
    if (!location) return
    this.setData({
      ['form.serviceAddress']: location.name || location.address || '',
      ['form.addressLatitude']: location.latitude,
      ['form.addressLongitude']: location.longitude,
      locationReady: true,
      locationTip: location.address || '已使用首页选择的位置',
      quote: null
    })
  },

  loadRebook(orderId) {
    callFunction('order', 'prepareRebook', { orderId })
      .then((template) => {
        const update = {
          ['form.sourceOrderId']: template.sourceOrderId,
          ['form.petId']: template.petId,
          ['form.serviceType']: template.serviceType,
          ['form.serviceTypes']: template.serviceTypes,
          ['form.serviceAddress']: template.serviceAddress,
          ['form.addressDetail']: template.addressDetail,
          ['form.doorplate']: template.doorplate,
          ['form.addressLatitude']: template.addressLatitude,
          ['form.addressLongitude']: template.addressLongitude,
          ['form.durationMinutes']: template.durationMinutes,
          ['form.publishMode']: template.publishMode,
          ['form.staffProfileId']: template.staffProfileId,
          locationReady: Boolean(template.serviceAddress),
          locationTip: '已从历史订单带入地址',
          serviceOptions: markSelected(this.data.serviceOptions, template.serviceTypes),
          quote: null
        }
        const durationIndex = durationOptions.findIndex((item) => item.value === template.durationMinutes)
        if (durationIndex >= 0) update.durationIndex = durationIndex
        this.setData(update, () => {
          this.prepareTime()
          if (template.staffProfileId) this.loadRequestedSitter(template.staffProfileId)
        })
      })
      .catch(showError)
  },

  applyAddress(address) {
    this.setData({
      ['form.serviceAddress']: address.serviceAddress || '',
      ['form.addressDetail']: address.addressDetail || '',
      ['form.doorplate']: address.doorplate || '',
      ['form.addressLatitude']: Number(address.latitude || address.addressLatitude || 0),
      ['form.addressLongitude']: Number(address.longitude || address.addressLongitude || 0),
      locationReady: Boolean(address.serviceAddress),
      locationTip: address.label ? `已选择常用地址：${address.label}` : '已选择常用地址',
      quote: null
    })
  },

  chooseSavedAddress() {
    wx.showToast({ title: '正在打开常用地址', icon: 'none' })
    wx.navigateTo({
      url: '/pages/client/addresses/list/index?select=1',
      fail: (error) => {
        wx.showModal({
          title: '无法打开常用地址',
          content: error.errMsg || '请重新编译小程序后再试',
          showCancel: false
        })
      }
    })
  },

  toggleSaveAddress(e) {
    this.setData({ saveAddress: e.detail.value })
  },

  choosePet(e) {
    this.setData({ ['form.petId']: this.data.pets[e.detail.value]._id, quote: null })
  },

  toggleService(e) {
    const key = e.currentTarget.dataset.key
    const selected = this.data.form.serviceTypes.slice()
    const index = selected.indexOf(key)
    if (index >= 0) selected.splice(index, 1)
    else selected.push(key)
    if (!selected.length) {
      wx.showToast({ title: '至少选择一项服务', icon: 'none' })
      return
    }
    this.setData({ ['form.serviceTypes']: selected, ['form.serviceType']: selected[0], serviceOptions: markSelected(this.data.serviceOptions, selected), quote: null })
  },

  chooseDate(e) {
    this.setData({ ['form.startDate']: e.detail.value, quote: null }, this.prepareTime)
  },

  chooseClock(e) {
    this.setData({ ['form.startClock']: e.detail.value, quote: null }, this.prepareTime)
  },

  chooseDuration(e) {
    const durationIndex = Number(e.detail.value)
    const duration = durationOptions[durationIndex]
    this.setData({ durationIndex, ['form.durationMinutes']: duration.value, quote: null }, this.prepareTime)
  },

  useCurrentLocation() {
    chooseSelectedLocation()
      .then((location) => {
        this.setData({
          ['form.serviceAddress']: location.name || location.address || this.data.form.serviceAddress,
          ['form.addressLatitude']: location.latitude,
          ['form.addressLongitude']: location.longitude,
          locationReady: true,
          locationTip: location.address || '已选择服务位置',
          quote: null
        })
        wx.showToast({ title: '已更新位置' })
      })
      .catch(showError)
  },

  validateRequired() {
    const form = this.data.form
    if (!form.petId) return '请先选择宠物'
    if (!form.serviceTypes.length) return '请选择服务项目'
    if (form.publishMode === 'direct' && !form.staffProfileId) return '请选择指定宠托师'
    if (!form.serviceAddress) return '请选择服务地址'
    if (!form.addressDetail) return '请填写详细地址'
    if (!form.doorplate) return '请填写门牌号或入户说明'
    if (!form.startDate || !form.startClock) return '请选择开始时间'
    return ''
  },

  buildOrderPayload() {
    return {
      ...this.data.form,
      couponId: this.data.selectedCouponId,
      autoApplyCoupon: !this.data.selectedCouponId
    }
  },

  chooseCoupon() {
    this.prepareTime()
    const error = this.validateRequired()
    if (error) {
      wx.showToast({ title: error, icon: 'none' })
      return
    }
    wx.setStorageSync(COUPON_CONTEXT_KEY, this.buildOrderPayload())
    wx.navigateTo({ url: `/pages/client/coupons/select/index?selectedCouponId=${this.data.selectedCouponId || ''}` })
  },

  quoteOrder() {
    this.prepareTime()
    const error = this.validateRequired()
    if (error) {
      wx.showToast({ title: error, icon: 'none' })
      return
    }
    callFunction('order', 'quoteOrder', this.buildOrderPayload())
      .then((quote) => this.setData({ quote, selectedCouponId: quote.coupon ? quote.coupon.couponId : this.data.selectedCouponId, selectedCoupon: quote.coupon || this.data.selectedCoupon }))
      .catch(showError)
  },

  create() {
    this.prepareTime()
    const error = this.validateRequired()
    if (error) {
      wx.showToast({ title: error, icon: 'none' })
      return
    }
    callFunction('order', 'createOrder', { ...this.buildOrderPayload(), saveAddress: this.data.saveAddress })
      .then((order) => {
        if (this.data.saveAddress && order.savedAddress) wx.showToast({ title: '已保存常用地址' })
        wx.redirectTo({ url: '/pages/client/orders/detail/index?id=' + order._id })
      })
      .catch(showError)
  },

  ...navMethods()
})
