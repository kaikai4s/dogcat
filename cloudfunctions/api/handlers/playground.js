module.exports = function createHandler(context) {
  const { db, getUser, safeText } = context
  const worldService = require('../services/playground-world')
  const world = worldService.create(context)
  const {
    getOrCreateClientPlayground,
    getOrCreatePetHome,
    getOrCreatePlaygroundEntity
  } = require('../services/playground')(context)

  return async function playground(openid, action, data = {}) {
    const user = await getUser(openid)

    if (action === 'claimPlot')
      return { plot: await world.claim(openid, user, data) }
    if (action === 'getRegion') return world.region(openid, user, data)

    if (action === 'saveCommunity') {
      const community = data.community || null
      let normalizedCommunity = null
      if (community && community.name) {
        normalizedCommunity = {
          name: safeText(community.name).trim(),
          address: safeText(community.address || '').trim(),
          latitude: Number(community.latitude || 0),
          longitude: Number(community.longitude || 0),
          city: safeText(community.city || '').trim(),
          district: safeText(community.district || '').trim(),
          updatedAt: context.nowText
            ? context.nowText()
            : new Date().toISOString()
        }
      }
      await worldService.updateCommunity(
        db,
        openid,
        user._id,
        normalizedCommunity,
        {
          updatedAt: context.nowText
            ? context.nowText()
            : new Date().toISOString()
        }
      )
      return { residentialCommunity: normalizedCommunity }
    }

    if (action !== 'getOverview') throw new Error('未知 playground 操作')

    const playground = await getOrCreateClientPlayground(openid)
    const petRes = await db
      .collection('pets')
      .where({ openid })
      .orderBy('createdAt', 'desc')
      .get()
    const pets = (petRes.data || [])
      .filter(
        (pet) => !pet.deletedAt && ['cat', 'dog'].includes(pet.species || 'dog')
      )
      .slice(0, Number(playground.maxVisiblePets || 8))
    const homes = []
    const entities = []

    for (let index = 0; index < pets.length; index += 1) {
      const pet = pets[index]
      const home = await getOrCreatePetHome(openid, playground._id, pet, index)
      const entity = await getOrCreatePlaygroundEntity(
        openid,
        playground._id,
        pet,
        home,
        index
      )
      homes.push(home)
      entities.push(entity)
    }

    const userCommunity = user.residentialCommunity || null
    const communityName =
      userCommunity && userCommunity.name
        ? String(userCommunity.name).trim()
        : ''
    const hasCommunity = Boolean(communityName)
    const neighbors = []

    return {
      world: await world.config(),
      plot: await world
        .own(openid)
        .then((p) =>
          p ? world.publicPlot({ ...p, _id: p.plotId }, openid) : null
        ),
      playground,
      userCommunity,
      hasCommunity,
      neighbors,
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
}
