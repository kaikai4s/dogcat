const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')

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
    requestedSitter: null,
    saveAddress: false,
    locationReady: false,
    locationTip: '',
    sectionHomeUrl: '',
    canGoBack: false
  },

  onLoad(options) {
    this.setData(createPageNav(options))
    const publishMode = options.publishMode === 'direct' ? 'direct' : 'open'
    const staffProfileId = options.staffProfileId || ''
    this.setData({ ['form.publishMode']: publishMode, ['form.staffProfileId']: staffProfileId })
    if (publishMode === 'direct' && staffProfileId) this.loadRequestedSitter(staffProfileId)
    if (options.rebookOrderId) this.loadRebook(options.rebookOrderId)
    else this.loadDefaultAddress()
  },

  onShow() {
    this.prepareTime()
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
          ['form.petId']: pets[0]?._id || '',
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
      })
      .catch(() => {})
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
    wx.navigateTo({ url: '/pages/client/addresses/list/index?select=1' })
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
    wx.chooseLocation({
      success: (loc) => {
        this.setData({
          ['form.serviceAddress']: loc.name || loc.address || this.data.form.serviceAddress,
          ['form.addressLatitude']: loc.latitude,
          ['form.addressLongitude']: loc.longitude,
          locationReady: true,
          locationTip: loc.address || '已选择服务位置',
          quote: null
        })
        wx.showToast({ title: '已选择位置' })
      },
      fail: showError
    })
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

  quoteOrder() {
    this.prepareTime()
    const error = this.validateRequired()
    if (error) {
      wx.showToast({ title: error, icon: 'none' })
      return
    }
    callFunction('order', 'quoteOrder', this.data.form)
      .then((quote) => this.setData({ quote }))
      .catch(showError)
  },

  create() {
    this.prepareTime()
    const error = this.validateRequired()
    if (error) {
      wx.showToast({ title: error, icon: 'none' })
      return
    }
    callFunction('order', 'createOrder', this.data.form)
      .then((order) => {
        const redirect = () => wx.redirectTo({ url: '/pages/client/orders/detail/index?id=' + order._id })
        if (!this.data.saveAddress) {
          redirect()
          return
        }
        callFunction('client', 'saveAddress', {
          label: '预约地址',
          serviceAddress: this.data.form.serviceAddress,
          addressDetail: this.data.form.addressDetail,
          doorplate: this.data.form.doorplate,
          latitude: this.data.form.addressLatitude,
          longitude: this.data.form.addressLongitude,
          isDefault: true
        })
          .then(() => {
            wx.showToast({ title: '已保存常用地址' })
            setTimeout(redirect, 500)
          })
          .catch((error) => {
            wx.showModal({
              title: '订单已创建',
              content: `但常用地址保存失败：${error.message || '请稍后在我的地址中手动添加'}`,
              showCancel: false,
              success: redirect
            })
          })
      })
      .catch(showError)
  },

  ...navMethods()
})
