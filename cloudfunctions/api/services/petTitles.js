module.exports = function createService({
  addPoints,
  db,
  getMemberLevels,
  normalizeMemberBadgeStyle,
  normalizeMemberNameColor,
  normalizeMemberNameEffect,
  now,
  safeText
}) {
  function normalizeTitleIcon(value) {
    return safeText(value).trim().slice(0, 12)
  }

  function normalizeLevelIds(value) {
    if (!Array.isArray(value)) return []
    return Array.from(new Set(value.map((item) => safeText(item).trim()).filter(Boolean)))
  }

  function normalizeDuplicatePoints(value) {
    return Math.max(Math.round(Number(value || 0)), 0)
  }

  function normalizePetTitlePayload(data = {}) {
    const name = safeText(data.name).trim().slice(0, 16)
    if (!name) throw new Error('头衔名称不能为空')
    return {
      name,
      description: safeText(data.description).trim().slice(0, 100),
      icon: normalizeTitleIcon(data.icon),
      nameColor: normalizeMemberNameColor(data.nameColor),
      nameEffect: normalizeMemberNameEffect(data.nameEffect),
      badgeStyle: normalizeMemberBadgeStyle(data.badgeStyle),
      duplicatePoints: normalizeDuplicatePoints(data.duplicatePoints),
      autoGrantLevelIds: normalizeLevelIds(data.autoGrantLevelIds),
      enabled: data.enabled !== false,
      sortOrder: Number(data.sortOrder || 0)
    }
  }

  function titleSnapshot(title = {}) {
    return {
      _id: safeText(title._id).trim(),
      name: safeText(title.name).trim(),
      description: safeText(title.description).trim(),
      icon: normalizeTitleIcon(title.icon),
      nameColor: normalizeMemberNameColor(title.nameColor),
      nameEffect: normalizeMemberNameEffect(title.nameEffect),
      badgeStyle: normalizeMemberBadgeStyle(title.badgeStyle),
      duplicatePoints: normalizeDuplicatePoints(title.duplicatePoints)
    }
  }

  function normalizeInventoryTitle(inventory = {}, title = null) {
    const snapshot = title ? titleSnapshot(title) : (inventory.titleSnapshot || {})
    return {
      _id: inventory._id,
      inventoryId: inventory._id,
      titleId: inventory.titleId || snapshot._id || '',
      title: snapshot,
      equippedPetId: inventory.equippedPetId || '',
      sourceType: inventory.sourceType || '',
      sourceId: inventory.sourceId || '',
      createdAt: inventory.createdAt || '',
      updatedAt: inventory.updatedAt || ''
    }
  }

  async function listPetTitles(options = {}) {
    const includeDeleted = options.includeDeleted === true
    const onlyEnabled = options.onlyEnabled === true
    const res = await db.collection('pet_titles').orderBy('sortOrder', 'asc').get()
    return (res.data || [])
      .filter((item) => includeDeleted || !item.deletedAt)
      .filter((item) => !onlyEnabled || item.enabled !== false)
      .map((item) => ({ ...item, ...titleSnapshot(item), enabled: item.enabled !== false, deletedAt: item.deletedAt || null, autoGrantLevelIds: normalizeLevelIds(item.autoGrantLevelIds), sortOrder: Number(item.sortOrder || 0) }))
      .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || safeText(a.name).localeCompare(safeText(b.name), 'zh-Hans-CN'))
  }

  async function getPetTitle(titleId, options = {}) {
    const id = safeText(titleId).trim()
    if (!id) throw new Error('缺少头衔 ID')
    const title = (await db.collection('pet_titles').doc(id).get()).data
    if (!title || (!options.includeDeleted && title.deletedAt)) throw new Error('宠物头衔不存在')
    if (options.onlyEnabled && title.enabled === false) throw new Error('宠物头衔已停用')
    return { _id: id, ...title }
  }

  async function savePetTitle(data = {}) {
    const payload = normalizePetTitlePayload(data)
    const levels = await getMemberLevels()
    const levelIds = new Set(levels.map((level) => level._id))
    const invalidLevelId = payload.autoGrantLevelIds.find((id) => !levelIds.has(id))
    if (invalidLevelId) throw new Error('选择的会员等级不存在')
    const existing = await listPetTitles({ includeDeleted: true })
    const duplicate = existing.find((item) => item.name === payload.name && item._id !== data._id && !item.deletedAt)
    if (duplicate) throw new Error('已存在同名宠物头衔')
    const time = now()
    if (data._id) {
      await db.collection('pet_titles').doc(data._id).update({ data: { ...payload, updatedAt: time, deletedAt: null } })
      return { _id: data._id, ...payload, updatedAt: time, deletedAt: null }
    }
    const created = await db.collection('pet_titles').add({ data: { ...payload, deletedAt: null, createdAt: time, updatedAt: time } })
    return { _id: created._id, ...payload, deletedAt: null, createdAt: time, updatedAt: time }
  }

  async function deletePetTitle(titleId) {
    const id = safeText(titleId).trim()
    if (!id) throw new Error('缺少头衔 ID')
    const time = now()
    await db.collection('pet_titles').doc(id).update({ data: { enabled: false, deletedAt: time, updatedAt: time } })
    return { _id: id, deletedAt: time }
  }

  async function findOwnedTitle(openid, titleId) {
    const res = await db.collection('user_pet_titles').where({ openid, titleId }).limit(1).get()
    return res.data[0] || null
  }

  async function findGrant(sourceKey) {
    const key = safeText(sourceKey).trim()
    if (!key) return null
    const res = await db.collection('pet_title_grants').where({ sourceKey: key }).limit(1).get()
    return res.data[0] || null
  }

  async function grantPetTitleToUser(user, titleId, options = {}) {
    const title = await getPetTitle(titleId, { includeDeleted: true })
    const sourceType = safeText(options.sourceType).trim() || 'admin'
    const sourceId = safeText(options.sourceId).trim()
    const sourceKey = safeText(options.sourceKey).trim() || `${sourceType}:${sourceId || user.openid}:${title._id}`
    const previousGrant = await findGrant(sourceKey)
    if (previousGrant) return previousGrant
    const time = now()
    const existing = await findOwnedTitle(user.openid, title._id)
    let result
    if (existing) {
      const compensationPoints = normalizeDuplicatePoints(options.duplicatePoints !== undefined ? options.duplicatePoints : title.duplicatePoints)
      let pointsResult = null
      if (compensationPoints > 0) {
        pointsResult = await addPoints(user.openid, user._id, compensationPoints, 'pet_title_duplicate', sourceKey, `重复获得宠物头衔【${title.name}】补偿`, { baseDelta: compensationPoints })
      }
      result = {
        openid: user.openid,
        userId: user._id,
        titleId: title._id,
        sourceType,
        sourceId,
        sourceKey,
        outcome: 'compensated',
        inventoryId: existing._id,
        compensationPoints: pointsResult ? pointsResult.delta : compensationPoints,
        titleSnapshot: titleSnapshot(title),
        createdAt: time
      }
    } else {
      const inventoryData = {
        userId: user._id,
        openid: user.openid,
        titleId: title._id,
        titleSnapshot: titleSnapshot(title),
        equippedPetId: '',
        sourceType,
        sourceId,
        createdAt: time,
        updatedAt: time
      }
      const created = await db.collection('user_pet_titles').add({ data: inventoryData })
      result = {
        openid: user.openid,
        userId: user._id,
        titleId: title._id,
        sourceType,
        sourceId,
        sourceKey,
        outcome: 'owned',
        inventoryId: created._id,
        compensationPoints: 0,
        titleSnapshot: inventoryData.titleSnapshot,
        createdAt: time
      }
    }
    await db.collection('pet_title_grants').add({ data: result })
    return result
  }

  async function listUserPetTitles(openid) {
    const inventoryRes = await db.collection('user_pet_titles').where({ openid }).get()
    const inventory = inventoryRes.data || []
    if (!inventory.length) return []
    const titles = await listPetTitles({ includeDeleted: true })
    const titleMap = new Map(titles.map((title) => [title._id, title]))
    return inventory.map((item) => normalizeInventoryTitle(item, titleMap.get(item.titleId))).sort((a, b) => safeText(a.title.name).localeCompare(safeText(b.title.name), 'zh-Hans-CN'))
  }

  async function decoratePetsWithEquippedTitles(pets = []) {
    const ids = Array.from(new Set((pets || []).map((pet) => safeText(pet.equippedTitleInventoryId).trim()).filter(Boolean)))
    if (!ids.length) return pets.map((pet) => ({ ...pet, equippedTitle: null }))
    const inventoryRes = await db.collection('user_pet_titles').get()
    const inventoryMap = new Map((inventoryRes.data || []).filter((item) => ids.includes(item._id)).map((item) => [item._id, item]))
    const titles = await listPetTitles({ includeDeleted: true })
    const titleMap = new Map(titles.map((title) => [title._id, title]))
    return pets.map((pet) => {
      const inventory = inventoryMap.get(safeText(pet.equippedTitleInventoryId).trim())
      if (!inventory) return { ...pet, equippedTitle: null }
      return { ...pet, equippedTitle: normalizeInventoryTitle(inventory, titleMap.get(inventory.titleId)).title }
    })
  }

  async function equipPetTitle(openid, petId, inventoryId) {
    const pid = safeText(petId).trim()
    const iid = safeText(inventoryId).trim()
    if (!pid) throw new Error('缺少宠物 ID')
    if (!iid) throw new Error('请选择要佩戴的头衔')
    const pet = (await db.collection('pets').doc(pid).get()).data
    if (!pet || pet.openid !== openid) throw new Error('无权访问宠物')
    const inventory = (await db.collection('user_pet_titles').doc(iid).get()).data
    if (!inventory || inventory.openid !== openid) throw new Error('无权使用该头衔')
    const time = now()
    const previousInventoryId = safeText(pet.equippedTitleInventoryId).trim()
    const previousPetId = safeText(inventory.equippedPetId).trim()
    if (previousPetId && previousPetId !== pid) {
      await db.collection('pets').doc(previousPetId).update({ data: { equippedTitleInventoryId: '', updatedAt: time } })
    }
    if (previousInventoryId && previousInventoryId !== iid) {
      await db.collection('user_pet_titles').doc(previousInventoryId).update({ data: { equippedPetId: '', updatedAt: time } })
    }
    await db.collection('user_pet_titles').doc(iid).update({ data: { equippedPetId: pid, updatedAt: time } })
    await db.collection('pets').doc(pid).update({ data: { equippedTitleInventoryId: iid, updatedAt: time } })
    const title = await getPetTitle(inventory.titleId, { includeDeleted: true })
    return { petId: pid, inventoryId: iid, equippedTitle: normalizeInventoryTitle({ _id: iid, ...inventory, equippedPetId: pid }, title).title }
  }

  async function unequipPetTitle(openid, petId) {
    const pid = safeText(petId).trim()
    if (!pid) throw new Error('缺少宠物 ID')
    const pet = (await db.collection('pets').doc(pid).get()).data
    if (!pet || pet.openid !== openid) throw new Error('无权访问宠物')
    const inventoryId = safeText(pet.equippedTitleInventoryId).trim()
    const time = now()
    if (inventoryId) await db.collection('user_pet_titles').doc(inventoryId).update({ data: { equippedPetId: '', updatedAt: time } })
    await db.collection('pets').doc(pid).update({ data: { equippedTitleInventoryId: '', updatedAt: time } })
    return { petId: pid }
  }

  async function releasePetTitleForPet(petId) {
    const pid = safeText(petId).trim()
    if (!pid) return
    const res = await db.collection('user_pet_titles').where({ equippedPetId: pid }).get()
    const time = now()
    for (const item of res.data || []) {
      await db.collection('user_pet_titles').doc(item._id).update({ data: { equippedPetId: '', updatedAt: time } })
    }
  }

  async function grantEligiblePetTitlesForUser(user) {
    const levelId = safeText(user.memberLevel).trim()
    if (!levelId) return []
    const titles = await listPetTitles({ onlyEnabled: true })
    const matched = titles.filter((title) => normalizeLevelIds(title.autoGrantLevelIds).includes(levelId))
    const results = []
    for (const title of matched) {
      results.push(await grantPetTitleToUser(user, title._id, {
        sourceType: 'member_level',
        sourceId: levelId,
        sourceKey: `member:${user.openid}:${title._id}`,
        duplicatePoints: 0
      }))
    }
    return results
  }

  async function grantEligiblePetTitlesForUsers(users = []) {
    const results = []
    for (const user of users) {
      const granted = await grantEligiblePetTitlesForUser(user)
      results.push(...granted)
    }
    return results
  }

  return {
    normalizePetTitlePayload,
    titleSnapshot,
    normalizeInventoryTitle,
    listPetTitles,
    getPetTitle,
    savePetTitle,
    deletePetTitle,
    grantPetTitleToUser,
    listUserPetTitles,
    decoratePetsWithEquippedTitles,
    equipPetTitle,
    unequipPetTitle,
    releasePetTitleForPet,
    grantEligiblePetTitlesForUser,
    grantEligiblePetTitlesForUsers
  }
}
