module.exports = function createService({
  RETIRED_SERVICE_KEYS,
  VISIT_FEE_SERVICE_KEY
}) {
  function normalizeServiceTypes(data) {
    const raw = Array.isArray(data.serviceTypes) ? data.serviceTypes : [data.serviceType || 'walk']
    const unique = Array.from(new Set(raw.map((item) => String(item || '').trim()).filter(Boolean)))
    return unique.includes(VISIT_FEE_SERVICE_KEY) ? [VISIT_FEE_SERVICE_KEY, ...unique.filter((key) => key !== VISIT_FEE_SERVICE_KEY)] : unique
  }

  function getBusinessServiceTypes(serviceTypes) {
    return (serviceTypes || []).filter((key) => key !== VISIT_FEE_SERVICE_KEY)
  }

  function validateVisitFeeServices(serviceTypes) {
    if (serviceTypes.some((key) => RETIRED_SERVICE_KEYS.has(key))) throw new Error('该服务项目已下线')
    if (!serviceTypes.includes(VISIT_FEE_SERVICE_KEY)) throw new Error('请选择上门费')
    if (!getBusinessServiceTypes(serviceTypes).length) throw new Error('请选择至少一项照护服务')
  }

  return {
    normalizeServiceTypes,
    getBusinessServiceTypes,
    validateVisitFeeServices
  }
}
