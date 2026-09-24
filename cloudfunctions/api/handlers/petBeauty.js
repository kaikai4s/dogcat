module.exports = function createHandler(context) {
  const {
    checkImageSecurity,
    countPetBeautyVotes,
    db,
    ensurePetExclusiveId,
    getUser,
    isPetBeautyMonthLocked,
    listPetBeautyTitles,
    setPetBeautyTitle,
    normalizeBeautyPhoto,
    normalizeBeautyPhotos,
    normalizeMonthKey,
    now,
    nowText,
    paginateList,
    petSpeciesText,
    requireAdmin,
    requireClientOrder,
    safeText,
    settlePetBeautyMonthlyRanking,
    toCstParts,
    toPetPublicBeautyView
  } = context
  return async function petBeauty(openid, action, data) {
    const today = toCstParts()
    const monthKey = normalizeMonthKey(data.monthKey || today.monthKey)

    if (action === 'listMyBeautyTitles') {
      return listPetBeautyTitles(openid, safeText(data.petId).trim())
    }
    if (action === 'equipBeautyTitle') {
      const selectedMonth = safeText(data.awardMonthKey).trim()
      if (!selectedMonth) throw new Error('请选择月度称号')
      return setPetBeautyTitle(openid, safeText(data.petId).trim(), selectedMonth)
    }
    if (action === 'unequipBeautyTitle') {
      return setPetBeautyTitle(openid, safeText(data.petId).trim(), '')
    }

    async function readBeautyCandidatePets(maxLimit = 1000) {
      const rows = []
      let cursor = ''
      while (rows.length < maxLimit) {
        const condition = {}
        if (cursor) condition._id = db.command.gt(cursor)
        const fetchLimit = Math.min(100, maxLimit - rows.length)
        const page = (await db.collection('pets').where(condition).orderBy('_id', 'asc').limit(fetchLimit).get()).data || []
        rows.push(...page)
        if (page.length < fetchLimit) break
        cursor = page[page.length - 1]._id
      }
      return rows.filter((pet) => !pet.deletedAt && Array.isArray(pet.beautyPhotos) && pet.beautyPhotos.length > 0)
    }

    async function getPublicPetsWithVotes() {
      const voteMap = await countPetBeautyVotes(monthKey)
      const candidatePets = await readBeautyCandidatePets()
      const pets = await Promise.all(candidatePets
        .map(async (pet) => {
          const exclusiveId = await ensurePetExclusiveId(pet)
          return toPetPublicBeautyView({ ...pet, exclusiveId }, voteMap[pet._id] || 0)
        }))
      return pets.sort((a, b) => Number(b.voteCount || 0) - Number(a.voteCount || 0) || String(a.petId).localeCompare(String(b.petId)))
    }

    async function todayVoteState() {
      if (!openid) return { hasVotedToday: false }
      const voted = await db.collection('pet_beauty_votes').where({ openid, dateKey: today.dateKey }).limit(1).get()
      return { hasVotedToday: Boolean(voted.data && voted.data[0]), votedPetId: voted.data && voted.data[0] ? voted.data[0].petId : '' }
    }

    if (action === 'listHistoryMonths') {
      const locksRes = await db.collection('pet_beauty_month_locks').where({ status: 'locked' }).orderBy('monthKey', 'desc').get()
      const months = (locksRes.data || []).map((item) => item.monthKey).filter(Boolean)
      return { months }
    }

    if (action === 'getActivityHome') {
      const [pets, voteState, locked] = await Promise.all([getPublicPetsWithVotes(), todayVoteState(), isPetBeautyMonthLocked(monthKey)])
      return { monthKey, locked, ...voteState, candidates: pets.slice(0, 12), ranking: pets.slice(0, 10) }
    }

    if (action === 'listCandidates') {
      const species = safeText(data.species).trim()
      const pets = (await getPublicPetsWithVotes()).filter((pet) => !species || pet.species === species)
      return paginateList(pets, data)
    }

    if (action === 'listRanking') {
      const keyword = safeText(data.keyword).trim().toUpperCase()
      const historyMonthKey = safeText(data.historyMonthKey).trim()
      if (historyMonthKey && historyMonthKey !== monthKey) {
        const histRes = await db.collection('pet_beauty_month_rankings').where({ monthKey: historyMonthKey, locked: true }).orderBy('rank', 'asc').get()
        const histList = (histRes.data || [])
          .filter((item) => !keyword || safeText(item.petExclusiveId).toUpperCase().includes(keyword) || safeText(item.petSnapshot && item.petSnapshot.name).toUpperCase().includes(keyword))
          .map((item) => ({ petId: item.petId, name: item.petSnapshot && item.petSnapshot.name || '', ageText: item.petSnapshot && item.petSnapshot.ageText || '', species: item.petSnapshot && item.petSnapshot.species || '', speciesText: petSpeciesText(item.petSnapshot && item.petSnapshot.species), avatarFileId: item.petSnapshot && item.petSnapshot.avatarFileId || '', beautyPhotos: item.petSnapshot && item.petSnapshot.beautyPhotos || [], exclusiveId: item.petExclusiveId || '', voteCount: item.voteCount || 0, rank: item.rank, beautyTitle: { monthKey: item.monthKey, rank: item.rank, title: item.title } }))
        return { ...paginateList(histList, data), monthKey: historyMonthKey, locked: true, isHistory: true }
      }
      const pets = (await getPublicPetsWithVotes())
        .map((pet, index) => ({ ...pet, rank: index + 1 }))
        .filter((pet) => !keyword || safeText(pet.exclusiveId).toUpperCase().includes(keyword) || safeText(pet.name).toUpperCase().includes(keyword))
      return paginateList(pets, data)
    }

    if (action === 'vote') {
      const user = await getUser(openid)
      if (await isPetBeautyMonthLocked(monthKey)) throw new Error('本月排行榜已锁定')

      // 1. 事前快速查重拦截
      const todayVote = await db.collection('pet_beauty_votes').where({ openid, dateKey: today.dateKey }).limit(1).get()
      if (todayVote.data && todayVote.data[0]) throw new Error('今天已经投过票了')

      const petId = safeText(data.petId).trim()
      if (!petId) throw new Error('请选择要投票的宠物')
      let pet = null
      try {
        const petRes = await db.collection('pets').doc(petId).get()
        pet = petRes ? petRes.data : null
      } catch (err) {
        pet = null
      }
      if (!pet || pet.deletedAt) throw new Error('宠物不存在')
      if (!Array.isArray(pet.beautyPhotos) || !pet.beautyPhotos.length) throw new Error('该宠物还没有美照')

      const exclusiveId = await ensurePetExclusiveId({ ...pet, _id: petId })
      const time = now()
      const voteId = `vote_${openid}_${today.dateKey}`

      // 2. 事务原子查重与写入确定性主键记录，强阻断并发重复刷票
      await db.runTransaction(async (tx) => {
        let existingVote = null
        try {
          const voteDoc = await tx.collection('pet_beauty_votes').doc(voteId).get()
          existingVote = voteDoc && voteDoc.data ? voteDoc.data : null
        } catch (e) {
          existingVote = null
        }
        if (existingVote) throw new Error('今天已经投过票了')

        await tx.collection('pet_beauty_votes').doc(voteId).set({
          data: {
            openid,
            userId: user._id,
            petId,
            petExclusiveId: exclusiveId,
            monthKey,
            dateKey: today.dateKey,
            createdAt: time
          }
        })
      }).catch((err) => {
        const msg = String(err.message || err.errMsg || '')
        if (msg.includes('already exists') || msg.includes('duplicate') || msg.includes('-502001') || msg.includes('今天已经投过票了')) {
          throw new Error('今天已经投过票了')
        }
        throw err
      })

      const voteMap = await countPetBeautyVotes(monthKey)
      return { petId, monthKey, dateKey: today.dateKey, hasVotedToday: true, voteCount: Number(voteMap[petId] || 0) }
    }

    if (action === 'importFromServiceCheckins') {
      const petId = safeText(data.petId).trim()
      const orderId = safeText(data.orderId).trim()
      const checkinIds = Array.isArray(data.checkinIds) ? data.checkinIds.map((id) => safeText(id).trim()).filter(Boolean) : []
      if (!petId || !orderId || !checkinIds.length) throw new Error('请选择要导入的美照')
      const { order } = await requireClientOrder(openid, orderId, '仅宠物主可导入美照')
      const orderPetIds = Array.isArray(order.petIds) && order.petIds.length ? order.petIds : [order.petId].filter(Boolean)
      if (!orderPetIds.includes(petId)) throw new Error('该宠物不属于此订单')
      const petRes = await db.collection('pets').doc(petId).get().catch(() => ({ data: null }))
      const pet = petRes && petRes.data
      if (!pet || pet.deletedAt || (pet.openid && pet.openid !== openid)) throw new Error('宠物不存在或无权操作')
      let currentPhotos = []
      if (Array.isArray(pet.beautyPhotos) && pet.beautyPhotos.length) {
        currentPhotos = pet.beautyPhotos
      } else if (pet.avatarFileId) {
        try {
          currentPhotos = normalizeBeautyPhotos([], pet.avatarFileId)
        } catch (e) {
          currentPhotos = []
        }
      }
      const checkins = await Promise.all(checkinIds.map(async (id) => ({ ...((await db.collection('checkin_logs').doc(id).get().catch(() => ({ data: null }))).data || {}), _id: id })))
      const imported = checkins
        .filter((item) => item.orderId === orderId && item.eventType === 'pet_beauty_photo' && !item.deletedAt && item.mediaFileId)
        .map((item, index) => normalizeBeautyPhoto({ fileId: item.mediaFileId, source: 'service_checkin', orderId, checkinId: item._id, createdAt: item.recordedAt || item.createdAt }, index))
        .filter(Boolean)
      const seen = new Set(currentPhotos.map((photo) => photo.fileId))
      const maxAllowed = Math.max(0, 9 - currentPhotos.length)
      if (maxAllowed <= 0) throw new Error('宠物美照已满9张，请先在每月1日删除后再导入')
      const additions = imported.filter((item) => item.fileId && !seen.has(item.fileId))
      if (!additions.length) throw new Error('未找到可导入的新美照')
      const allowedAdditions = additions.slice(0, maxAllowed)
      for (const item of allowedAdditions) {
        if (item.fileId) {
          await checkImageSecurity(openid, item.fileId, { scene: 3, label: '美照' })
        }
      }
      const beautyPhotos = currentPhotos.concat(allowedAdditions)
      await db.collection('pets').doc(petId).update({ data: { beautyPhotos, avatarFileId: pet.avatarFileId || (beautyPhotos[0] && beautyPhotos[0].fileId) || '', updatedAt: nowText() } })
      return { petId, importedCount: allowedAdditions.length, beautyPhotos }
    }

    if (action === 'deleteBeautyPhoto') {
      const todayInfo = toCstParts()
      if (todayInfo.dayNumber !== 1) throw new Error('每月1日才可以删除宠物美照')
      const petId = safeText(data.petId).trim()
      if (!petId) throw new Error('请选择宠物')
      const photoId = safeText(data.photoId).trim()
      const fileId = safeText(data.fileId).trim()
      const petRes = await db.collection('pets').doc(petId).get().catch(() => ({ data: null }))
      const pet = petRes && petRes.data
      if (!pet || pet.deletedAt || pet.openid !== openid) throw new Error('宠物不存在')
      const currentPhotos = Array.isArray(pet.beautyPhotos) ? pet.beautyPhotos : []
      const beautyPhotos = currentPhotos.filter((photo) => (photoId && photo.id !== photoId) || (fileId && photo.fileId !== fileId))
      if (beautyPhotos.length === currentPhotos.length) throw new Error('美照不存在')
      if (!beautyPhotos.length) throw new Error('至少保留一张宠物美照')
      const avatarFileId = beautyPhotos.some((photo) => photo.fileId === pet.avatarFileId) ? pet.avatarFileId : beautyPhotos[0].fileId
      await db.collection('pets').doc(petId).update({ data: { beautyPhotos, avatarFileId, updatedAt: nowText() } })
      return { petId, beautyPhotos, avatarFileId }
    }

    if (action === 'settleMonthlyRanking') {
      await requireAdmin(openid)
      return settlePetBeautyMonthlyRanking(monthKey, { force: data.force === true, source: 'admin_repair' })
    }

    throw new Error('未知 petBeauty 操作')
  }
}
