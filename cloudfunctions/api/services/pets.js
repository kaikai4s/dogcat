module.exports = function createService({
  createPetVaccineSnapshot,
  db,
  decoratePetWithVaccineStatus,
  summarizeOrderPetVaccines
}) {
  function normalizePetIds(data = {}) {
    const raw = Array.isArray(data.petIds) && data.petIds.length ? data.petIds : [data.petId]
    return Array.from(new Set(raw.map((item) => String(item || '').trim()).filter(Boolean)))
  }

  async function getClientPetsByIds(openid, petIds) {
    if (!petIds.length) throw new Error('请选择宠物')
    const pets = await Promise.all(petIds.map(async (petId) => {
      const safeId = String(petId || '').trim()
      if (!safeId) throw new Error('宠物不存在')
      const res = await db.collection('pets').doc(safeId).get().catch(() => ({ data: null }))
      if (!res || !res.data || res.data.openid !== openid) throw new Error('宠物不存在')
      return { ...res.data, _id: res.data._id || safeId }
    }))
    return pets
  }

  function createPetSnapshot(pet = {}) {
    const decorated = decoratePetWithVaccineStatus ? decoratePetWithVaccineStatus(pet) : pet
    return {
      name: pet.name || '',
      avatarFileId: pet.avatarFileId || '',
      species: pet.species || '',
      breed: pet.breed || '',
      gender: pet.gender || '',
      birthday: pet.birthday || '',
      weight: Number(pet.weight || 0),
      personality: pet.personality || '',
      favoriteFood: pet.favoriteFood || '',
      dislikes: pet.dislikes || '',
      healthNotes: pet.healthNotes || '',
      specialNotes: pet.specialNotes || '',
      careTags: Array.isArray(pet.careTags) ? pet.careTags : [],
      feedingNotes: pet.feedingNotes || '',
      toiletNotes: pet.toiletNotes || '',
      walkingNotes: pet.walkingNotes || '',
      medicalCareNotes: pet.medicalCareNotes || '',
      emergencyContactNote: pet.emergencyContactNote || '',
      riskLevel: pet.riskLevel || 'normal',
      exclusiveId: pet.exclusiveId || '',
      beautyTitle: pet.beautyTitle || null,
      vaccineCertification: createPetVaccineSnapshot ? createPetVaccineSnapshot(pet) : (pet.vaccineCertification || { status: 'none' }),
      vaccineCertified: decorated.vaccineCertified === true,
      vaccineStatus: decorated.vaccineStatus || 'none',
      vaccineStatusText: decorated.vaccineStatusText || '未接种认证',
      vaccineBadgeText: decorated.vaccineBadgeText || '未接种认证',
      vaccineBadgeClass: decorated.vaccineBadgeClass || 'muted'
    }
  }

  function createOrderVaccineSummary(petSnapshots = []) {
    const summary = summarizeOrderPetVaccines ? summarizeOrderPetVaccines(petSnapshots) : { certifiedCount: 0, uncertifiedCount: petSnapshots.length, pendingCount: 0, rejectedCount: 0, expiredCount: 0 }
    const total = Array.isArray(petSnapshots) ? petSnapshots.length : 0
    return {
      vaccinePetSummary: summary,
      hasUnvaccinatedPets: total === 0 || summary.certifiedCount < total,
      allPetsVaccineCertified: total > 0 && summary.certifiedCount === total
    }
  }

  return {
    normalizePetIds,
    getClientPetsByIds,
    createPetSnapshot,
    createOrderVaccineSummary
  }
}
