module.exports = function createHandler(context) {
  const {
    db,
    getUser,
    safeText
  } = context
  // The 3D playground is an isolated, opt-in feature. Load its database
  // service only when the playground handler is first invoked so normal API
  // cold starts do not pay for it.
  const {
    getOrCreateClientPlayground,
    getOrCreatePetHome,
    getOrCreatePlaygroundEntity
  } = require('../services/playground')(context)
  return async function playground(openid, action, data) {
    await getUser(openid)
    if (action === 'getOverview') {
      const playground = await getOrCreateClientPlayground(openid)
      const petRes = await db.collection('pets').where({ openid }).orderBy('createdAt', 'desc').get()
      const pets = (petRes.data || []).filter((pet) => !pet.deletedAt && ['cat', 'dog'].includes(pet.species || 'dog')).slice(0, Number(playground.maxVisiblePets || 8))
      const homes = []
      const entities = []
      for (let index = 0; index < pets.length; index += 1) {
        const pet = pets[index]
        const home = await getOrCreatePetHome(openid, playground._id, pet, index)
        const entity = await getOrCreatePlaygroundEntity(openid, playground._id, pet, home, index)
        homes.push(home)
        entities.push(entity)
      }
      return {
        playground,
        pets: pets.map((pet) => ({
          _id: pet._id,
          name: safeText(pet.name),
          species: pet.species === 'cat' ? 'cat' : 'dog',
          breed: safeText(pet.breed),
          avatarFileId: safeText(pet.avatarFileId),
          personality: safeText(pet.personality),
          gender: safeText(pet.gender),
          customModelUrl: safeText(pet.customModelUrl || pet.customModelFileId)
        })),
        homes,
        entities,
        defaults: {
          theme: playground.theme || 'sunny_garden',
          maxVisiblePets: Number(playground.maxVisiblePets || 8)
        }
      }
    }
    if (action === 'updatePetModel') {
      const petId = safeText(data && data.petId)
      if (!petId) throw new Error('缺少宠物ID')
      const modelUrl = safeText(data && (data.modelUrl || data.customModelUrl))
      const scale = typeof data?.scale === 'number' && data.scale > 0 ? Number(data.scale) : 1
      const petRes = await db.collection('pets').where({ _id: petId, openid }).limit(1).get()
      if (!petRes.data || !petRes.data[0]) throw new Error('宠物档案不存在或无权配置')
      const time = (context.nowText && context.nowText()) || new Date().toISOString()
      await db.collection('pets').doc(petId).update({
        data: {
          customModelUrl: modelUrl,
          updatedAt: time
        }
      })
      const entityRes = await db.collection('pet_playground_entities').where({ ownerOpenid: openid, petId }).limit(1).get()
      if (entityRes.data && entityRes.data[0]) {
        await db.collection('pet_playground_entities').doc(entityRes.data[0]._id).update({
          data: {
            activeModelType: modelUrl ? 'custom' : 'default',
            activeModelUrl: modelUrl,
            scale,
            updatedAt: time
          }
        })
      }
      return {
        success: true,
        petId,
        customModelUrl: modelUrl,
        scale
      }
    }
    throw new Error('未知 playground 操作')
  }
}

