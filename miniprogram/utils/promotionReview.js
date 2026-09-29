const { withOrderText, withCheckinText, formatCheckinEvent, formatOrderStatus, parseBeijingDate } = require('./format')

function hasNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
}

function coordinates(item) {
  const valid = hasNumber(item.latitude) && hasNumber(item.longitude) &&
    Math.abs(Number(item.latitude)) <= 90 && Math.abs(Number(item.longitude)) <= 180 &&
    !(Number(item.latitude) === 0 && Number(item.longitude) === 0)
  return {
    hasLocation: valid,
    canOpenLocation: valid && item.coordinateType === 'gcj02',
    latitude: valid ? Number(item.latitude) : null,
    longitude: valid ? Number(item.longitude) : null,
    coordinateText: valid ? `${Number(item.latitude).toFixed(6)}, ${Number(item.longitude).toFixed(6)}` : '未记录定位',
    locationSourceText: ({ gps: 'GPS 定位', manual: '手动定位' })[item.locationSource] || '定位来源未记录',
    accuracyText: hasNumber(item.accuracy) && Number(item.accuracy) > 0 ? `约 ${Number(item.accuracy).toFixed(0)} 米` : '未记录',
    distanceText: hasNumber(item.distanceKm) && Number(item.distanceKm) >= 0 ? `${(Number(item.distanceKm) * 1000).toFixed(0)} 米` : '未记录'
  }
}

function timeValue(value) {
  const date = parseBeijingDate(value)
  return date ? date.getTime() : 0
}

function money(value) {
  return hasNumber(value) ? `¥${Number(value).toFixed(2)}` : '未记录'
}

function buildPromotionOrder(item, index) {
  const order = withOrderText(item.order || {})
  const checkins = (item.checkins || []).filter(c => c && !c.deletedAt && !c.isDeleted && c.status !== 'deleted')
    .slice().sort((a, b) => timeValue(a.recordedAt || a.createdAt || a.serverTime) - timeValue(b.recordedAt || b.createdAt || b.serverTime))
    .map(c => ({
      ...withCheckinText(c), ...coordinates(c),
      recordedTime: c.recordedAt || c.createdAt || c.serverTime || '',
      uploadedTime: c.serverTime || c.createdAt || '',
      photoUrl: c.watermarkedMediaFileId || c.mediaFileId || '',
      originalUrl: c.mediaFileId || c.watermarkedMediaFileId || '',
      photoFailed: false,
      sourceText: c.source === 'admin' || c.eventType === 'admin_supplement' ? '管理员补充留证' : (c.staffOpenid ? '宠托师上传' : '上传人未记录'),
      remarkText: String(c.remark || c.note || '').trim() || '未填写打卡说明'
    }))
  const tracks = (item.tracks || []).map(t => ({ ...t, ...coordinates(t), recordedTime: t.recordedAt || t.createdAt || '' }))
  const required = Array.isArray(order.checkinRequirements) && order.checkinRequirements.length
    ? order.checkinRequirements
    : (order.requiredCheckins || []).map(eventType => ({ eventType, required: true }))
  const requirements = required.map(r => ({
    ...r, label: r.label || formatCheckinEvent(r.eventType),
    photoCount: checkins.filter(c => c.eventType === r.eventType && c.photoUrl).length
  }))
  const pets = (order.petSnapshots && order.petSnapshots.length ? order.petSnapshots : [order.petSnapshot].filter(Boolean))
    .map(p => ({ ...p, detailText: [({ cat: '猫', dog: '犬' })[p.species] || p.species, p.breed, ({ male: '公', female: '母' })[p.gender] || p.gender, p.weight ? `${p.weight} kg` : ''].filter(Boolean).join(' · ') }))
  const sessions = (order.serviceSessions || []).map((s, i) => {
    const start = timeValue(s.startedAt), finish = timeValue(s.finishedAt)
    return { ...s, index: s.index || i + 1, statusText: formatOrderStatus(s.status), actualDurationText: start && finish >= start ? `${Math.round((finish - start) / 60000)} 分钟` : '未完整记录' }
  })
  const warnings = []
  if (item.unavailable) warnings.push('关联订单不存在或已无法读取，请核实原始订单材料')
  if (!checkins.length && !item.unavailable) warnings.push('暂无有效打卡材料')
  const missingPhotoCount = checkins.filter(c => !c.photoUrl).length
  if (missingPhotoCount) warnings.push(`${missingPhotoCount} 条打卡未附照片`)
  const missing = requirements.filter(r => r.required && !r.photoCount).map(r => r.label)
  if (missing.length) warnings.push(`全单未发现必需环节照片：${missing.join('、')}`)
  if (order.autoCompleted) warnings.push('该订单包含系统自动完单，请核实实际履约情况')
  if (order.completionType === 'admin_manual') warnings.push('该订单由管理员核实完单')
  if (order.isOverdue) warnings.push('该订单存在超时履约记录')
  return {
    ...item, order, orderId: order._id, pets, sessions, requirements, warnings, checkins, tracks,
    checkinCount: checkins.length, photoCount: checkins.filter(c => c.photoUrl).length,
    backfilledCount: checkins.filter(c => c.isBackfilled).length, trackCount: tracks.length,
    photoUrls: checkins.map(c => c.photoUrl).filter(Boolean),
    originalUrls: checkins.map(c => c.originalUrl).filter(Boolean),
    trackPreview: tracks.slice(0, 20), trackVisibleCount: Math.min(tracks.length, 20), tracksExpanded: false,
    reviewTagsText: item.review && Array.isArray(item.review.tags) ? item.review.tags.join(' · ') : '',
    reviewText: item.review ? `${hasNumber(item.review.rating) ? item.review.rating + ' 分' : '未评分'}` : '暂无评价',
    amountText: money(order.amount), payAmountText: money(order.payAmount), discountText: money(order.discountAmount),
    completionText: order.completionType === 'admin_manual' ? '管理员核实完单' : (order.autoCompleted ? '包含系统自动完单' : '常规完单'),
    expanded: index === 0, detailsExpanded: false
  }
}

module.exports = { buildPromotionOrder }
