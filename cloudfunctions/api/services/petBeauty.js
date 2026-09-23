module.exports = function createService({
  db,
  getAllDocuments,
  normalizeMonthKey,
  now,
  nowText,
  parseDateValue,
  safeFileId,
  safeText,
  toCstParts
}) {
  function normalizeBeautyPhoto(item = {}, index = 0) {
    const fileId = safeFileId(item.fileId || item.mediaFileId) || safeText(item.fileId || item.mediaFileId)
    if (!fileId) return null
    const time = item.createdAt || nowText()
    return {
      id: safeText(item.id).trim() || `bp_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`,
      fileId,
      source: ['pet_profile', 'service_checkin'].includes(item.source) ? item.source : 'pet_profile',
      orderId: safeText(item.orderId).trim(),
      checkinId: safeText(item.checkinId || item._id).trim(),
      createdAt: time,
      updatedAt: item.updatedAt || time
    }
  }

  function normalizeBeautyPhotos(input = [], fallbackAvatarFileId = '') {
    const source = Array.isArray(input) ? input : []
    const photos = source.map(normalizeBeautyPhoto).filter(Boolean)
    const seen = new Set()
    const unique = photos.filter((photo) => {
      if (seen.has(photo.fileId)) return false
      seen.add(photo.fileId)
      return true
    }).slice(0, 9)
    const avatarFileId = safeFileId(fallbackAvatarFileId) || safeText(fallbackAvatarFileId)
    if (!unique.length && avatarFileId) unique.push(normalizeBeautyPhoto({ fileId: avatarFileId, source: 'pet_profile' }, 0))
    if (!unique.length) throw new Error('请上传至少一张宠物美照')
    if (unique.length > 9) throw new Error('宠物美照最多上传9张')
    return unique
  }

  async function generatePetExclusiveId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let code = 'P'
      for (let i = 0; i < 6; i += 1) code += chars[Math.floor(Math.random() * chars.length)]
      const existing = await db.collection('pets').where({ exclusiveId: code }).limit(1).get()
      if (!existing.data || !existing.data[0]) return code
    }
    return `P${Date.now().toString(36).slice(-6).toUpperCase()}`
  }

  async function ensurePetExclusiveId(pet = {}) {
    if (pet.exclusiveId) return pet.exclusiveId
    const exclusiveId = await generatePetExclusiveId()
    if (pet._id) await db.collection('pets').doc(pet._id).update({ data: { exclusiveId, updatedAt: nowText() } })
    pet.exclusiveId = exclusiveId
    return exclusiveId
  }

  function formatPetAgeText(birthday) {
    const birth = parseDateValue(birthday)
    if (!birth) return '年龄未知'
    const today = toCstParts()
    const nowDate = new Date(`${today.monthKey}-${today.day}T00:00:00+08:00`)
    let months = (nowDate.getFullYear() - birth.getFullYear()) * 12 + nowDate.getMonth() - birth.getMonth()
    if (nowDate.getDate() < birth.getDate()) months -= 1
    if (months < 1) return '未满1个月'
    if (months < 12) return `${months}个月`
    const years = Math.floor(months / 12)
    const rest = months % 12
    return rest ? `${years}岁${rest}个月` : `${years}岁`
  }

  function petSpeciesText(species) {
    return ({ dog: '狗狗', cat: '猫咪', other: '异宠' })[species] || '宠物'
  }

  function toPetPublicBeautyView(pet = {}, voteCount = 0) {
    const beautyPhotos = Array.isArray(pet.beautyPhotos) ? pet.beautyPhotos : []
    return {
      petId: pet._id || pet.id || '',
      name: pet.name || '毛孩子',
      ageText: formatPetAgeText(pet.birthday),
      species: pet.species || '',
      speciesText: petSpeciesText(pet.species),
      avatarFileId: pet.avatarFileId || (beautyPhotos[0] && beautyPhotos[0].fileId) || '',
      beautyPhotos,
      beautyTitle: pet.beautyTitle || null,
      exclusiveId: pet.exclusiveId || '',
      voteCount: Number(voteCount || 0)
    }
  }

  function formatPetBeautyTitle(monthKey, rank) {
    const month = Number(String(monthKey || '').slice(5, 7)) || toCstParts().month
    return Number(rank) === 1 ? `${Number(month)}月最美爱宠` : `${Number(month)}月第${rank}爱宠`
  }

  function currentMonthStart(monthKey) {
    return new Date(`${normalizeMonthKey(monthKey)}-01T00:00:00+08:00`)
  }

  function nextMonthStart(monthKey) {
    const [year, month] = normalizeMonthKey(monthKey).split('-').map(Number)
    return new Date(year, month, 1, -8, 0, 0, 0)
  }

  async function countPetBeautyVotes(monthKey) {
    const start = currentMonthStart(monthKey)
    const end = nextMonthStart(monthKey)
    const votes = []
    let cursor = ''
    const maxLimit = 5000
    while (votes.length < maxLimit) {
      const condition = { monthKey }
      if (cursor) condition._id = db.command.gt(cursor)
      const fetchLimit = Math.min(100, maxLimit - votes.length)
      const res = await db.collection('pet_beauty_votes').where(condition).orderBy('_id', 'asc').limit(fetchLimit).get()
      const page = res.data || []
      votes.push(...page)
      if (page.length < fetchLimit) break
      cursor = page[page.length - 1]._id
    }
    return votes.filter((vote) => {
      const created = parseDateValue(vote.createdAt)
      return !created || (created >= start && created < end)
    }).reduce((map, vote) => {
      if (!vote.petId) return map
      map[vote.petId] = (map[vote.petId] || 0) + 1
      return map
    }, {})
  }

  async function isPetBeautyMonthLocked(monthKey) {
    const locked = await db.collection('pet_beauty_month_locks').where({ monthKey, status: 'locked' }).limit(1).get()
    return Boolean(locked.data && locked.data[0])
  }

  async function settlePetBeautyMonthlyRanking(monthKey = toCstParts().monthKey, options = {}) {
    monthKey = normalizeMonthKey(monthKey)
    if (!options.force && await isPetBeautyMonthLocked(monthKey)) return { monthKey, locked: true, skipped: true }
    const voteMap = await countPetBeautyVotes(monthKey)
    const allPets = await getAllDocuments('pets', 'createdAt', 'desc')
    const ranked = allPets
      .filter((pet) => Array.isArray(pet.beautyPhotos) && pet.beautyPhotos.length)
      .map((pet) => ({ pet, voteCount: Number(voteMap[pet._id] || 0) }))
      .filter((item) => item.voteCount > 0)
      .sort((a, b) => b.voteCount - a.voteCount || String(a.pet.createdAt || '').localeCompare(String(b.pet.createdAt || '')))
      .slice(0, 100)
    const lockedAt = now()
    await Promise.all(ranked.map(async ({ pet, voteCount }, index) => {
      const rank = index + 1
      const exclusiveId = await ensurePetExclusiveId(pet)
      const title = formatPetBeautyTitle(monthKey, rank)
      const beautyTitle = { monthKey, rank, title, awardedAt: lockedAt }
      await db.collection('pet_beauty_month_rankings').add({ data: { monthKey, petId: pet._id, petExclusiveId: exclusiveId, rank, voteCount, locked: true, title, petSnapshot: toPetPublicBeautyView({ ...pet, exclusiveId, beautyTitle }, voteCount), lockedAt, createdAt: lockedAt, updatedAt: lockedAt } })
      await db.collection('pets').doc(pet._id).update({ data: { beautyTitle, updatedAt: nowText() } })
    }))
    await db.collection('pet_beauty_month_locks').add({ data: { monthKey, status: 'locked', topCount: ranked.length, lockedAt, source: options.source || 'manual', createdAt: lockedAt, updatedAt: lockedAt } })
    return { monthKey, locked: true, topCount: ranked.length }
  }

  return {
    normalizeBeautyPhoto,
    normalizeBeautyPhotos,
    generatePetExclusiveId,
    ensurePetExclusiveId,
    formatPetAgeText,
    petSpeciesText,
    toPetPublicBeautyView,
    formatPetBeautyTitle,
    currentMonthStart,
    nextMonthStart,
    countPetBeautyVotes,
    isPetBeautyMonthLocked,
    settlePetBeautyMonthlyRanking
  }
}
