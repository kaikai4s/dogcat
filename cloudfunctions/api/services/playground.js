module.exports = function createService({
  db,
  nowText,
  safeText
}) {
  function playgroundPosition(index, radius = 6) {
    const angle = (index / 8) * Math.PI * 2
    const zRadius = radius * 0.72
    return {
      x: Number((Math.cos(angle) * radius).toFixed(2)),
      z: Number((Math.sin(angle) * zRadius).toFixed(2))
    }
  }

  function playgroundHomeStyle(species, index) {
    const catStyles = ['cream', 'pink', 'forest', 'blue']
    const dogStyles = ['wood', 'blue', 'cream', 'forest']
    const list = species === 'cat' ? catStyles : dogStyles
    return list[index % list.length]
  }

  function normalizePosition(position) {
    const source = position || {}
    return {
      x: Number.isFinite(Number(source.x)) ? Number(source.x) : 0,
      z: Number.isFinite(Number(source.z)) ? Number(source.z) : 0
    }
  }

  function normalizePlayground(playground) {
    if (!playground) return playground
    const { camera, ...clean } = playground
    return clean
  }

  function normalizePetHome(home) {
    if (!home) return home
    const { rotation, ...clean } = home
    return { ...clean, position: normalizePosition(home.position) }
  }

  function normalizePlaygroundEntity(entity) {
    if (!entity) return entity
    const {
      activeModelType,
      activeModelId,
      activeModelUrl,
      equippedClothesId,
      equippedOutfitModelId,
      rotation,
      ...clean
    } = entity
    return { ...clean, position: normalizePosition(entity.position) }
  }

  async function getOrCreateClientPlayground(openid) {
    const res = await db.collection('pet_playgrounds').where({ ownerOpenid: openid }).limit(1).get()
    if (res.data && res.data[0]) return normalizePlayground(res.data[0])
    const time = nowText()
    const playground = {
      ownerOpenid: openid,
      name: '我的宠物乐园',
      theme: 'sunny_garden',
      level: 1,
      maxVisiblePets: 8,
      unlockedAreas: ['main_garden'],
      createdAt: time,
      updatedAt: time
    }
    const created = await db.collection('pet_playgrounds').add({ data: playground })
    return { _id: created._id, ...playground }
  }

  async function getOrCreatePetHome(openid, playgroundId, pet, index) {
    const res = await db.collection('pet_homes').where({ ownerOpenid: openid, petId: pet._id }).limit(1).get()
    if (res.data && res.data[0]) return normalizePetHome(res.data[0])
    const species = pet.species === 'cat' ? 'cat' : 'dog'
    const position = playgroundPosition(index, 8.2)
    const time = nowText()
    const home = {
      ownerOpenid: openid,
      playgroundId,
      petId: pet._id,
      species,
      homeType: species === 'cat' ? 'cat_nest' : 'dog_house',
      name: `${safeText(pet.name) || '宠物'}的小窝`,
      position,
      scale: 1,
      style: playgroundHomeStyle(species, index),
      createdAt: time,
      updatedAt: time
    }
    const created = await db.collection('pet_homes').add({ data: home })
    return { _id: created._id, ...home }
  }

  async function getOrCreatePlaygroundEntity(openid, playgroundId, pet, home, index) {
    const res = await db.collection('pet_playground_entities').where({ ownerOpenid: openid, petId: pet._id }).limit(1).get()
    if (res.data && res.data[0]) {
      return normalizePlaygroundEntity(res.data[0])
    }
    const position = playgroundPosition(index, 5.2)
    const species = pet.species === 'cat' ? 'cat' : 'dog'
    const time = nowText()
    const entity = {
      ownerOpenid: openid,
      playgroundId,
      petId: pet._id,
      species,
      homeId: home._id,
      position,
      scale: species === 'cat' ? 0.9 : 1,
      currentAction: 'idle',
      mood: 'happy',
      lastActionAt: time,
      nextActionAt: time,
      createdAt: time,
      updatedAt: time
    }
    const created = await db.collection('pet_playground_entities').add({ data: entity })
    return { _id: created._id, ...entity }
  }

  return {
    playgroundPosition,
    playgroundHomeStyle,
    getOrCreateClientPlayground,
    getOrCreatePetHome,
    getOrCreatePlaygroundEntity
  }
}
