module.exports = function createHandler(context) {
  const { db, getUser, safeText } = context
  const worldService = require('../services/playground-world')
  const world = worldService.create(context)
  const shared = require('../services/playground-shared')(context)
  const {publicAppearance}=require('../services/playground-appearance-record')
  const {
    getOrCreateClientPlayground,
    getOrCreatePetHome,
    getOrCreatePlaygroundEntity
  } = require('../services/playground')(context)

  return async function playground(openid, action, data = {}) {
    const user = await getUser(openid)
    if (action === 'syncScene') return shared.sync(openid, data)
    if (action === 'getScene') return shared.snapshot(openid, data)
    if (action === 'vehicleAction') return shared.vehicles.action(openid,user,data)
    if (action === 'setVehicleSpeed') return shared.vehicles.speed(openid,user,data)
    if (action === 'movePet') return shared.commandPet(openid, data)
    if (action === 'interactPet') return shared.commandPet(openid, {...data,interact:true})
    if (action === 'getSocial') return shared.social.state(openid)
    if (action === 'requestFriend') return shared.social.request(openid,{...data,type:'friend'})
    if (action === 'requestVisit') return shared.social.request(openid,{...data,type:'visit'})
    if (action === 'respondRequest') return shared.social.respond(openid,data)
    if (action === 'removeFriend') return shared.social.removeFriend(openid,data)
    if (action === 'demolishPlot') {
      const old=await world.own(openid)
      const result=await world.demolish(openid,data)
      await shared.plotChanged(openid,old.plotId,true,old.communityId)
      return result
    }

    if (action === 'claimPlot') {
      const old=await world.own(openid),plot=await world.claim(openid,user,data)
      if(old&&old.plotId!==plot.id) await shared.plotChanged(openid,old.plotId,true,old.communityId)
      await shared.plotChanged(openid,plot.id)
      return {plot}
    }
    if (action === 'getRegion') return world.region(openid, user, data)
    if (action === 'getMapOverview') return world.mapOverview(openid, user, data)
    if (action === 'fillBowl') {
      const result=await world.fillBowl(openid,data)
      await shared.plotChanged(openid,data.plotId)
      return result
    }

    if (action === 'setPetScale') {
      const petId = typeof data.petId === 'string' ? data.petId.trim() : ''
      const scale = data.scale
      if (!petId || typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0.5 || scale > 2)
        throw new Error('宠物大小须在 50%～200% 之间')
      const result = await db.collection('pets').where({ _id: petId, openid }).get()
      const pet = (result.data || [])[0]
      if (!pet || pet.deletedAt) throw new Error('宠物不存在或无权修改')
      const playgroundScale = Math.round(scale * 100) / 100
      await db.collection('pets').where({ _id: petId, openid }).update({
        data: { playgroundScale }
      })
      await shared.petScale(openid, petId, playgroundScale)
      return { petId, scale: playgroundScale }
    }

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

    if (action !== 'getOverview' && action !== 'enterScene') throw new Error('未知 playground 操作')

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

    const scene = action === 'enterScene' ? await shared.enter(openid, user, data, pets) : null
    const userCommunity = scene ? scene.community : user.residentialCommunity || null
    const communityName =
      userCommunity && userCommunity.name
        ? String(userCommunity.name).trim()
        : ''
    const hasCommunity = Boolean(communityName)
    const neighbors = []
    const ownPlot = await world.own(openid)

    return {
      world: await world.config(),
      scene,
      plot: scene ? scene.plot : ownPlot ? world.publicPlot({ ...ownPlot, _id: ownPlot.plotId }, openid) : null,
      foodBowls: { dog: ownPlot && ownPlot.foodBowls && ownPlot.foodBowls.dog === 100 ? 100 : 0 },
      playground,
      userCommunity,
      hasCommunity,
      neighbors,
      pets: pets.map((pet) => ({
        _id: pet._id,
        name: safeText(pet.name),
        species: pet.species === 'cat' ? 'cat' : 'dog',
        appearance:publicAppearance(pet.playgroundAppearance,'pet',pet._id,openid),
        playgroundScale: Math.max(0.5, Math.min(2, Number(pet.playgroundScale) || 1)),
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
