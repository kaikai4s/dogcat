module.exports = function createService({
  EXTRA_PET_RULES,
  RETIRED_SERVICE_KEYS,
  VISIT_FEE_SERVICE_KEY,
  db,
  defaultServicePrices,
  readScopedDocuments,
  safeText
}) {
  function isPresetServiceKey(key) {
    return defaultServicePrices.some((item) => item.key === key)
  }

  function defaultExtraPetFeeForService(key) {
    if (key === 'walk') return 30
    if (key === 'play' || key === 'medicine') return 15
    return 0
  }

  function defaultExtraPetRuleForService(key) {
    if (key === 'walk') return 'dog'
    if (key === 'play' || key === 'medicine') return 'all'
    return 'none'
  }

  function normalizeExtraPetRule(value, key) {
    const rule = String(value || '').trim()
    if (EXTRA_PET_RULES.has(rule)) return rule
    return defaultExtraPetRuleForService(key)
  }

  function normalizeServiceCaseImageFileIds(value) {
    if (!Array.isArray(value)) return []
    return Array.from(new Set(value.map((item) => safeText(item).trim()).filter(Boolean))).slice(0, 9)
  }

  function normalizeServicePrice(item) {
    const key = String(item.key || '').trim()
    const preset = defaultServicePrices.find((presetItem) => presetItem.key === key)
    const extraPetRule = key === VISIT_FEE_SERVICE_KEY ? 'none' : normalizeExtraPetRule(item.extraPetRule, key)
    const enabled = item.enabled !== false
    const showOnHome = key !== VISIT_FEE_SERVICE_KEY && enabled && item.showOnHome === true
    const priceNum = Number(item.price || 0)
    const price = Number.isFinite(priceNum) ? Math.max(priceNum, 0) : 0
    const defaultExtra = defaultExtraPetFeeForService(key)
    const extraPetFeeNum = Number(item.extraPetFee !== undefined ? item.extraPetFee : defaultExtra)
    const extraPetFee = Number.isFinite(extraPetFeeNum) ? Math.max(extraPetFeeNum, 0) : defaultExtra
    const extraHalfHourFeeValue = Number(item.extraHalfHourFee || 0)
    const extraHalfHourFee = Number.isFinite(extraHalfHourFeeValue) ? Math.max(extraHalfHourFeeValue, 0) : 0
    const internExtraHalfHourFeeValue = Number(item.internExtraHalfHourFee !== undefined ? item.internExtraHalfHourFee : extraHalfHourFee)
    const internExtraHalfHourFee = Number.isFinite(internExtraHalfHourFeeValue) ? Math.max(internExtraHalfHourFeeValue, 0) : extraHalfHourFee
    const internPriceNum = Number(item.internPrice !== undefined ? item.internPrice : price)
    const internPrice = Number.isFinite(internPriceNum) ? Math.max(internPriceNum, 0) : price
    const internExtraPetFeeNum = Number(item.internExtraPetFee !== undefined ? item.internExtraPetFee : extraPetFee)
    const internExtraPetFee = Number.isFinite(internExtraPetFeeNum) ? Math.max(internExtraPetFeeNum, 0) : extraPetFee
    return {
      key,
      label: String(item.label || '').trim(),
      price,
      internPrice,
      extraPetFee,
      internExtraPetFee,
      extraPetRule,
      extraHalfHourFee: ['walk', 'play'].includes(key) ? extraHalfHourFee : 0,
      internExtraHalfHourFee: ['walk', 'play'].includes(key) ? internExtraHalfHourFee : 0,
      showOnHome,
      enabled,
      sortOrder: Number(item.sortOrder || 0),
      description: safeText(item.description || '').trim(),
      detailDescription: safeText(item.detailDescription || '').trim(),
      caseImageFileIds: normalizeServiceCaseImageFileIds(item.caseImageFileIds),
      coverUrl: (typeof item.coverUrl === 'string' && !item.coverUrl.startsWith('/images/services/'))
        ? safeText(item.coverUrl).trim()
        : ((preset && typeof preset.coverUrl === 'string' && !preset.coverUrl.startsWith('/images/services/')) ? safeText(preset.coverUrl).trim() : ''),
      isPreset: Boolean(preset)
    }
  }

  async function listServicePrices(includeDisabled = false) {
    let configured = []
    try {
      if (typeof readScopedDocuments === 'function') {
        configured = (await readScopedDocuments('service_prices', {}))
          .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0))
      } else {
        const query = db.collection('service_prices').orderBy('sortOrder', 'asc')
        const res = await (typeof query.limit === 'function' ? query.limit(500) : query).get()
        configured = res.data || []
      }
    } catch (error) {
      configured = []
    }
    return mergeServicePrices(configured, includeDisabled)
  }

  function mergeServicePrices(configured = [], includeDisabled = false) {
    const configuredMap = configured.reduce((map, item) => ({ ...map, [item.key]: item }), {})
    const merged = defaultServicePrices.map((item) => {
      const configuredItem = configuredMap[item.key] || {}
      const isLegacyCombinedService = ['walk', 'feed'].includes(item.key) && String(configuredItem.label || '').startsWith('上门')
      return normalizeServicePrice(isLegacyCombinedService ? { ...configuredItem, label: item.label, price: item.price, description: item.description } : { ...item, ...configuredItem })
    })
    configured.forEach((item) => {
      if (!defaultServicePrices.some((preset) => preset.key === item.key)) merged.push(normalizeServicePrice(item))
    })
    return merged
      .filter((item) => item.key && item.label && !RETIRED_SERVICE_KEYS.has(item.key) && (includeDisabled || item.enabled))
      .sort((a, b) => a.sortOrder - b.sortOrder)
  }

  return {
    isPresetServiceKey,
    defaultExtraPetFeeForService,
    defaultExtraPetRuleForService,
    normalizeExtraPetRule,
    normalizeServiceCaseImageFileIds,
    normalizeServicePrice,
    listServicePrices,
    mergeServicePrices
  }
}
