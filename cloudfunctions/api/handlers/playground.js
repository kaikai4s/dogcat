module.exports = function createHandler(context) {
  const {
    db,
    getOrCreateClientPlayground,
    getOrCreatePetHome,
    getOrCreatePlaygroundEntity,
    getUser,
    safeText
  } = context
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
          gender: safeText(pet.gender)
        })),
        homes,
        entities,
        defaults: {
          theme: playground.theme || 'sunny_garden',
          maxVisiblePets: Number(playground.maxVisiblePets || 8)
        }
      }
    }
    throw new Error('未知 playground 操作')
  }
}
