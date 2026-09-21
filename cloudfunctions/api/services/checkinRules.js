module.exports = function createService({
  CHECKIN_EVENT_TYPES,
  checkinEventText,
  cloud,
  db,
  defaultServiceCheckinRules,
  defaultServicePrices,
  formatDateKey,
  hasCheckinPhoto,
  hasCoordinate,
  listServicePrices,
  now,
  safeFileId,
  safeText,
  toTimeValue
}) {
  function requiredCheckins(serviceType, serviceTypes) {
    const types = Array.isArray(serviceTypes) && serviceTypes.length ? serviceTypes : [serviceType]
    const events = new Set(['enter_door', 'pet_status', 'leave_door'])
    if (types.includes('walk')) {
      events.add('leash_on')
      events.add('return_home')
    }
    if (types.includes('feed')) {
      events.add('feed')
      events.add('water')
    }
    if (types.includes('litter') || types.includes('clean')) events.add('clean')
    if (types.includes('medicine')) events.add('medicine')
    return Array.from(events)
  }

  function requiresSanitization(order) {
    return (order.requiredCheckins || []).includes('sanitization') ||
      (order.checkinRequirements || []).some((item) => item.eventType === 'sanitization' && item.required)
  }

  function sanitizationDateKey(value) {
    return formatDateKey(new Date(toTimeValue(value) + 8 * 60 * 60 * 1000))
  }

  function isValidSanitization(item, order, current = now()) {
    const timestamp = toTimeValue(item.serverTime)
    return item.eventType === 'sanitization' && hasCheckinPhoto(item) &&
      item.orderId === order._id && item.staffOpenid === order.staffOpenid &&
      item.sanitizationVersion === 1 && item.preStart === true && !item.isBackfilled &&
      hasCoordinate(item.latitude, item.longitude) && timestamp > 0 && timestamp <= toTimeValue(current) &&
      sanitizationDateKey(item.serverTime) === sanitizationDateKey(current)
  }

  async function validateSanitizationMedia(fileId, orderId, staffOpenid) {
    if (!safeFileId(fileId)) {
      throw new Error('请现场拍照并上传本订单的消毒照片')
    }
    if (typeof cloud.downloadFile === 'function') {
      try {
        const res = await cloud.downloadFile({ fileID: fileId })
        const buffer = res && res.fileContent
        if (Buffer.isBuffer(buffer)) {
          const image = buffer.length >= 12 && buffer.length <= 10 * 1024 * 1024 && (
            (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) ||
            buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
            (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP')
          )
          if (!image) throw new Error('消毒打卡必须上传有效图片（不超过10MB）')
        }
      } catch (error) {
        if (error && error.message && error.message.includes('10MB')) throw error
      }
    }
  }

  async function requireSanitizationEvidence(order, current = now()) {
    if (!requiresSanitization(order)) return
    const res = await db.collection('checkin_logs').where({ orderId: order._id, eventType: 'sanitization' }).get()
    const candidates = (res.data || []).filter((item) => isValidSanitization(item, order, current))
    for (const item of candidates) {
      try {
        await validateSanitizationMedia(item.mediaFileId, order._id, order.staffOpenid)
        return
      } catch (error) {}
    }
    throw new Error('请先完成本次服务开始前的消毒拍照打卡（须为当天有效照片）')
  }

  function normalizeServiceCheckinRule(rule = {}, validServiceKeys = defaultServicePrices.map((item) => item.key)) {
    const serviceType = safeText(rule.serviceType).trim()
    const eventType = safeText(rule.eventType).trim()
    if (!serviceType || !validServiceKeys.includes(serviceType)) throw new Error('服务类型无效')
    if (!CHECKIN_EVENT_TYPES.has(eventType)) throw new Error('打卡类型无效')
    return {
      serviceType,
      eventType,
      label: safeText(rule.label).trim() || checkinEventText(eventType),
      required: rule.required !== false,
      enabled: rule.enabled !== false,
      sortOrder: Number(rule.sortOrder || 100),
      description: safeText(rule.description).trim()
    }
  }

  async function listServiceCheckinRules() {
    const res = await db.collection('service_checkin_rules').orderBy('sortOrder', 'asc').get()
    const rules = res.data && res.data.length ? res.data : defaultServiceCheckinRules
    const validServiceKeys = (await listServicePrices(true)).map((item) => item.key)
    return rules
      .filter((rule) => validServiceKeys.includes(safeText(rule.serviceType).trim()))
      .map((rule) => normalizeServiceCheckinRule(rule, validServiceKeys))
      .sort((a, b) => String(a.serviceType).localeCompare(String(b.serviceType)) || Number(a.sortOrder || 0) - Number(b.sortOrder || 0))
  }

  async function resolveCheckinRequirements(serviceTypes) {
    const types = Array.isArray(serviceTypes) && serviceTypes.length ? serviceTypes : []
    const rules = await listServiceCheckinRules()
    const map = {}
    rules.filter((rule) => rule.enabled !== false && types.includes(rule.serviceType)).forEach((rule) => {
      const existing = map[rule.eventType]
      map[rule.eventType] = {
        eventType: rule.eventType,
        label: rule.label || checkinEventText(rule.eventType),
        required: Boolean(rule.required || (existing && existing.required)),
        serviceTypes: Array.from(new Set([...(existing ? existing.serviceTypes : []), rule.serviceType])),
        sortOrder: existing ? Math.min(Number(existing.sortOrder || 100), Number(rule.sortOrder || 100)) : Number(rule.sortOrder || 100),
        completed: false
      }
    })
    // Global requirement is snapshotted on new orders, independent of custom rules.
    map.sanitization = {
      eventType: 'sanitization', label: checkinEventText('sanitization'), required: true,
      serviceTypes: types, sortOrder: 5, completed: false, enforcementVersion: 1, beforeStart: true
    }
    if (types.length) {
      map.pet_beauty_photo = map.pet_beauty_photo || {
        eventType: 'pet_beauty_photo',
        label: checkinEventText('pet_beauty_photo'),
        required: false,
        serviceTypes: types,
        sortOrder: 999,
        completed: false,
        optional: true
      }
    }
    return Object.values(map).sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0))
  }

  return {
    requiredCheckins,
    requiresSanitization,
    sanitizationDateKey,
    isValidSanitization,
    validateSanitizationMedia,
    requireSanitizationEvidence,
    normalizeServiceCheckinRule,
    listServiceCheckinRules,
    resolveCheckinRequirements
  }
}
