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
    if (action === 'petAction') return shared.companions.action(openid,data)
    if (action === 'petRelief') return shared.companions.relief(openid,data)
    if (action === 'getFarm') return shared.farm.state(openid,data)
    if (action === 'getFarmCatalog') return require('../services/playground-farm-catalog').readCatalog(db)
    if (action === 'farmAction') return shared.farm.action(openid,data)
    if (action === 'rideRequest') return shared.rides.request(openid,data)
    if (action === 'rideRespond') return shared.rides.respond(openid,data)
    if (action === 'rideLeave') return shared.rides.leave(openid,data)
    if (action === 'movePet') return shared.commandPet(openid, data)
    if (action === 'interactPet') return shared.commandPet(openid, {...data,interact:true})
    if (action === 'getSocial') return shared.social.state(openid)
    if (action === 'requestFriend') return shared.social.request(openid,{...data,type:'friend'})
    if (action === 'requestVisit') return shared.social.request(openid,{...data,type:'visit'})
    if (action === 'respondRequest') return shared.social.respond(openid,data)
    if (action === 'removeFriend') return shared.social.removeFriend(openid,data)
    if (action === 'demolishPlot') {
      const old=await world.own(openid)
      const {released,...result}=await world.demolish(openid,data,shared.rides.beforeDemolish)
      await shared.publishRecords(released||[])
      await shared.plotChanged(openid,old.plotId,true,old.communityId)
      return result
    }
    const disputes = require('../services/playground-disputes')(context)
    const buildingsService = require('../services/playground-buildings')(context)
    if (action === 'getBuildingCatalog') return buildingsService.readCatalog()
    if (action === 'reportPoop') return disputes.reportPoop(openid, user, data)
    if (action === 'listDisputes') return disputes.listDisputes(openid, data)
    if (action === 'resolveDispute') return disputes.resolveDispute(openid, user, data)
    if (action === 'claimWeeklySalary') return disputes.claimWeeklySalary(openid, data)
    if (action === 'washVehicle') return disputes.washVehicle(openid, user, data)
    if (action === 'repairVehicle') {
      return {
        success: true,
        message: '车辆经过社区修理厂全面检修，制动、轮胎与引擎性能已恢复至最佳状态！'
      }
    }
    const justice = require('../services/playground-justice')(context)
    if (action === 'reportAccident') return justice.reportAccident(openid, user, data)
    if (action === 'listAccidents') return justice.listAccidents(openid, data)
    if (action === 'arrestDriver') return justice.arrestDriver(openid, user, data)
    if (action === 'releaseDriver') return justice.releaseDriver(openid, data)
    if (action === 'hospitalTreat') return justice.hospitalTreat(openid, user, data)

    if (action === 'hospitalCare') {
      const careType = data.careType === 'treat' ? 'treat' : 'wash'
      const petId = String(data.petId || '')
      if (careType === 'treat' && petId) {
        // 解除爱宠的生病与受伤状态，重获健康
        await db.collection('pet_playground_plots').where({ kind: 'resident', ownerOpenid: openid }).get().then(async (res) => {
          for (const doc of (res.data || [])) {
            const pets = (doc.pets || []).map((p) => {
              if (p.id === petId || p._id === petId) {
                return {
                  ...p,
                  sick: false,
                  injured: false,
                  sickReason: '',
                  needs: { ...(p.needs || {}), satiety: 100, hydration: 100, energy: 100 }
                }
              }
              return p
            })
            await db.collection('pet_playground_plots').doc(doc._id).update({ data: { pets } })
          }
        }).catch(() => {})
      }
      return {
        success: true,
        careType,
        message: careType === 'wash'
          ? '爱宠在宠物医院完成了精细洗护，毛发柔顺蓬松，洁净清爽！'
          : '爱宠在宠物医院完成了健康治疗与创伤恢复，生病状态已治愈，状态满格！'
      }
    }

    if (action === 'buildInYard') {
      if (data.buildingType === 'committee') {
        const existing = await disputes.getCommunityCommittee(data.sceneId)
        if (existing && existing.ownerOpenid !== openid) {
          throw new Error('当前社区已设立居委会，每个社区有且仅能有一个居委会')
        }
      }
      const plot = await world.buildInYard(openid, user, data)
      await shared.plotChanged(openid, plot.id)
      return { plot }
    }

    if (action === 'claimPlot') {
      if (data.buildingType === 'committee') {
        const existing = await disputes.getCommunityCommittee(data.sceneId)
        if (existing && existing.ownerOpenid !== openid) {
          throw new Error('当前社区已设立居委会，每个社区有且仅能有一个居委会')
        }
      }
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
      farmCatalog: await require('../services/playground-farm-catalog').readCatalog(db),
      scene,
      plot: scene ? scene.plot : ownPlot ? world.publicPlot({ ...ownPlot, _id: ownPlot.plotId }, openid) : null,
      foodBowls: { dog: Number(ownPlot&&ownPlot.foodBowls&&ownPlot.foodBowls.dog)||0, cat:Number(ownPlot&&ownPlot.foodBowls&&ownPlot.foodBowls.cat)||0 },
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
