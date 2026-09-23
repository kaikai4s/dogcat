module.exports = function createService({
  db
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
      exclusiveId: pet.exclusiveId || '',
      beautyTitle: pet.beautyTitle || null
    }
  }

  return {
    normalizePetIds,
    getClientPetsByIds,
    createPetSnapshot
  }
}
