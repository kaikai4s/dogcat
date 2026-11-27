const LARGE_DOG_WEIGHT_KG = 25

function isDogSpecies(species) {
  const s = String(species || '').trim().toLowerCase()
  if (!s) return true
  return ['dog', 'dogs', '狗', '狗狗'].includes(s)
}

function formatPetWeightText(weight) {
  const n = Number(weight)
  return Number.isFinite(n) && n > 0 ? `${Math.round(n * 100) / 100}kg` : ''
}

function isLargeDogPet(pet) {
  if (!pet || typeof pet !== 'object') return false
  const weight = Number(pet.weight)
  return isDogSpecies(pet.species || pet.type || pet.petType) && Number.isFinite(weight) && weight >= LARGE_DOG_WEIGHT_KG
}

function decoratePetSnapshot(pet = {}) {
  if (!pet || typeof pet !== 'object') return pet
  const weight = Number(pet.weight)
  const validWeight = Number.isFinite(weight) && weight > 0 ? Math.round(weight * 100) / 100 : 0
  return {
    ...pet,
    weight: validWeight,
    weightText: formatPetWeightText(validWeight),
    isLargeDog: isLargeDogPet(pet)
  }
}

function extractOrderPetSnapshots(order = {}) {
  if (!order || typeof order !== 'object') return []
  const raw = Array.isArray(order.petSnapshots) && order.petSnapshots.length
    ? order.petSnapshots
    : [order.petSnapshot].filter(Boolean)
  return raw.filter(Boolean).map(decoratePetSnapshot)
}

function summarizePetsForStaff(pets = []) {
  const decorated = (Array.isArray(pets) ? pets : []).filter(Boolean).map(decoratePetSnapshot)
  const petBriefs = decorated.map((p) => ({
    name: String(p.name || '宠物').trim() || '宠物',
    avatarFileId: String(p.avatarFileId || '').trim(),
    species: String(p.species || 'dog').trim() || 'dog',
    breed: String(p.breed || '').trim(),
    gender: String(p.gender || '').trim(),
    weight: p.weight,
    weightText: p.weightText,
    isLargeDog: p.isLargeDog
  }))
  const petPhotoUrls = Array.from(new Set(petBriefs.map((p) => p.avatarFileId).filter(Boolean)))
  let petWeightSummary = ''
  if (petBriefs.length === 1) {
    petWeightSummary = petBriefs[0].weightText || '未填体重'
  } else if (petBriefs.length > 1) {
    const items = petBriefs.slice(0, 3).map((p) => `${p.name} ${p.weightText || '未填体重'}`)
    petWeightSummary = petBriefs.length > 3 ? `${items.join('、')} 等${petBriefs.length}只` : items.join('、')
  }
  const largeDogs = petBriefs
    .filter((p) => p.isLargeDog)
    .map((p) => ({
      name: p.name,
      breed: p.breed,
      weight: p.weight,
      weightText: p.weightText,
      label: `${p.breed ? `${p.breed}「${p.name}」` : p.name}(${p.weightText})`
    }))
  const hasLargeDog = largeDogs.length > 0
  const largeDogSummaryText = hasLargeDog
    ? `大型犬提醒：${largeDogs.map((d) => d.label).join('、')}`
    : ''
  return {
    petBriefs,
    petPhotoUrls,
    petAvatar: petPhotoUrls[0] || '',
    petWeightSummary,
    hasLargeDog,
    largeDogs,
    largeDogSummaryText
  }
}

function decorateOrderPetSummary(order = {}) {
  if (!order || typeof order !== 'object') return order
  const snapshots = extractOrderPetSnapshots(order)
  const summary = summarizePetsForStaff(snapshots)
  return {
    ...order,
    petSnapshot: snapshots[0] || order.petSnapshot || null,
    petSnapshots: snapshots.length ? snapshots : order.petSnapshots,
    ...summary
  }
}

function summarizeBundlePets(bundleOrders = []) {
  const allPets = (Array.isArray(bundleOrders) ? bundleOrders : []).flatMap(extractOrderPetSnapshots)
  return summarizePetsForStaff(allPets)
}

module.exports = {
  LARGE_DOG_WEIGHT_KG,
  isDogSpecies,
  formatPetWeightText,
  isLargeDogPet,
  decoratePetSnapshot,
  extractOrderPetSnapshots,
  summarizePetsForStaff,
  decorateOrderPetSummary,
  summarizeBundlePets
}
