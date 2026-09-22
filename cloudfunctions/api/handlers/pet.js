module.exports = function createHandler(context) {
  const {
    callCloudbaseExtendAi,
    checkImageSecurity,
    checkTextSecurity,
    cloud,
    db,
    decoratePetsWithEquippedTitles,
    ensurePetExclusiveId,
    equipPetTitle,
    generatePetExclusiveId,
    getSystemSettings,
    getUser,
    listUserPetTitles,
    normalizeBeautyPhotos,
    nowText,
    paginateList,
    releasePetTitleForPet,
    parsePetRecognitionText,
    recordAiLog,
    safeFileId,
    safeNumber,
    safeText,
    toCstParts,
    unequipPetTitle
  } = context
  return async function pet(openid, action, data) {
    const user = await getUser(openid)
    if (action === 'listPets') {
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const species = safeText(data.species).trim()
      const res = await db.collection('pets').where({ openid }).orderBy('createdAt', 'desc').get()
      const list = await Promise.all((res.data || [])
        .filter((pet) => !species || pet.species === species)
        .filter((pet) => !keyword || [pet.name, pet.breed, pet.personality, pet.specialNotes, pet.healthNotes, pet.exclusiveId].some((value) => safeText(value).toLowerCase().includes(keyword)))
        .map(async (pet) => {
          const exclusiveId = await ensurePetExclusiveId(pet)
          const beautyPhotos = Array.isArray(pet.beautyPhotos) && pet.beautyPhotos.length ? pet.beautyPhotos : normalizeBeautyPhotos([], pet.avatarFileId)
          return { ...pet, exclusiveId, beautyPhotos }
        }))
      const decorated = await decoratePetsWithEquippedTitles(list)
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(decorated, data) : decorated
    }
    if (action === 'getPet') {
      const res = await db.collection('pets').doc(data.id).get()
      if (res.data.openid !== openid) throw new Error('无权访问')
      const exclusiveId = await ensurePetExclusiveId(res.data)
      const beautyPhotos = Array.isArray(res.data.beautyPhotos) && res.data.beautyPhotos.length ? res.data.beautyPhotos : normalizeBeautyPhotos([], res.data.avatarFileId)
      const decorated = await decoratePetsWithEquippedTitles([{ ...res.data, exclusiveId, beautyPhotos }])
      return decorated[0]
    }
    if (action === 'listMyTitles') {
      return listUserPetTitles(openid)
    }
    if (action === 'equipTitle') {
      return equipPetTitle(openid, data.petId || data.id, data.inventoryId)
    }
    if (action === 'unequipTitle') {
      return unequipPetTitle(openid, data.petId || data.id)
    }
    if (action === 'recognizePetBreed') {
      const settings = await getSystemSettings()
      if (settings.enablePetBreedAi === false) throw new Error('AI 识别功能已关闭')
      const avatarFileId = safeText(data.avatarFileId || data.photoFileId)
      let imageUrl = safeText(data.imageUrl).trim()
      const imageBase64 = safeText(data.imageBase64).trim()
      let imageSource = imageUrl ? 'imageUrl' : ''

      if (!avatarFileId && !imageUrl && !imageBase64) throw new Error('请先上传宠物照片再进行AI识别')

      if (!imageUrl && avatarFileId && avatarFileId.startsWith('cloud://')) {
        try {
          if (typeof cloud.getTempFileURL !== 'function') throw new Error('当前云函数 SDK 不支持 getTempFileURL')
          const fileRes = await cloud.getTempFileURL({ fileList: [avatarFileId] })
          const fileItem = fileRes && fileRes.fileList && fileRes.fileList[0]
          imageUrl = safeText(fileItem && fileItem.tempFileURL).trim()
          if (imageUrl) imageSource = 'avatarFileId'
        } catch (error) {
          console.error('[云函数AI识图] getTempFileURL 失败:', error.message || error)
        }
      }

      if (!imageUrl && imageBase64) {
        imageUrl = imageBase64.startsWith('data:image/') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`
        imageSource = 'imageBase64'
      }

      if (!imageUrl) throw new Error('照片链接生成失败，请重新上传照片后再试')

      const requestedModel = safeText(data.model).trim() || 'qwen3.5-flash'
      const modelsToTry = Array.from(new Set([requestedModel, 'qwen3.5-flash', 'qwen3.5-plus', 'glm-4v-flash', 'glm-4v-plus', 'glm-5v-turbo']))
      const promptText = '请详细描述并识别照片中的宠物：包括宠物类型（狗狗/猫咪/异宠）、判断出的具体品种名称，以及外貌毛色形态特征。字数在120字以内。最后单独一行返回格式如 {"species":"dog","breed":"柯基"} 的严格JSON，其中 species 只能是 dog、cat、other。'

      let aiResponse = null
      let extendAiError = null
      try {
        aiResponse = await callCloudbaseExtendAi(modelsToTry, imageUrl, promptText)
      } catch (error) {
        extendAiError = error
        console.warn('[云函数AI识图] cloud.extend.AI 全部失败，尝试 AI 网关:', error.message || error)
      }

      if (!aiResponse) {
        const reason = extendAiError && extendAiError.message ? extendAiError.message : '模型无响应'
        throw new Error(`AI 识别服务暂不可用，请检查云开发 AI 服务配置或重新部署 api 云函数：${reason}`)
      }

      const parsedResult = parsePetRecognitionText(aiResponse.rawAiContent)
      const aiMessage = `微信云开发 AI (${aiResponse.modelName}) 识别分析完成`
      await recordAiLog(openid, {
        avatarFileId,
        modelName: aiResponse.modelName,
        source: aiResponse.source,
        rawResponse: aiResponse.rawAiContent,
        species: parsedResult.species,
        breed: parsedResult.breed,
        aiMessage: parsedResult.aiResultText
      })

      return {
        ...parsedResult,
        aiMessage,
        modelName: aiResponse.modelName,
        source: aiResponse.source,
        imageSource
      }
    }
    if (action === 'createPet') {
      if (!data.name) throw new Error('宠物名称不能为空')
      if (!safeFileId(data.avatarFileId) && !safeText(data.avatarFileId)) throw new Error('请上传至少一张宠物照片')
      const petText = [data.name, data.breed, data.personality, data.specialNotes, data.favoriteFood, data.dislikes, data.healthNotes, data.aiGreeting, data.aiPersona].filter(Boolean).join(' ')
      if (petText) {
        await checkTextSecurity(openid, petText, { scene: 1, label: '宠物资料' })
      }
      if (data.avatarFileId) {
        await checkImageSecurity(openid, data.avatarFileId, { scene: 1, label: '宠物头像' })
      }
      const time = nowText()
      const beautyPhotos = normalizeBeautyPhotos(data.beautyPhotos, data.avatarFileId)
      const avatarFileId = safeFileId(data.avatarFileId) || safeText(data.avatarFileId) || beautyPhotos[0].fileId
      const pet = {
        userId: safeText(user._id),
        openid: safeText(openid),
        exclusiveId: await generatePetExclusiveId(),
        name: safeText(data.name),
        avatarFileId,
        beautyPhotos,
        beautyTitle: data.beautyTitle || null,
        equippedTitleInventoryId: '',
        species: safeText(data.species || 'dog'),
        breed: safeText(data.breed),
        gender: safeText(data.gender),
        birthday: safeText(data.birthday),
        weight: safeNumber(data.weight),
        personality: safeText(data.personality),
        favoriteFood: safeText(data.favoriteFood),
        dislikes: safeText(data.dislikes),
        healthNotes: safeText(data.healthNotes),
        aiInteractionEnabled: data.aiInteractionEnabled === true,
        aiPersona: safeText(data.aiPersona),
        aiGreeting: safeText(data.aiGreeting),
        specialNotes: safeText(data.specialNotes),
        createdAt: time,
        updatedAt: time
      }
      const created = await db.collection('pets').add({ data: pet })
      return { _id: created._id, ...pet }
    }
    if (action === 'updatePet') {
      const existing = await db.collection('pets').doc(data.id).get()
      if (existing.data.openid !== openid) throw new Error('无权访问')
      if (!safeFileId(data.avatarFileId) && !safeText(data.avatarFileId)) throw new Error('请上传至少一张宠物照片')
      const petText = [data.name, data.breed, data.personality, data.specialNotes, data.favoriteFood, data.dislikes, data.healthNotes, data.aiGreeting, data.aiPersona].filter(Boolean).join(' ')
      if (petText) {
        await checkTextSecurity(openid, petText, { scene: 1, label: '宠物资料' })
      }
      if (data.avatarFileId && data.avatarFileId !== existing.data.avatarFileId) {
        await checkImageSecurity(openid, data.avatarFileId, { scene: 1, label: '宠物头像' })
      }
      const exclusiveId = existing.data.exclusiveId || await generatePetExclusiveId()
      const beautyPhotos = normalizeBeautyPhotos(data.beautyPhotos, data.avatarFileId)
      const existingPhotos = Array.isArray(existing.data.beautyPhotos) && existing.data.beautyPhotos.length ? existing.data.beautyPhotos : normalizeBeautyPhotos([], existing.data.avatarFileId)
      const nextFileIds = new Set(beautyPhotos.map((photo) => photo.fileId))
      const hasDeletedPhoto = existingPhotos.some((photo) => !nextFileIds.has(photo.fileId))
      if (hasDeletedPhoto && toCstParts().dayNumber !== 1) throw new Error('每月1日才可以删除宠物美照')
      const avatarFileId = safeFileId(data.avatarFileId) || safeText(data.avatarFileId) || beautyPhotos[0].fileId
      await db.collection('pets').doc(data.id).update({ data: {
        name: safeText(data.name),
        exclusiveId,
        avatarFileId,
        beautyPhotos,
        species: safeText(data.species || 'dog'),
        breed: safeText(data.breed),
        gender: safeText(data.gender),
        birthday: safeText(data.birthday),
        weight: safeNumber(data.weight),
        personality: safeText(data.personality),
        favoriteFood: safeText(data.favoriteFood),
        dislikes: safeText(data.dislikes),
        healthNotes: safeText(data.healthNotes),
        aiInteractionEnabled: data.aiInteractionEnabled === true,
        aiPersona: safeText(data.aiPersona),
        aiGreeting: safeText(data.aiGreeting),
        specialNotes: safeText(data.specialNotes),
        updatedAt: nowText()
      } })
      return { id: data.id, exclusiveId, beautyPhotos, avatarFileId }
    }
    if (action === 'deletePet') {
      const existing = await db.collection('pets').doc(data.id).get()
      if (existing.data.openid !== openid) throw new Error('无权访问')
      await releasePetTitleForPet(data.id)
      await db.collection('pets').doc(data.id).remove()
      return { id: data.id }
    }
    throw new Error('未知 pet 操作')
  }
}
