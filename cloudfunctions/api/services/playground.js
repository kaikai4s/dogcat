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
      y: 0,
      z: Number((Math.sin(angle) * zRadius).toFixed(2))
    }
  }

  function playgroundHomeStyle(species, index) {
    const catStyles = ['cream', 'pink', 'forest', 'blue']
    const dogStyles = ['wood', 'blue', 'cream', 'forest']
    const list = species === 'cat' ? catStyles : dogStyles
    return list[index % list.length]
  }

  async function getOrCreateClientPlayground(openid) {
    const res = await db.collection('pet_playgrounds').where({ ownerOpenid: openid }).limit(1).get()
    if (res.data && res.data[0]) return res.data[0]
    const time = nowText()
    const playground = {
      ownerOpenid: openid,
      name: '我的宠物乐园',
      theme: 'sunny_garden',
      level: 1,
      maxVisiblePets: 8,
      camera: { x: 0, y: 8, z: 12, targetX: 0, targetY: 0, targetZ: 0 },
      unlockedAreas: ['main_garden'],
      createdAt: time,
      updatedAt: time
    }
    const created = await db.collection('pet_playgrounds').add({ data: playground })
    return { _id: created._id, ...playground }
  }

  async function getOrCreatePetHome(openid, playgroundId, pet, index) {
    const res = await db.collection('pet_homes').where({ ownerOpenid: openid, petId: pet._id }).limit(1).get()
    if (res.data && res.data[0]) return res.data[0]
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
      rotation: { x: 0, y: 0, z: 0 },
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
    if (res.data && res.data[0]) return res.data[0]
    const position = playgroundPosition(index, 5.2)
    const species = pet.species === 'cat' ? 'cat' : 'dog'
    const time = nowText()
    const entity = {
      ownerOpenid: openid,
      playgroundId,
      petId: pet._id,
      species,
      activeModelType: 'default',
      activeModelId: '',
      activeModelUrl: '',
      homeId: home._id,
      position,
      rotation: { x: 0, y: 0, z: 0 },
      scale: species === 'cat' ? 0.85 : 1,
      currentAction: 'idle',
      mood: 'happy',
      equippedClothesId: '',
      equippedOutfitModelId: '',
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
