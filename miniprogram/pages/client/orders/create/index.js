const { callFunction, showError, requestSubscribeTemplates, loadSystemSettings } = require('../../../../utils/cloud')
const { createClientRequestId } = require('../../../../utils/offlineQueue')
const { createPageNav, navMethods } = require('../../../../utils/nav')
const { getSelectedLocation, chooseSelectedLocation } = require('../../../../utils/cloud')
const { ensureLogin } = require('../../../../utils/cloud')
const { applyTheme, getThemeState } = require('../../../../utils/theme')
const { toBeijingDate } = require('../../../../utils/format')

const COUPON_CONTEXT_KEY = 'vip_pet_coupon_select_context'
const SELECTED_COUPON_KEY = 'vip_pet_selected_coupon'
const VISIT_FEE_SERVICE_KEY = 'visit_fee'

function calcDistanceKm(lat1, lng1, lat2, lng2) {
  const nLat1 = Number(lat1)
  const nLng1 = Number(lng1)
  const nLat2 = Number(lat2)
  const nLng2 = Number(lng2)
  if (!nLat1 || !nLng1 || !nLat2 || !nLng2) return null
  const R = 6371
  const toRad = (v) => (Number(v) * Math.PI) / 180
  const radLat1 = toRad(nLat1)
  const radLat2 = toRad(nLat2)
  const dLat = toRad(nLat2 - nLat1)
  const dLng = toRad(nLng2 - nLng1)
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(radLat1) * Math.cos(radLat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

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
  const start = toBeijingDate(`${startDate} ${startClock}:00`)
  if (!start) return ''
  const end = new Date(start.getTime() + Number(minutes) * 60 * 1000)
  return `${formatDate(end)} ${formatTime(end)}`
}

function formatDateTime(date) {
  return `${formatDate(date)} ${formatTime(date)}`
}

function parseDateTime(value) {
  return toBeijingDate(value)
}

function coversServiceTime(startTime, endTime, effectiveStart, effectiveEnd) {
  const start = parseDateTime(startTime)
  const end = parseDateTime(endTime)
  const coverStart = parseDateTime(effectiveStart)
  const coverEnd = parseDateTime(effectiveEnd)
  return Boolean(start && end && coverStart && coverEnd && coverStart <= start && coverEnd >= end)
}

function isDogPet(pet = {}) {
  const species = String(pet.species || pet.type || pet.petType || '').trim().toLowerCase()
  if (!species) return true
  return species === 'dog' || species === 'dogs' || species === '狗' || species === '狗狗'
}

function buildDailySessions(form) {
  if (!form.startDate || !form.startClock) return []
  const endDateStr = form.orderType === 'multi_day' ? form.endDate : form.startDate
  if (!endDateStr || endDateStr < form.startDate) return []
  const durationMinutes = Number(form.durationMinutes || 60)
  const dateParts = form.startDate.split('-').map(Number)
  const endDateParts = endDateStr.split('-').map(Number)
  const clockParts = form.startClock.split(':').map(Number)
  let current = new Date(dateParts[0], dateParts[1] - 1, dateParts[2], clockParts[0], clockParts[1])
  const finalDay = new Date(endDateParts[0], endDateParts[1] - 1, endDateParts[2], clockParts[0], clockParts[1])
  const sessions = []
  while (current <= finalDay && sessions.length < 31) {
    const end = new Date(current.getTime() + durationMinutes * 60000)
    sessions.push({ date: formatDate(current), startTime: formatDateTime(current), endTime: formatDateTime(end) })
    current = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1, clockParts[0], clockParts[1])
  }
  return sessions
}

function getBusinessServiceTypes(serviceTypes) {
  return (serviceTypes || []).filter((key) => key !== VISIT_FEE_SERVICE_KEY)
}

function getPrimaryBusinessService(serviceTypes) {
  return getBusinessServiceTypes(serviceTypes)[0] || 'walk'
}

function ensureVisitFeeServiceTypes(serviceTypes, fallbackBusinessKey = 'walk') {
  const selected = Array.from(new Set([VISIT_FEE_SERVICE_KEY, ...(serviceTypes || []).filter(Boolean)]))
  if (!getBusinessServiceTypes(selected).length && fallbackBusinessKey && fallbackBusinessKey !== VISIT_FEE_SERVICE_KEY) selected.push(fallbackBusinessKey)
  return selected
}

function normalizeServiceOptions(options = []) {
  const mapped = options.filter((item) => item.key !== 'extra_pet').map((item) => {
    if (item.key === 'walk' && String(item.label || '').includes('上门')) {
      return { ...item, label: '遛狗服务', price: 39, description: '牵引遛狗、轨迹记录、回家安置' }
    }
    if (item.key === 'feed' && String(item.label || '').includes('上门')) {
      return { ...item, label: '喂养服务', price: 29, description: '换粮换水、基础陪伴' }
    }
    return item
  })
  if (!mapped.some((item) => item.key === VISIT_FEE_SERVICE_KEY)) {
    mapped.unshift({ key: VISIT_FEE_SERVICE_KEY, label: '上门费', price: 30, enabled: true, sortOrder: 5, description: '每次上门固定收取，包含基础到达与履约保障' })
  }
  return mapped.sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0))
}

function markSelected(options, selected) {
  return normalizeServiceOptions(options).map((item) => ({ ...item, selected: selected.includes(item.key), isVisitFee: item.key === VISIT_FEE_SERVICE_KEY }))
}

function buildSelectedServiceDetails(options, selected, expandedMap = {}, urlMap = {}) {
  return (options || []).filter((item) => selected.includes(item.key)).map((item) => {
    const detailText = String(item.detailDescription || item.description || '').trim()
    const expanded = Boolean(expandedMap[item.key])
    const isLong = detailText.length > 96
    const caseImageFileIds = Array.isArray(item.caseImageFileIds) ? item.caseImageFileIds.filter(Boolean) : []
    return {
      ...item,
      detailText,
      detailDisplayText: isLong && !expanded ? `${detailText.slice(0, 96)}...` : detailText,
      detailExpanded: expanded,
      detailLong: isLong,
      caseImageFileIds,
      caseImageUrls: caseImageFileIds.map((id) => urlMap[id] || id)
    }
  })
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
  const date = toBeijingDate(`${startDate} 00:00:00`)
  if (!date) return new Date().getDay()
  return date.getUTCDay()
}

function buildPetVoiceMessage(pet, startDate, seed = 0) {
  if (!pet) return ''
  const name = pet.name || '我'
  const species = getSpeciesLabel(pet.species)
  const personality = pet.personality || ''
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const weekdayLabel = weekdays[getVoiceWeekday(startDate)] || '今天'

  const pools = [
    `主人，${weekdayLabel}外头阳光暖洋洋的超舒服！有宠托师来陪我，我会超级乖的，你在外头安心工作不用担心我哦～`,
    `主人主人，${weekdayLabel}天气凉爽微风正好～你帮我约的宠托师马上就到，我会按时吃粮喝水，主人安心忙吧不用惦记我！`,
    `主人，${weekdayLabel}秋高气爽很适合晒太阳，等宠托师带我玩开心了我就回窝睡觉，你在外面安心拼事业，放一百个心吧～`,
    `今天天色微凉，主人出门记得多披件外套哦！我在家有宠托师细心照料，很安全很听话，主人放宽心去忙吧～`,
    `我是${name}！${weekdayLabel}天气晴朗宜人，等宠托师陪我散步放风，我绝不捣乱拆家，主人安心上班，不用牵挂我呀～`,
    `主人快看，今天天气这么好！家里有贴心的宠托师陪伴，我一点都不孤单，主人就踏踏实实工作，不用操心我哦～`,
    `主人，${weekdayLabel}微风习习很惬意呢！你给我安排的宠托师最贴心啦，我会乖乖等主人回家，主人安心忙碌别挂念我～`
  ]

  if (personality.includes('活泼') || personality.includes('调皮') || personality.includes('皮')) {
    pools.push(`汪！今天外头微风正好阳光舒服，精力充沛的我等宠托师带我跑酷消耗体力，回家就乖乖睡觉，主人放万分心去忙吧！`)
  }
  if (personality.includes('粘人') || personality.includes('撒娇') || personality.includes('温顺')) {
    pools.push(`主人主人，今天外头空气很清新呢！虽然今天不能随时抱着你，但我心里全都是你，会乖乖等主人回家，安心工作哦～`)
  }
  if (species === '猫咪' || (pet.species && pet.species.includes('cat'))) {
    pools.push(`喵呜～今天阳台阳光晒着好舒服呀！主人在外安心忙工作，等宠托师来给我加完罐罐我就去巡视领地，完全不用操心我～`)
  }

  const s = Math.abs(Number(seed) || 0)
  const idx = (getVoiceWeekday(startDate) + s * 3) % pools.length
  return pools[idx]
}

function normalizeSelectedPetIds(petIds, fallbackPetId = '') {
  const raw = Array.isArray(petIds) && petIds.length ? petIds : [fallbackPetId]
  return Array.from(new Set(raw.map((item) => String(item || '').trim()).filter(Boolean)))
}

function formatSelectedPetsSummary(pets) {
  const names = (pets || []).map((pet) => pet.name).filter(Boolean)
  if (!names.length) return ''
  return names.length === 1 ? `${names[0]}想说` : `已选择 ${names.length} 只宠物：${names.join('、')}`
}

function decoratePets(pets, selectedPetIds) {
  const selectedSet = new Set(normalizeSelectedPetIds(selectedPetIds))
  return (pets || []).map((pet) => ({
    ...pet,
    selected: selectedSet.has(pet._id),
    metaText: formatPetMeta(pet),
    hintText: formatPetHint(pet),
    speciesText: getSpeciesLabel(pet.species)
  }))
}

function getInitialStartClock() {
  const now = new Date()
  const minutes = now.getMinutes()
  // 向上取整到下一个30分钟，再留出30分钟缓冲时间
  const nextTime = new Date(now.getTime() + (30 - (minutes % 30) + 30) * 60 * 1000)
  return formatTime(nextTime)
}

Page({
  data: {
    themeClass: 'theme-day',
    user: null,
    pets: [],
    serviceOptions: [],
    selectedServiceDetails: [],
    serviceDetailExpanded: {},
    serviceCaseUrlMap: {},
    durationOptions,
    lockMethodOptions,
    durationIndex: 1,
    petsLoaded: false,
    hasTimedServices: true,
    petDurationRows: [],
    timedDurationTotal: 0,
    walkWithoutDog: false,
    isOutOfRange: false,
    rangeDistanceText: '',
    rangeWarningText: '',
    form: {
      petId: '',
      petIds: [],
      serviceType: 'walk',
      serviceTypes: [VISIT_FEE_SERVICE_KEY, 'walk'],
      serviceAddress: '',
      publishMode: 'open',
      staffGenderRequirement: 'any',
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
      orderType: 'single',
      startDate: formatDate(new Date()),
      endDate: formatDate(new Date()),
      startClock: getInitialStartClock(),
      startTime: '',
      endTime: '',
      durationMinutes: 60,
      petServiceDurations: [],
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
    selectedPets: [],
    selectedPetsTitle: '',
    petVoiceMessage: '',
    loadingPetVoice: false,
    petVoiceRequestId: 0,
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
    const serviceType = options.serviceType || options.serviceKey || ''
    const nextData = { ['form.publishMode']: publishMode, ['form.staffProfileId']: staffProfileId }
    nextData['form.staffGenderRequirement'] = ['male', 'female'].includes(options.staffGenderRequirement) ? options.staffGenderRequirement : 'any'
    if (serviceType) {
      const serviceTypes = ensureVisitFeeServiceTypes(serviceType === VISIT_FEE_SERVICE_KEY ? [] : [serviceType])
      nextData['form.serviceType'] = getPrimaryBusinessService(serviceTypes)
      nextData['form.serviceTypes'] = serviceTypes
    }
    this.setData(nextData)
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
        const enabled = normalizeServiceOptions(serviceOptions || [])
        const fallbackBusinessKey = (enabled.find((item) => item.key !== VISIT_FEE_SERVICE_KEY) || {}).key || 'walk'
        const selected = this.data.form.serviceTypes.filter((key) => enabled.some((item) => item.key === key))
        const serviceTypes = ensureVisitFeeServiceTypes(selected, fallbackBusinessKey).filter((key) => enabled.some((item) => item.key === key))
        const selectedPetIds = normalizeSelectedPetIds(this.data.form.petIds, this.data.form.petId).filter((id) => pets.some((pet) => pet._id === id))
        const petIds = selectedPetIds.length ? selectedPetIds : [pets[0]?._id].filter(Boolean)
        const serviceOptionsWithSelected = markSelected(enabled, serviceTypes)
        this.setData({
          petsLoaded: true,
          pets: decoratePets(pets, petIds),
          serviceOptions: serviceOptionsWithSelected,
          selectedServiceDetails: buildSelectedServiceDetails(serviceOptionsWithSelected, serviceTypes, this.data.serviceDetailExpanded, this.data.serviceCaseUrlMap),
          ['form.petId']: petIds[0] || '',
          ['form.petIds']: petIds,
          ['form.serviceTypes']: serviceTypes,
          ['form.serviceType']: getPrimaryBusinessService(serviceTypes)
        }, () => {
          this.syncSelectedPetUI()
          this.resolveServiceCaseUrls(serviceOptionsWithSelected)
        })
      })
      .catch(showError)
  },

  syncPetServiceDurations() {
    // 再次预约与宠物列表并行加载，列表就绪前不清理模板时长。
    if (!this.data.petsLoaded) return
    const form = this.data.form
    const petIds = normalizeSelectedPetIds(form.petIds, form.petId)
    const pets = this.data.pets.filter((pet) => petIds.includes(pet._id))
    const timedServices = form.serviceTypes.filter((key) => key === 'walk' || key === 'play')
    const previous = Array.isArray(form.petServiceDurations) ? form.petServiceDurations : []
    const isIntern = form.publishMode === 'direct' && this.data.requestedSitter && this.data.requestedSitter.staffLevel === 'intern'
    const rows = []
    timedServices.forEach((serviceKey) => {
      const service = this.data.serviceOptions.find((item) => item.key === serviceKey) || {}
      const feeValue = isIntern ? service.internExtraHalfHourFee : service.extraHalfHourFee
      const feeKnown = feeValue !== undefined && feeValue !== null && Number.isFinite(Number(feeValue))
      pets.filter((pet) => serviceKey !== 'walk' || isDogPet(pet)).forEach((pet) => {
        const saved = previous.find((item) => item.serviceKey === serviceKey && item.petId === pet._id)
        const minutes = Number(saved && saved.durationMinutes)
        const durationMinutes = minutes >= 30 && minutes <= 240 && minutes % 30 === 0 ? minutes : 30
        rows.push({
          key: `${serviceKey}_${pet._id}`, serviceKey, petId: pet._id,
          petName: pet.name || '宠物', serviceLabel: service.label || (serviceKey === 'walk' ? '遛狗' : '陪玩'),
          durationMinutes, feeKnown,
          extraHalfHourFee: feeKnown ? Number(feeValue) : 0,
          extraFee: feeKnown ? ((durationMinutes - 30) / 30 * Number(feeValue)).toFixed(2) : ''
        })
      })
    })
    const total = rows.reduce((sum, item) => sum + item.durationMinutes, 0)
    const hasTimedServices = timedServices.length > 0
    this.setData({
      hasTimedServices, petDurationRows: rows, timedDurationTotal: total,
      walkWithoutDog: timedServices.includes('walk') && !pets.some((pet) => isDogPet(pet)),
      ['form.petServiceDurations']: rows.map(({ serviceKey, petId, durationMinutes }) => ({ serviceKey, petId, durationMinutes })),
      ['form.durationMinutes']: hasTimedServices ? total : durationOptions[this.data.durationIndex].value,
      quote: null
    })
  },

  changePetDuration(e) {
    const { key, step } = e.currentTarget.dataset
    const row = this.data.petDurationRows.find((item) => item.key === key)
    if (!row) return
    const durationMinutes = row.durationMinutes + Number(step)
    if (durationMinutes < 30 || durationMinutes > 240) return
    if (Number(step) > 0 && this.data.timedDurationTotal + Number(step) > 240) {
      wx.showToast({ title: '每日合计不能超过240分钟', icon: 'none' })
      return
    }
    const durations = this.data.form.petServiceDurations.map((item) => item.petId === row.petId && item.serviceKey === row.serviceKey ? { ...item, durationMinutes } : item)
    this.setData({ ['form.petServiceDurations']: durations, quote: null }, this.prepareTime)
  },

  prepareTime() {
    this.syncPetServiceDurations()
    const { startDate, endDate, startClock, durationMinutes, doorLockCodeStartDate, doorLockCodeStartClock, doorLockCodeEndDate, doorLockCodeEndClock } = this.data.form
    const sessions = buildDailySessions(this.data.form)
    const startTime = sessions[0] ? sessions[0].startTime : `${startDate} ${startClock}`
    const endTime = sessions.length ? sessions[sessions.length - 1].endTime : addMinutes(startDate, startClock, durationMinutes)
    const safeEndDate = endDate && endDate >= startDate ? endDate : startDate
    const doorLockCodeStartTime = `${doorLockCodeStartDate || startDate} ${doorLockCodeStartClock || startClock}`
    const doorLockCodeEndTime = `${doorLockCodeEndDate || safeEndDate} ${doorLockCodeEndClock || formatTime(parseDateTime(endTime) || new Date())}`
    this.setData({ ['form.endDate']: safeEndDate, ['form.startTime']: startTime, ['form.endTime']: endTime, ['form.doorLockCodeStartTime']: doorLockCodeStartTime, ['form.doorLockCodeEndTime']: doorLockCodeEndTime }, () => {
      this.syncSecurityCoverage()
      this.syncSelectedAvailability()
    })
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
      this.setData({ ['form.publishMode']: 'open', ['form.staffProfileId']: '', requestedSitter: null, sitterAvailability: [], selectedAvailability: null, isOutOfRange: false, rangeDistanceText: '', rangeWarningText: '', quote: null }, this.prepareTime)
      return
    }
    this.setData({ ['form.publishMode']: 'direct', quote: null }, () => {
      this.prepareTime()
      this.checkSitterRange()
    })
    if (!this.data.form.staffProfileId) this.chooseSitter()
  },

  chooseSitter() {
    wx.navigateTo({ url: '/pages/client/sitters/list/index?staffGenderRequirement=' + this.data.form.staffGenderRequirement })
  },

  checkSitterRange() {
    const { form, requestedSitter } = this.data
    if (form.publishMode !== 'direct' || !requestedSitter) {
      this.setData({ isOutOfRange: false, rangeDistanceText: '', rangeWarningText: '' })
      return { ok: true }
    }
    const orderLat = Number(form.addressLatitude || 0)
    const orderLng = Number(form.addressLongitude || 0)
    const radiusKm = Math.max(Number(requestedSitter.serviceRadiusKm || 5), 1)

    if (!orderLat || !orderLng) {
      this.setData({ isOutOfRange: false, rangeDistanceText: '', rangeWarningText: '' })
      return { ok: true }
    }

    if (requestedSitter.hasServiceAddress === false) {
      const warning = '该宠托师尚未设置有效常驻服务地址坐标，无法指定预约'
      this.setData({ isOutOfRange: true, rangeDistanceText: '', rangeWarningText: warning })
      return { ok: false, message: warning }
    }

    // 优先调用服务端安全距离校验接口（不暴露宠托师私人坐标）
    if (requestedSitter._id && orderLat && orderLng) {
      callFunction('staff', 'checkSitterRange', {
        staffProfileId: requestedSitter._id,
        latitude: orderLat,
        longitude: orderLng
      }).then((res) => {
        if (res && res.inServiceRange !== undefined) {
          const inRange = Boolean(res.inServiceRange)
          const distText = res.distanceText || ''
          if (!inRange) {
            const warning = `服务地址距宠托师服务区域${distText ? `约 ${distText}` : ''}，超出其设定的 ${radiusKm}km 接单范围，无法指定预约`
            this.setData({ isOutOfRange: true, rangeDistanceText: distText, rangeWarningText: warning })
          } else {
            this.setData({ isOutOfRange: false, rangeDistanceText: distText, rangeWarningText: '' })
          }
        }
      }).catch(() => {})
    }

    // 若服务端已返回服务范围判定结果，同步使用
    if (requestedSitter.inServiceRange !== undefined) {
      const inRange = Boolean(requestedSitter.inServiceRange)
      const distText = requestedSitter.distanceText || ''
      if (!inRange) {
        const warning = `服务地址距宠托师服务区域${distText ? `约 ${distText}` : ''}，超出其设定的 ${radiusKm}km 接单范围，无法指定预约`
        this.setData({ isOutOfRange: true, rangeDistanceText: distText, rangeWarningText: warning })
        return { ok: false, message: warning }
      }
      this.setData({ isOutOfRange: false, rangeDistanceText: distText, rangeWarningText: '' })
      return { ok: true }
    }

    // 若对象中存在历史明文坐标，降级兼容
    const sitterLat = Number(requestedSitter.serviceLatitude || 0)
    const sitterLng = Number(requestedSitter.serviceLongitude || 0)
    if (sitterLat && sitterLng) {
      const dist = calcDistanceKm(orderLat, orderLng, sitterLat, sitterLng)
      if (dist !== null && dist > radiusKm) {
        const distText = dist < 1 ? `${Math.round(dist * 1000)}m` : `${dist.toFixed(1)}km`
        const warning = `服务地址距宠托师服务区域约 ${distText}，超出其设定的 ${radiusKm}km 接单范围，无法指定预约`
        this.setData({ isOutOfRange: true, rangeDistanceText: distText, rangeWarningText: warning })
        return { ok: false, message: warning }
      }
      const distText = dist < 1 ? `${Math.round(dist * 1000)}m` : `${dist.toFixed(1)}km`
      this.setData({ isOutOfRange: false, rangeDistanceText: distText, rangeWarningText: '' })
      return { ok: true }
    }

    this.setData({ isOutOfRange: false, rangeDistanceText: '', rangeWarningText: '' })
    return { ok: true }
  },

  loadRequestedSitter(staffProfileId) {
    const lat = this.data.form.addressLatitude
    const lng = this.data.form.addressLongitude
    Promise.all([
      callFunction('staff', 'getPublicSitterDetail', { staffProfileId, latitude: lat, longitude: lng }),
      callFunction('staff', 'listScheduleAvailability', { staffProfileId, days: 14 })
    ])
      .then(([requestedSitter, availability]) => {
        this.setData({ requestedSitter, sitterAvailability: availability || [] }, () => {
          this.prepareTime()
          this.checkSitterRange()
        })
      })
      .catch(showError)
  },

  syncSelectedAvailability() {
    const selected = (this.data.sitterAvailability || []).find((item) => item.dateKey === this.data.form.startDate) || null
    const slotText = selected && Array.isArray(selected.slots) && selected.slots.length
      ? selected.slots.map((slot) => `${String(slot.start).padStart(2, '0')}:00-${String(slot.end).padStart(2, '0')}:00`).join('、')
      : ''
    const session = buildDailySessions(this.data.form)[0]
    let timeFitText = ''
    if (selected && session) {
      const [hour, minute] = this.data.form.startClock.split(':').map(Number)
      const startMinute = hour * 60 + minute
      const endMinute = startMinute + Number(this.data.form.durationMinutes)
      const covered = selected.status === 'available' && (selected.slots || []).some((slot) => Number(slot.start) * 60 <= startMinute && Number(slot.end) * 60 >= endMinute)
      const start = parseDateTime(session.startTime)
      const end = parseDateTime(session.endTime)
      const conflict = (selected.busyOrders || []).some((order) => parseDateTime(order.startTime) < end && parseDateTime(order.endTime) > start)
      timeFitText = !covered ? '当前每日时长超出当天排班范围，请调整时间' : conflict ? '当前时间与已接订单重叠，请调整时间' : '当前时长在当天排班内；全部服务日期以试算和下单校验为准'
    }
    this.setData({ selectedAvailability: selected ? { ...selected, slotText, timeFitText } : null })
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
        const serviceTypes = ensureVisitFeeServiceTypes(template.serviceTypes || [template.serviceType])
        const petIds = normalizeSelectedPetIds(template.petIds, template.petId)
        const serviceOptionsWithSelected = markSelected(this.data.serviceOptions, serviceTypes)
        const update = {
          ['form.sourceOrderId']: template.sourceOrderId,
          ['form.petId']: petIds[0] || '',
          ['form.petIds']: petIds,
          ['form.serviceType']: getPrimaryBusinessService(serviceTypes),
          ['form.serviceTypes']: serviceTypes,
          ['form.serviceAddress']: template.serviceAddress,
          ['form.addressDetail']: template.addressDetail,
          ['form.doorplate']: template.doorplate,
          ['form.addressLatitude']: template.addressLatitude,
          ['form.addressLongitude']: template.addressLongitude,
          ['form.durationMinutes']: template.durationMinutes,
          ['form.petServiceDurations']: Array.isArray(template.petServiceDurations) ? template.petServiceDurations : [],
          ['form.publishMode']: template.publishMode,
          ['form.staffGenderRequirement']: template.staffGenderRequirement || 'any',
          ['form.staffProfileId']: template.staffProfileId,
          locationReady: Boolean(template.serviceAddress),
          locationTip: '已从历史订单带入地址',
          serviceOptions: serviceOptionsWithSelected,
          selectedServiceDetails: buildSelectedServiceDetails(serviceOptionsWithSelected, serviceTypes, this.data.serviceDetailExpanded, this.data.serviceCaseUrlMap),
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
    }, () => {
      this.checkSitterRange()
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

  syncSelectedServiceDetails() {
    this.setData({
      selectedServiceDetails: buildSelectedServiceDetails(this.data.serviceOptions, this.data.form.serviceTypes, this.data.serviceDetailExpanded, this.data.serviceCaseUrlMap)
    })
  },

  resolveServiceCaseUrls(options = this.data.serviceOptions) {
    const ids = Array.from(new Set((options || []).reduce((list, item) => list.concat(item.caseImageFileIds || []), []).filter(Boolean)))
    if (!ids.length) {
      this.setData({ serviceCaseUrlMap: {} }, this.syncSelectedServiceDetails)
      return
    }
    wx.cloud.getTempFileURL({
      fileList: ids,
      success: (res) => {
        const map = {}
        ;(res.fileList || []).forEach((item) => { map[item.fileID] = item.tempFileURL || item.fileID })
        ids.forEach((id) => { if (!map[id]) map[id] = id })
        this.setData({ serviceCaseUrlMap: map }, this.syncSelectedServiceDetails)
      },
      fail: () => this.syncSelectedServiceDetails()
    })
  },

  toggleServiceDetail(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    const expanded = { ...this.data.serviceDetailExpanded, [key]: !this.data.serviceDetailExpanded[key] }
    this.setData({ serviceDetailExpanded: expanded }, this.syncSelectedServiceDetails)
  },

  previewServiceCases(e) {
    const key = e.currentTarget.dataset.key
    const detail = (this.data.selectedServiceDetails || []).find((item) => item.key === key)
    if (!detail) return
    const urls = (detail.caseImageUrls && detail.caseImageUrls.length ? detail.caseImageUrls : detail.caseImageFileIds || []).filter(Boolean)
    if (!urls.length) {
      wx.showToast({ title: '暂无服务案例图片', icon: 'none' })
      return
    }
    wx.previewImage({ current: urls[0], urls })
  },

  syncSelectedPetUI() {
    const petIds = normalizeSelectedPetIds(this.data.form.petIds, this.data.form.petId)
    const pets = decoratePets(this.data.pets, petIds)
    const selectedPets = pets.filter((item) => petIds.includes(item._id))
    const selectedPet = selectedPets[0] || null
    const isSinglePet = selectedPets.length === 1
    const initialVoice = isSinglePet
      ? buildPetVoiceMessage(selectedPet, this.data.form.startDate)
      : (selectedPets.length > 1 ? '多宠物订单会根据服务规则自动计算额外照护费用。' : '')

    this.setData({
      pets,
      selectedPet,
      selectedPets,
      selectedPetsTitle: formatSelectedPetsSummary(selectedPets),
      petVoiceMessage: initialVoice
    }, () => {
      this.prepareTime()
      if (isSinglePet && selectedPet) {
        this.fetchAiPetVoice(selectedPet, this.data.form.startDate)
      }
    })
  },

  async fetchAiPetVoice(pet, startDate, forceRefresh = false) {
    if (!pet) return
    const requestId = (this.data.petVoiceRequestId || 0) + 1
    this.setData({ petVoiceRequestId: requestId, loadingPetVoice: true })

    const name = pet.name || '宝贝'
    const speciesLabel = pet.species === 'dog' ? '狗狗' : pet.species === 'cat' ? '猫咪' : '宠物'
    const personality = pet.personality ? `，性格特点：${pet.personality}` : ''
    const breed = pet.breed ? `，品种是${pet.breed}` : ''
    const activeService = (this.data.serviceOptions || []).find((s) => s.value === this.data.form.serviceType)
    const serviceName = activeService ? activeService.label : '上门宠托'
    const targetStartDate = startDate || this.data.form.startDate

    // 1. 优先调用微信小程序原生云开发 AI 扩展（同 AI 宠护小助手的 hy3 模型）
    let aiSuccess = false
    try {
      if (typeof wx !== 'undefined' && wx.cloud && wx.cloud.extend && wx.cloud.extend.AI && typeof wx.cloud.extend.AI.createModel === 'function') {
        const model = wx.cloud.extend.AI.createModel('cloudbase')
        const response = await model.streamText({
          data: {
            model: 'hy3',
            messages: [
              {
                role: 'system',
                content: `你是一只名为「${name}」的${breed}${speciesLabel}${personality}。主人正在小程序里为你预约${targetStartDate}的${serviceName}服务。
请以第一人称「我」的萌宠口吻对最爱的主人说一句话。
必须严格同时包含两个方面：
1. 【告诉主人今天/预约日天气情况】：结合当季时令告诉主人今天天气如何（例如阳光明媚暖洋洋、秋高气爽微风正好舒服、或者降温微凉提醒主人添衣）；
2. 【让主人安心放心】：告诉主人待会有宠托师来贴心照顾自己，自己会乖乖听话吃饭休息，让主人在外面安心工作忙碌，完全不用牵挂担心。
要求：
- 语气萌趣治愈可爱、充满爱意，35到60字左右；
- 严禁出现任何双引号、单引号、书名号、markdown标记，只直接输出宠物说的这一句话。`
              },
              {
                role: 'user',
                content: `主人为你预约了服务，请以萌宠第一人称口吻，告诉主人今天天气情况并让主人安心放心！`
              }
            ]
          }
        })

        if (response && response.textStream) {
          let fullText = ''
          for await (const text of response.textStream) {
            if (this.data.petVoiceRequestId !== requestId) return
            fullText += text
            const cleaned = fullText.replace(/^["“'「]+|["”'」]+$/g, '').trim()
            if (cleaned) {
              this.setData({ petVoiceMessage: cleaned })
            }
          }
          const finalClean = fullText.replace(/^["“'「]+|["”'」]+$/g, '').trim()
          if (finalClean && finalClean.length >= 5) {
            this.setData({ petVoiceMessage: finalClean, loadingPetVoice: false })
            aiSuccess = true
            return
          }
        }
      }
    } catch (clientAiErr) {
      console.warn('[client AI] streamText fallback:', (clientAiErr && clientAiErr.message) || clientAiErr)
    }

    if (this.data.petVoiceRequestId !== requestId) return

    // 2. 尝试调用云函数端 generatePetVoice
    try {
      const res = await callFunction('ai', 'generatePetVoice', {
        petId: pet._id || '',
        pet: {
          name: pet.name,
          species: pet.species,
          breed: pet.breed,
          personality: pet.personality,
          specialNotes: pet.specialNotes
        },
        startDate: targetStartDate,
        serviceName,
        forceRefresh
      })

      if (this.data.petVoiceRequestId !== requestId) return
      if (res && res.voiceMessage) {
        this.setData({ petVoiceMessage: res.voiceMessage, loadingPetVoice: false })
        aiSuccess = true
        return
      }
    } catch (cloudFnErr) {
      console.warn('[cloud function] generatePetVoice fallback:', (cloudFnErr && cloudFnErr.message) || cloudFnErr)
    }

    if (this.data.petVoiceRequestId !== requestId) return

    // 3. 兜底回退：若 AI 暂未响应，使用多样化的温情随机池
    const nextSeed = (this.data.voiceRefreshSeed || 0) + 1
    const fallbackText = buildPetVoiceMessage(pet, targetStartDate, nextSeed)
    this.setData({
      petVoiceMessage: fallbackText,
      loadingPetVoice: false,
      voiceRefreshSeed: nextSeed
    })
  },

  refreshPetVoice() {
    if (this.data.loadingPetVoice || !this.data.selectedPet) return
    const nextSeed = (this.data.voiceRefreshSeed || 0) + 1
    this.setData({ voiceRefreshSeed: nextSeed })
    this.fetchAiPetVoice(this.data.selectedPet, this.data.form.startDate, true)
  },

  choosePet(e) {
    const petId = e.currentTarget.dataset.id
    if (!petId) return
    const selected = normalizeSelectedPetIds(this.data.form.petIds, this.data.form.petId)
    const index = selected.indexOf(petId)
    if (index >= 0) selected.splice(index, 1)
    else selected.push(petId)
    if (!selected.length) {
      wx.showToast({ title: '至少选择一只宠物', icon: 'none' })
      return
    }
    this.setData({ ['form.petId']: selected[0], ['form.petIds']: selected, quote: null }, this.syncSelectedPetUI)
  },

  addPet() {
    wx.navigateTo({ url: '/pages/client/pets/edit/index' })
  },

  toggleService(e) {
    const key = e.currentTarget.dataset.key
    if (key === VISIT_FEE_SERVICE_KEY) {
      wx.showToast({ title: '上门费为固定必选', icon: 'none' })
      return
    }
    const selected = ensureVisitFeeServiceTypes(this.data.form.serviceTypes.slice())
    const index = selected.indexOf(key)
    if (index >= 0) selected.splice(index, 1)
    else selected.push(key)
    const serviceTypes = ensureVisitFeeServiceTypes(selected, '')
    if (!getBusinessServiceTypes(serviceTypes).length) {
      wx.showToast({ title: '至少选择一项照护服务', icon: 'none' })
      return
    }
    const serviceOptionsWithSelected = markSelected(this.data.serviceOptions, serviceTypes)
    this.setData({
      ['form.serviceTypes']: serviceTypes,
      ['form.serviceType']: getPrimaryBusinessService(serviceTypes),
      serviceOptions: serviceOptionsWithSelected,
      selectedServiceDetails: buildSelectedServiceDetails(serviceOptionsWithSelected, serviceTypes, this.data.serviceDetailExpanded, this.data.serviceCaseUrlMap),
      quote: null
    }, this.prepareTime)
  },

  chooseOrderType(e) {
    const orderType = e.currentTarget.dataset.type === 'multi_day' ? 'multi_day' : 'single'
    const next = { ['form.orderType']: orderType, quote: null }
    if (orderType === 'single') next['form.endDate'] = this.data.form.startDate
    this.setData(next, this.prepareTime)
  },

  chooseDate(e) {
    const startDate = e.detail.value
    const next = { ['form.startDate']: startDate, quote: null }
    if (!this.data.form.endDate || this.data.form.endDate < startDate || this.data.form.orderType === 'single') next['form.endDate'] = startDate
    this.setData(next, () => {
      this.updateMinTime()
      this.prepareTime()
      this.syncSelectedPetUI()
      this.syncSelectedAvailability()
    })
  },

  chooseEndDate(e) {
    this.setData({ ['form.endDate']: e.detail.value, quote: null }, this.prepareTime)
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
        }, () => {
          this.checkSitterRange()
        })
        wx.showToast({ title: '已更新位置' })
      })
      .catch(showError)
  },

  validateRequired() {
    const form = this.data.form
    if (!this.data.user || !String(this.data.user.phone || '').trim()) return '请先绑定手机号'
    if (!normalizeSelectedPetIds(form.petIds, form.petId).length) return '请先选择宠物'
    if (!form.serviceTypes.includes(VISIT_FEE_SERVICE_KEY)) return '请选择上门费'
    if (!getBusinessServiceTypes(form.serviceTypes).length) return '请选择至少一项照护服务'
    if (!this.data.petsLoaded) return '宠物信息加载中，请稍后重试'
    if (this.data.walkWithoutDog) return '遛狗服务需至少选择一只狗狗'
    if (this.data.hasTimedServices && !form.petServiceDurations.length) return '请选择计时服务的宠物'
    if (this.data.hasTimedServices && this.data.timedDurationTotal > 240) return '每日合计不能超过240分钟，请减少时长、宠物或服务'
    if (form.publishMode === 'direct') {
      if (!form.staffProfileId) return '请选择指定宠托师'
      if (form.staffGenderRequirement !== 'any' && (!this.data.requestedSitter || this.data.requestedSitter.gender !== form.staffGenderRequirement)) return '指定宠托师性别不符合要求，请重新选择'
      const rangeCheck = this.checkSitterRange()
      if (!rangeCheck.ok) return rangeCheck.message
    }
    if (!form.serviceAddress) return '请选择服务地址'
    if (!form.addressDetail) return '请填写详细地址'
    if (!form.doorplate) return '请填写门牌号或入户说明'
    if (!form.lockMethod) return '请选择入户与门锁方式'
    if (form.lockMethod === 'one_time_code' && !String(form.doorLockCode || '').trim()) return '请填写一次性开门密码'
    if (form.lockMethod === 'one_time_code' && !coversServiceTime(form.startTime, form.endTime, form.doorLockCodeStartTime, form.doorLockCodeEndTime)) return '一次性密码有效期需要覆盖完整服务时间'
    if (form.lockMethod === 'key' && !String(form.keyLocation || '').trim()) return '请填写钥匙放置位置'
    if (form.lockMethod === 'key' && !(form.keyImageFileIds || []).length) return '请上传钥匙放置位置图片'
    if (!form.startDate || !form.startClock) return '请选择开始时间'
    if (form.orderType === 'multi_day' && (!form.endDate || form.endDate < form.startDate)) return '请选择正确的连续服务结束日期'
    const sessions = buildDailySessions(form)
    if (!sessions.length) return '服务时间不正确'
    if (sessions.length > 31) return '连续服务最多支持31天'
    const start = parseDateTime(form.startTime)
    if (!start || start.getTime() < Date.now()) return '服务开始时间不能早于当前时间'
    return ''
  },

  chooseStaffGender(e) {
    const value = e.detail.value
    if (!['any', 'male', 'female'].includes(value)) return
    this.setData({ 'form.staffGenderRequirement': value, quote: null })
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
    const serviceTypes = ensureVisitFeeServiceTypes(form.serviceTypes, getPrimaryBusinessService(form.serviceTypes))
    const petIds = normalizeSelectedPetIds(form.petIds, form.petId)
    const serviceSessions = buildDailySessions(form)
    return {
      ...form,
      petServiceDurations: form.petServiceDurations.map(({ serviceKey, petId, durationMinutes }) => ({ serviceKey, petId, durationMinutes })),
      orderType: form.orderType || 'single',
      endDate: form.endDate || form.startDate,
      petId: petIds[0] || '',
      petIds,
      serviceTypes,
      serviceType: getPrimaryBusinessService(serviceTypes),
      serviceSessions,
      sessionCount: serviceSessions.length,
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

  openAgreement(e) {
    const type = e.currentTarget.dataset.type
    if (!type) return
    wx.navigateTo({ url: `/pages/common/agreement/index?type=${type}&mode=view` })
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
