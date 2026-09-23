module.exports = function createService({
  PET_TIMED_SERVICE_KEYS,
  addMinutesToDateTimeText,
  applyCouponToPricing,
  buildOrderSessions,
  db,
  evaluateCoupon,
  getAvailableUserCoupons,
  getBusinessServiceTypes,
  listServicePrices,
  normalizePetIds,
  normalizeServiceTypes,
  normalizeStaffWorkflow,
  safeText,
  validateVisitFeeServices
}) {
  function formatPetSummary(pets = []) {
    const names = pets.map((pet) => pet.name).filter(Boolean)
    if (names.length <= 2) return names.join('、') || '宠物'
    return `${names.slice(0, 2).join('、')}等${names.length}只`
  }

  function getWalkPrice(basePrice, weight) {
    if (basePrice !== 69) return basePrice
    if (weight > 25) return 119
    if (weight >= 10) return 89
    return 69
  }

  async function resolveStaffPriceLevel(data = {}) {
    if (data.publishMode !== 'direct') return 'certified'
    const staffProfileId = safeText(data.staffProfileId || data.requestedStaffProfileId).trim()
    if (!staffProfileId) return 'certified'
    const profileRes = await db.collection('staff_profiles').doc(staffProfileId).get().catch(() => ({ data: null }))
    const staffProfile = profileRes && profileRes.data ? normalizeStaffWorkflow(profileRes.data) : null
    return staffProfile && staffProfile.staffLevel === 'intern' ? 'intern' : 'certified'
  }

  function petSpecies(pet = {}) {
    return safeText(pet.species || pet.type || pet.petType).trim().toLowerCase()
  }

  function isDogPet(pet = {}) {
    const species = petSpecies(pet)
    if (!species) return true
    return species === 'dog' || species === 'dogs' || species === '狗' || species === '狗狗'
  }

  function timedServiceTargets(serviceKey, pets = []) {
    if (serviceKey === 'walk') return pets.filter(isDogPet)
    if (serviceKey === 'play') return pets
    return []
  }

  function formatMinutesText(minutes) {
    const value = Number(minutes || 0)
    if (value % 60 === 0) return `${value / 60}小时`
    if (value > 60) return `${Math.floor(value / 60)}小时${value % 60}分钟`
    return `${value}分钟`
  }

  function normalizePetServiceDurations(data = {}, pets = [], serviceTypes = [], catalogMap = {}, isInternPrice = false) {
    const selectedTimedKeys = PET_TIMED_SERVICE_KEYS.filter((key) => serviceTypes.includes(key))
    const raw = Array.isArray(data.petServiceDurations) ? data.petServiceDurations : []
    const hasExplicitConfig = raw.length > 0
    const petMap = pets.reduce((map, pet) => ({ ...map, [String(pet._id || '')]: pet }), {})
    const validKeys = new Set(selectedTimedKeys)
    const validPairs = new Set()
    selectedTimedKeys.forEach((serviceKey) => {
      const targets = timedServiceTargets(serviceKey, pets)
      if (serviceKey === 'walk' && !targets.length) throw new Error('遛狗服务仅支持狗狗，请先选择狗狗')
      targets.forEach((pet) => validPairs.add(`${serviceKey}:${pet._id}`))
    })

    const configured = {}
    if (hasExplicitConfig) {
      raw.forEach((item) => {
        const serviceKey = safeText(item.serviceKey || item.serviceType).trim()
        const petId = safeText(item.petId).trim()
        if (!validKeys.has(serviceKey)) throw new Error('服务时长配置不正确')
        if (!petMap[petId] || !validPairs.has(`${serviceKey}:${petId}`)) throw new Error('服务时长宠物不匹配')
        const key = `${serviceKey}:${petId}`
        if (configured[key]) throw new Error('服务时长配置重复')
        const durationMinutes = Number(item.durationMinutes)
        if (!Number.isFinite(durationMinutes) || durationMinutes < 30 || durationMinutes > 240 || durationMinutes % 30 !== 0) throw new Error('服务时长需为30-240分钟，且按30分钟递增')
        configured[key] = durationMinutes
      })
    }

    const totalTargetCount = selectedTimedKeys.reduce((sum, serviceKey) => sum + timedServiceTargets(serviceKey, pets).length, 0)
    const legacySingleDuration = Number(data.durationMinutes || 0)
    const legacyDefaultDuration = !hasExplicitConfig && totalTargetCount === 1 && Number.isFinite(legacySingleDuration) && legacySingleDuration >= 30 && legacySingleDuration <= 240 && legacySingleDuration % 30 === 0 ? legacySingleDuration : 30
    const durations = []
    selectedTimedKeys.forEach((serviceKey) => {
      const targets = timedServiceTargets(serviceKey, pets)
      targets.forEach((pet) => {
        const key = `${serviceKey}:${pet._id}`
        if (hasExplicitConfig && !configured[key]) throw new Error('请为每只宠物设置服务时长')
        const item = catalogMap[serviceKey] || {}
        const durationMinutes = configured[key] || legacyDefaultDuration
        const extraUnits = Math.max(durationMinutes / 30 - 1, 0)
        const unitPrice = isInternPrice ? Number(item.internExtraHalfHourFee || 0) : Number(item.extraHalfHourFee || 0)
        durations.push({
          serviceKey,
          serviceLabel: item.label || (serviceKey === 'walk' ? '遛狗' : '陪伴玩耍'),
          petId: pet._id,
          petName: pet.name || '宠物',
          durationMinutes,
          durationText: formatMinutesText(durationMinutes),
          extraUnits,
          unitPrice: Math.max(Number.isFinite(unitPrice) ? unitPrice : 0, 0),
          extraAmount: Math.round(extraUnits * Math.max(Number.isFinite(unitPrice) ? unitPrice : 0, 0) * 100) / 100
        })
      })
    })
    const totalTimedMinutes = durations.reduce((sum, item) => sum + item.durationMinutes, 0)
    return { durations, totalTimedMinutes }
  }

  async function calcOrderPricing(data, pet, options = {}) {
    const serviceTypes = normalizeServiceTypes(data)
    if (!serviceTypes.length) throw new Error('请选择服务项目')
    validateVisitFeeServices(serviceTypes)
    const pets = Array.isArray(pet) ? pet : (pet ? [pet] : [])
    const primaryPet = pets[0] || null
    const petCount = pets.length || normalizePetIds(data).length
    const dogCount = pets.filter(isDogPet).length
    const staffPriceLevel = await resolveStaffPriceLevel(data)
    const isInternPrice = staffPriceLevel === 'intern'
    const catalog = await listServicePrices(false)
    const catalogMap = catalog.reduce((map, item) => ({ ...map, [item.key]: item }), {})
    const weight = Number((primaryPet && primaryPet.weight) || data.weight || 0)
    const petDurationResult = normalizePetServiceDurations(data, pets, serviceTypes, catalogMap, isInternPrice)
    const durationMinutes = petDurationResult.totalTimedMinutes || Number(data.durationMinutes || 60)
    if (!Number.isFinite(durationMinutes) || durationMinutes < 30 || durationMinutes > 240) throw new Error('服务时长不正确')
    const sessions = data.startTime ? buildOrderSessions({ ...data, durationMinutes, endTime: addMinutesToDateTimeText(data.startTime, durationMinutes) || data.endTime }) : [{ index: 1, startTime: data.startTime || '', endTime: data.endTime || '' }]
    const sessionCount = sessions.length
    const unitBasePriceItems = serviceTypes.map((key) => {
      const item = catalogMap[key]
      if (!item) throw new Error('服务项目不可用')
      const unitBasePrice = isInternPrice ? item.internPrice : item.price
      const basePrice = key === 'walk' ? getWalkPrice(unitBasePrice, weight) : unitBasePrice
      const price = Math.round(basePrice * 100) / 100
      return { key, label: item.label, price }
    })
    const unitExtraPetItems = getBusinessServiceTypes(serviceTypes).map((key) => {
      const item = catalogMap[key]
      if (!item) return null
      const extraPetFee = isInternPrice ? item.internExtraPetFee : item.extraPetFee
      if (item.extraPetRule === 'none' || !Number(extraPetFee || 0)) return null
      const extraCount = item.extraPetRule === 'dog' ? Math.max(dogCount - 1, 0) : Math.max(petCount - 1, 0)
      if (!extraCount) return null
      const price = Math.round(extraCount * Number(extraPetFee || 0))
      return {
        key: `${key}_extra_pet`,
        serviceKey: key,
        label: `${item.label} · 额外${item.extraPetRule === 'dog' ? '狗狗' : '宠物'} x${extraCount}`,
        price,
        quantity: extraCount,
        unitPrice: Number(extraPetFee || 0),
        type: 'extra_pet_fee',
        extraPetRule: item.extraPetRule
      }
    }).filter(Boolean)
    const unitTimedExtraItems = petDurationResult.durations
      .filter((item) => item.extraUnits > 0 && item.extraAmount > 0)
      .map((item) => ({
        key: `${item.serviceKey}_${item.petId}_time_extra`,
        serviceKey: item.serviceKey,
        petId: item.petId,
        petName: item.petName,
        label: `${item.serviceLabel} · ${item.petName}续时 ${item.extraUnits}×30分钟`,
        price: item.extraAmount,
        quantity: item.extraUnits,
        unitPrice: item.unitPrice,
        durationMinutes: item.durationMinutes,
        type: 'pet_time_extra_fee'
      }))
    const unitPriceItems = [...unitBasePriceItems, ...unitExtraPetItems, ...unitTimedExtraItems]
    const priceItems = sessionCount > 1
      ? unitPriceItems.map((item) => ({ ...item, unitPrice: item.price, price: Math.round(item.price * sessionCount * 100) / 100, label: `${item.label} × ${sessionCount}次` }))
      : unitPriceItems
    const amount = Math.round(priceItems.reduce((sum, item) => sum + Math.round(item.price * 100), 0)) / 100
    const serviceLabels = unitBasePriceItems.map((item) => item.label)
    const businessServiceTypes = getBusinessServiceTypes(serviceTypes)
    const basePricing = {
      amount,
      payAmount: amount,
      discountAmount: 0,
      coupon: null,
      currency: 'CNY',
      serviceTypes,
      businessServiceTypes,
      primaryServiceType: businessServiceTypes[0],
      serviceLabels,
      serviceSummary: serviceLabels.join('、'),
      durationMinutes,
      petServiceDurations: petDurationResult.durations,
      sessionCount,
      sessions,
      orderType: sessionCount > 1 ? 'multi_day' : 'single',
      priceItems,
      priceSnapshot: { services: priceItems, unitServices: unitPriceItems, extraPetItems: unitExtraPetItems, timedExtraItems: unitTimedExtraItems, petServiceDurations: petDurationResult.durations, durationMinutes, sessionCount, sessions, weight, petCount, dogCount, staffPriceLevel, staffLevelText: isInternPrice ? '实习宠托师' : '认证宠托师', originalAmount: amount, discountAmount: 0, payAmount: amount }
    }
    const openid = options.openid || ''
    if (!openid) return basePricing
    if (data.couponId) {
      const couponRes = await db.collection('user_coupons').doc(data.couponId).get().catch(() => ({ data: null }))
      const coupon = couponRes && couponRes.data
      const result = evaluateCoupon(coupon, basePricing, openid)
      if (!result.applicable) throw new Error(result.reason)
      return applyCouponToPricing(basePricing, result)
    }
    if (data.autoApplyCoupon === true) {
      const coupons = await getAvailableUserCoupons(openid)
      const best = coupons
        .map((coupon) => evaluateCoupon(coupon, basePricing, openid))
        .filter((item) => item.applicable)
        .sort((a, b) => b.discountAmount - a.discountAmount)[0]
      return applyCouponToPricing(basePricing, best)
    }
    return basePricing
  }

  return {
    formatPetSummary,
    getWalkPrice,
    resolveStaffPriceLevel,
    petSpecies,
    isDogPet,
    timedServiceTargets,
    formatMinutesText,
    normalizePetServiceDurations,
    calcOrderPricing
  }
}
