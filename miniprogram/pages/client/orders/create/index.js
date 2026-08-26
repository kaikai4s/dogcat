const { callFunction, showError, requestSubscribeTemplates, loadSystemSettings } = require('../../../../utils/cloud')
const { createClientRequestId } = require('../../../../utils/offlineQueue')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { getSelectedLocation, chooseSelectedLocation } = require('../../../../utils/cloud')
const { ensureLogin } = require('../../../../utils/cloud')
const { applyTheme, getThemeState } = require('../../../../utils/theme')

const COUPON_CONTEXT_KEY = 'vip_pet_coupon_select_context'
const SELECTED_COUPON_KEY = 'vip_pet_selected_coupon'

const durationOptions = [
  { label: '30分钟', value: 30 },
  { label: '60分钟', value: 60 },
  { label: '90分钟', value: 90 },
  { label: '120分钟', value: 120 },
  { label: '180分钟', value: 180 }
]

const lockMethodOptions = [
  { label: '有人在家', value: 'someone_home', desc: '宠托师到达后敲门即可' },
  { label: '远程开门', value: 'remote_unlock', desc: '到达后请求你远程开门' },
  { label: '一次性密码', value: 'one_time_code', desc: '设置本单专用密码和有效期' },
  { label: '钥匙', value: 'key', desc: '说明钥匙位置并上传图片' }
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

function formatDateTime(date) {
  return `${formatDate(date)} ${formatTime(date)}`
}

function parseDateTime(value) {
  const date = new Date(String(value || '').replace(' ', 'T'))
  return Number.isNaN(date.getTime()) ? null : date
}

function coversServiceTime(startTime, endTime, effectiveStart, effectiveEnd) {
  const start = parseDateTime(startTime)
  const end = parseDateTime(endTime)
  const coverStart = parseDateTime(effectiveStart)
  const coverEnd = parseDateTime(effectiveEnd)
  return Boolean(start && end && coverStart && coverEnd && coverStart <= start && coverEnd >= end)
}

function markSelected(options, selected) {
  return options.map((item) => ({ ...item, selected: selected.includes(item.key) }))
}

function getSpeciesLabel(species) {
  if (species === 'cat') return '猫咪'
  if (species === 'other') return '其他宠物'
  return '狗狗'
}

function formatPetMeta(pet) {
  if (!pet) return ''
  const parts = [getSpeciesLabel(pet.species)]
  if (pet.breed) parts.push(pet.breed)
  if (pet.weight) parts.push(`${pet.weight}kg`)
  return parts.join(' · ')
}

function formatPetHint(pet) {
  if (!pet) return ''
  return pet.personality || pet.specialNotes || pet.healthNotes || '今天也想和你一起安心出门'
}

function getVoiceWeekday(startDate) {
  const date = new Date(`${startDate}T00:00:00`)
  if (Number.isNaN(date.getTime())) return new Date().getDay()
  return date.getDay()
}

function buildPetVoiceMessage(pet, startDate) {
  if (!pet) return ''
  const name = pet.name || '我'
  const species = getSpeciesLabel(pet.species)
  const messages = [
    `主人主人，周日我想和你贴贴放松，预约好服务后你就安心休息吧～`,
    `主人，周一你要加油工作哦，我会乖乖等宠托师来陪我的！`,
    `主人，周二我也在想你呢，等我玩开心了就回去抱你～`,
    `主人，周三快过半啦，今天也要记得想我这个快乐${species}哦！`,
    `主人，周四我都准备好啦，你帮我安排的服务最贴心了～`,
    `我是${name}，周五马上放假啦！主人今晚要早点回家陪我玩哦！`,
    `主人，周六又是美好的一天，谢谢你帮我找了帮手照顾我～`
  ]
  return messages[getVoiceWeekday(startDate)]
}

function decoratePets(pets, selectedPetId) {
  return (pets || []).map((pet) => ({
    ...pet,
    selected: pet._id === selectedPetId,
    metaText: formatPetMeta(pet),
    hintText: formatPetHint(pet),
    speciesText: getSpeciesLabel(pet.species)
  }))
}

Page({
  data: {
    themeClass: 'theme-day',
    user: null,
    pets: [],
    serviceOptions: [],
    durationOptions,
    lockMethodOptions,
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
      lockMethod: 'someone_home',
      doorLockCode: '',
      doorLockCodeStartDate: formatDate(new Date()),
      doorLockCodeStartClock: '09:30',
      doorLockCodeEndDate: formatDate(new Date()),
      doorLockCodeEndClock: '12:00',
      doorLockCodeStartTime: '',
      doorLockCodeEndTime: '',
      keyLocation: '',
      keyImageFileIds: [],
      entryNotes: '',
      startDate: formatDate(new Date()),
      startClock: '10:00',
      startTime: '',
      endTime: '',
      durationMinutes: 60,
      addressLatitude: 0,
      addressLongitude: 0
    },
    quote: null,
    securityCoverageText: '',
    securityCoverageOk: true,
    uploadingKeyImage: false,
    selectedCouponId: '',
    selectedCoupon: null,
    selectedPet: null,
    petVoiceMessage: '',
    requestedSitter: null,
    sitterAvailability: [],
    selectedAvailability: null,
    saveAddress: false,
    creating: false,
    locationReady: false,
    locationTip: '',
    initialized: false,
    pendingOptions: {},
    sectionHomeUrl: '',
    canGoBack: false,
    minDate: formatDate(new Date()),
    minClock: ''
  },

  onLoad(options) {
    loadSystemSettings().catch(() => null)
    this.setData({ ...createPageNav(options), pendingOptions: options || {} })
    const publishMode = options.publishMode === 'direct' ? 'direct' : 'open'
    const staffProfileId = options.staffProfileId || ''
    this.setData({ ['form.publishMode']: publishMode, ['form.staffProfileId']: staffProfileId })
  },

  onShow() {
    this.applyCurrentTheme()
    this.consumeSelectedCoupon()
    this.updateMinTime()
    ensureLogin({ content: '登录后可创建预约订单。' })
      .then((user) => {
        this.setData({ user })
        return this.loadPageData()
      })
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },

  updateMinTime() {
    const today = formatDate(new Date())
    const minClock = this.data.form.startDate === today ? formatTime(new Date()) : ''
    this.setData({ minDate: today, minClock })
  },

  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
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
        const petId = this.data.form.petId || pets[0]?._id || ''
        this.setData({
          pets: decoratePets(pets, petId),
          serviceOptions: markSelected(enabled, serviceTypes),
          ['form.petId']: petId,
          ['form.serviceTypes']: serviceTypes,
          ['form.serviceType']: serviceTypes[0]
        }, this.syncSelectedPetUI)
      })
      .catch(showError)
  },

  prepareTime() {
    const { startDate, startClock, durationMinutes, doorLockCodeStartDate, doorLockCodeStartClock, doorLockCodeEndDate, doorLockCodeEndClock } = this.data.form
    const startTime = `${startDate} ${startClock}`
    const endTime = addMinutes(startDate, startClock, durationMinutes)
    const doorLockCodeStartTime = `${doorLockCodeStartDate || startDate} ${doorLockCodeStartClock || startClock}`
    const doorLockCodeEndTime = `${doorLockCodeEndDate || startDate} ${doorLockCodeEndClock || formatTime(parseDateTime(endTime) || new Date())}`
    this.setData({ ['form.startTime']: startTime, ['form.endTime']: endTime, ['form.doorLockCodeStartTime']: doorLockCodeStartTime, ['form.doorLockCodeEndTime']: doorLockCodeEndTime }, this.syncSecurityCoverage)
  },

  syncSecurityCoverage() {
    const form = this.data.form
    if (form.lockMethod !== 'one_time_code') {
      this.setData({ securityCoverageText: '', securityCoverageOk: true })
      return
    }
    const ok = coversServiceTime(form.startTime, form.endTime, form.doorLockCodeStartTime, form.doorLockCodeEndTime)
    this.setData({
      securityCoverageOk: ok,
      securityCoverageText: ok ? '一次性密码有效期已覆盖全程服务时间' : '一次性密码有效期未覆盖全程服务时间，请调整后再下单'
    })
  },

  input(e) {
    this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value, quote: null })
  },

  choosePublishMode(e) {
    const publishMode = e.currentTarget.dataset.mode
    if (publishMode === 'open') {
      this.setData({ ['form.publishMode']: 'open', ['form.staffProfileId']: '', requestedSitter: null, sitterAvailability: [], selectedAvailability: null, quote: null })
      return
    }
    this.setData({ ['form.publishMode']: 'direct', quote: null })
    if (!this.data.form.staffProfileId) this.chooseSitter()
  },

  chooseSitter() {
    wx.navigateTo({ url: '/pages/client/sitters/list/index' })
  },

  loadRequestedSitter(staffProfileId) {
    Promise.all([
      callFunction('staff', 'getPublicSitterDetail', { staffProfileId }),
      callFunction('staff', 'listScheduleAvailability', { staffProfileId, days: 14 })
    ])
      .then(([requestedSitter, availability]) => {
        this.setData({ requestedSitter, sitterAvailability: availability || [] }, this.syncSelectedAvailability)
      })
      .catch(showError)
  },

  syncSelectedAvailability() {
    const selected = (this.data.sitterAvailability || []).find((item) => item.dateKey === this.data.form.startDate) || null
    const slotText = selected && Array.isArray(selected.slots) && selected.slots.length
      ? selected.slots.map((slot) => `${String(slot.start).padStart(2, '0')}:00-${String(slot.end).padStart(2, '0')}:00`).join('、')
      : ''
    this.setData({ selectedAvailability: selected ? { ...selected, slotText } : null })
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
          this.syncSelectedPetUI()
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

  chooseLockMethod(e) {
    const lockMethod = e.currentTarget.dataset.value || 'someone_home'
    this.setData({ ['form.lockMethod']: lockMethod, quote: null }, this.syncSecurityCoverage)
  },

  chooseCodeStartDate(e) {
    this.setData({ ['form.doorLockCodeStartDate']: e.detail.value, quote: null }, this.prepareTime)
  },

  chooseCodeStartClock(e) {
    this.setData({ ['form.doorLockCodeStartClock']: e.detail.value, quote: null }, this.prepareTime)
  },

  chooseCodeEndDate(e) {
    this.setData({ ['form.doorLockCodeEndDate']: e.detail.value, quote: null }, this.prepareTime)
  },

  chooseCodeEndClock(e) {
    this.setData({ ['form.doorLockCodeEndClock']: e.detail.value, quote: null }, this.prepareTime)
  },

  chooseKeyImage() {
    if (this.data.uploadingKeyImage) return
    wx.chooseMedia({
      count: 3,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const files = res.tempFiles || []
        if (!files.length) return
        this.setData({ uploadingKeyImage: true })
        Promise.all(files.map((file) => new Promise((resolve, reject) => {
          const tempFilePath = file.tempFilePath
          const ext = tempFilePath.includes('.') ? tempFilePath.slice(tempFilePath.lastIndexOf('.')) : '.jpg'
          wx.cloud.uploadFile({ cloudPath: `home_security_keys/${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`, filePath: tempFilePath, success: resolve, fail: reject })
        }))).then((uploads) => {
          const ids = uploads.map((item) => item.fileID).filter(Boolean)
          this.setData({ ['form.keyImageFileIds']: [...this.data.form.keyImageFileIds, ...ids], uploadingKeyImage: false, quote: null })
        }).catch((error) => {
          this.setData({ uploadingKeyImage: false })
          showError(error)
        })
      },
      fail: showError
    })
  },

  removeKeyImage(e) {
    const index = Number(e.currentTarget.dataset.index)
    const ids = this.data.form.keyImageFileIds.slice()
    ids.splice(index, 1)
    this.setData({ ['form.keyImageFileIds']: ids, quote: null })
  },

  syncSelectedPetUI() {
    const petId = this.data.form.petId
    const pets = decoratePets(this.data.pets, petId)
    const selectedPet = pets.find((item) => item._id === petId) || null
    this.setData({
      pets,
      selectedPet,
      petVoiceMessage: buildPetVoiceMessage(selectedPet, this.data.form.startDate)
    })
  },

  choosePet(e) {
    const petId = e.currentTarget.dataset.id
    if (!petId) return
    this.setData({ ['form.petId']: petId, quote: null }, this.syncSelectedPetUI)
  },

  addPet() {
    wx.navigateTo({ url: '/pages/client/pets/edit/index' })
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
    this.setData({ ['form.startDate']: e.detail.value, quote: null }, () => {
      this.updateMinTime()
      this.prepareTime()
      this.syncSelectedPetUI()
      this.syncSelectedAvailability()
    })
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
    if (!this.data.user || !String(this.data.user.phone || '').trim()) return '请先绑定手机号'
    if (!form.petId) return '请先选择宠物'
    if (!form.serviceTypes.length) return '请选择服务项目'
    if (form.publishMode === 'direct' && !form.staffProfileId) return '请选择指定宠托师'
    if (!form.serviceAddress) return '请选择服务地址'
    if (!form.addressDetail) return '请填写详细地址'
    if (!form.doorplate) return '请填写门牌号或入户说明'
    if (!form.lockMethod) return '请选择入户与门锁方式'
    if (form.lockMethod === 'one_time_code' && !String(form.doorLockCode || '').trim()) return '请填写一次性开门密码'
    if (form.lockMethod === 'one_time_code' && !coversServiceTime(form.startTime, form.endTime, form.doorLockCodeStartTime, form.doorLockCodeEndTime)) return '一次性密码有效期需要覆盖完整服务时间'
    if (form.lockMethod === 'key' && !String(form.keyLocation || '').trim()) return '请填写钥匙放置位置'
    if (form.lockMethod === 'key' && !(form.keyImageFileIds || []).length) return '请上传钥匙放置位置图片'
    if (!form.startDate || !form.startClock) return '请选择开始时间'
    const start = parseDateTime(form.startTime)
    if (!start || start.getTime() < Date.now()) return '服务开始时间不能早于当前时间'
    return ''
  },

  buildOrderPayload() {
    const form = this.data.form
    const orderHomeSecurity = {
      type: form.lockMethod,
      entryNotes: form.entryNotes,
      doorLockCode: form.doorLockCode,
      effectiveStart: form.doorLockCodeStartTime,
      effectiveEnd: form.doorLockCodeEndTime,
      location: form.keyLocation,
      imageFileIds: form.keyImageFileIds
    }
    return {
      ...form,
      orderHomeSecurity,
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
    if (this.creatingOrder || this.data.creating) return
    this.creatingOrder = true
    this.setData({ creating: true })
    this.prepareTime()
    const error = this.validateRequired()
    if (error) {
      this.creatingOrder = false
      this.setData({ creating: false })
      wx.showToast({ title: error, icon: 'none' })
      return
    }
    const clientRequestId = createClientRequestId('create_order')
    requestSubscribeTemplates(['orderAccepted', 'serviceStart', 'remoteUnlock'], 'client_create_order')
      .then(() => callFunction('order', 'createOrder', { ...this.buildOrderPayload(), saveAddress: this.data.saveAddress, clientRequestId }))
      .then((order) => {
        if (this.data.saveAddress && order.savedAddress) wx.showToast({ title: '已保存常用地址' })
        wx.redirectTo({ url: '/pages/client/orders/detail/index?id=' + order._id })
      })
      .catch((error) => {
        this.creatingOrder = false
        this.setData({ creating: false })
        showError(error)
      })
  },

  ...navMethods()
})
