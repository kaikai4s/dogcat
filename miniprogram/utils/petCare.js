const RISK_MAP = {
  normal: { text: '常规照护', className: 'normal' },
  caution: { text: '需要留意', className: 'caution' },
  high: { text: '高风险照护', className: 'high' }
}

const HIGH_RISK_TAGS = ['护食', '需短牵', '爆冲', '怕噪音', '需喂药', '不可洗澡']

function normalizeServiceTypes(serviceTypes) {
  if (Array.isArray(serviceTypes)) return serviceTypes.map((item) => String(item || '').trim()).filter(Boolean)
  return String(serviceTypes || '').split(',').map((item) => item.trim()).filter(Boolean)
}

function hasWalkService(serviceTypes) {
  return normalizeServiceTypes(serviceTypes).includes('walk')
}

function getRiskInfo(riskLevel) {
  return RISK_MAP[riskLevel] || RISK_MAP.normal
}

function getPetSnapshots(order = {}) {
  return Array.isArray(order.petSnapshots) && order.petSnapshots.length ? order.petSnapshots : [order.petSnapshot].filter(Boolean)
}

function compactText(value) {
  return String(value || '').trim()
}

function buildPetCareSections(pet = {}, serviceTypes = []) {
  const walkingFirst = hasWalkService(serviceTypes)
  const baseSections = [
    { key: 'medicalCareNotes', label: '健康/用药', text: compactText(pet.medicalCareNotes || pet.healthNotes) },
    { key: 'feedingNotes', label: '喂食', text: compactText(pet.feedingNotes || pet.favoriteFood) },
    { key: 'toiletNotes', label: '如厕/清洁', text: compactText(pet.toiletNotes) },
    { key: 'walkingNotes', label: '遛狗', text: compactText(pet.walkingNotes) },
    { key: 'dislikes', label: '禁忌', text: compactText(pet.dislikes) },
    { key: 'specialNotes', label: '特殊备注', text: compactText(pet.specialNotes) },
    { key: 'emergencyContactNote', label: '紧急备注', text: compactText(pet.emergencyContactNote) }
  ].filter((item) => item.text)
  const priority = walkingFirst
    ? ['walkingNotes', 'dislikes', 'medicalCareNotes', 'feedingNotes', 'toiletNotes', 'emergencyContactNote', 'specialNotes']
    : ['feedingNotes', 'medicalCareNotes', 'toiletNotes', 'dislikes', 'emergencyContactNote', 'walkingNotes', 'specialNotes']
  return baseSections.sort((a, b) => priority.indexOf(a.key) - priority.indexOf(b.key))
}

function buildPetCareSummary(pet = {}, serviceTypes = []) {
  const risk = getRiskInfo(pet.riskLevel)
  const tags = Array.isArray(pet.careTags) ? pet.careTags.filter(Boolean).slice(0, 12) : []
  const sections = buildPetCareSections(pet, serviceTypes)
  const highlights = sections.slice(0, 2).map((item) => `${item.label}：${item.text}`)
  const isHighRisk = pet.riskLevel === 'high' || tags.some((tag) => HIGH_RISK_TAGS.includes(tag))
  return {
    name: pet.name || '宠物',
    riskLevel: pet.riskLevel || 'normal',
    riskLevelText: risk.text,
    riskClass: risk.className,
    tags,
    sections,
    highlights,
    isHighRisk,
    hasCareInfo: tags.length > 0 || sections.length > 0 || pet.riskLevel === 'high' || pet.riskLevel === 'caution',
    text: highlights.join('；') || '暂无特别注意事项'
  }
}

function getCareCompleteness(pet = {}) {
  const checks = [
    { label: '照片', ok: Boolean(pet.avatarFileId || (Array.isArray(pet.beautyPhotos) && pet.beautyPhotos.length)) },
    { label: '品种', ok: Boolean(compactText(pet.breed)) },
    { label: '体重', ok: Number(pet.weight || 0) > 0 },
    { label: '照护标签', ok: Array.isArray(pet.careTags) && pet.careTags.length > 0 },
    { label: '喂食说明', ok: Boolean(compactText(pet.feedingNotes || pet.favoriteFood)) },
    { label: '禁忌/害怕', ok: Boolean(compactText(pet.dislikes)) },
    { label: '紧急备注', ok: Boolean(compactText(pet.emergencyContactNote)) }
  ]
  const done = checks.filter((item) => item.ok).length
  return {
    score: Math.round(done * 100 / checks.length),
    missing: checks.filter((item) => !item.ok).map((item) => item.label),
    complete: done === checks.length
  }
}

function buildOrderCareCards(order = {}) {
  const serviceTypes = order.serviceTypes || order.serviceType || []
  return getPetSnapshots(order).map((pet) => buildPetCareSummary(pet, serviceTypes))
}

function buildCareContextSnapshot(order = {}) {
  const cards = buildOrderCareCards(order)
  return {
    snapshotText: cards.map((card) => `${card.name}｜${card.riskLevelText}${card.tags.length ? '｜' + card.tags.join('、') : ''}${card.text ? '｜' + card.text : ''}`).join('\n'),
    cards
  }
}

module.exports = {
  HIGH_RISK_TAGS,
  buildCareContextSnapshot,
  buildOrderCareCards,
  buildPetCareSections,
  buildPetCareSummary,
  getCareCompleteness,
  getPetSnapshots,
  getRiskInfo
}
