const { readOptionalDocument } = require('../utils/documentPages')

module.exports = function createHandler(context) {
  const {
    checkImageSecurity,
    countPetBeautyVotes,
    clearPetBeautyVotesCache,
    db,
    ensurePetExclusiveId,
    getUser,
    getOptionalUser,
    createInviteCode,
    bindInviteRelation,
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
    safeFileId,
    safeText,
    settlePetBeautyMonthlyRanking,
    toCstParts,
    toPetPublicBeautyView,
    getSystemSettings
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
      // 扫描全平台有效宠物（未删除且包含美照或头像），确保全平台参赛宠物均按票数排进前 100
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
      return rows
        .filter((pet) => !pet.deletedAt && !pet.beautyContestDisqualified && ((Array.isArray(pet.beautyPhotos) && pet.beautyPhotos.length > 0) || pet.avatarFileId || pet.avatarUrl))
        .map((pet) => {
          const avatar = safeFileId(pet.avatarFileId || pet.avatarUrl) || safeText(pet.avatarFileId || pet.avatarUrl)
          if (!Array.isArray(pet.beautyPhotos) || !pet.beautyPhotos.length) {
            let beautyPhotos = []
            if (avatar) {
              try {
                beautyPhotos = normalizeBeautyPhotos([], avatar)
              } catch (_) {
                beautyPhotos = [{ id: `bp_${pet._id || '0'}`, fileId: avatar, source: 'pet_profile' }]
              }
            }
            return {
              ...pet,
              avatarFileId: avatar || pet.avatarFileId || '',
              beautyPhotos,
              hasBeautyPhotos: beautyPhotos.length > 0,
              beautyPhotoCount: beautyPhotos.length
            }
          }
          return pet
        })
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
      if (!openid) return { hasVotedToday: false, remainingVotesToday: 0, todayBonusVotes: 0, totalVotesToday: 1, usedVotesToday: 0 }
      const [votesRes, bonusVotesRes] = await Promise.all([
        db.collection('pet_beauty_votes').where({ openid, dateKey: today.dateKey }).get(),
        db.collection('pet_beauty_bonus_votes').where({ openid, dateKey: today.dateKey }).get().catch(() => ({ data: [] }))
      ])
      const todayVotes = votesRes.data || []
      const bonusVotes = (bonusVotesRes && bonusVotesRes.data) || []
      const totalAllowed = 1 + bonusVotes.length
      const remainingVotes = Math.max(0, totalAllowed - todayVotes.length)
      const lastVote = todayVotes[todayVotes.length - 1]
      return {
        hasVotedToday: remainingVotes === 0,
        remainingVotesToday: remainingVotes,
        todayBonusVotes: bonusVotes.length,
        totalVotesToday: totalAllowed,
        usedVotesToday: todayVotes.length,
        votedPetId: lastVote ? lastVote.petId : ''
      }
    }

    if (action === 'listHistoryMonths') {
      const locksRes = await db.collection('pet_beauty_month_locks').where({ status: 'locked' }).orderBy('monthKey', 'desc').get()
      const months = (locksRes.data || []).map((item) => item.monthKey).filter(Boolean)
      return { months }
    }

    if (action === 'getActivityHome') {
      const settings = typeof getSystemSettings === 'function' ? await getSystemSettings().catch(() => ({})) : {}
      const contestConfig = settings.petBeautyContest || {
        firstPrizeAmount: 500,
        rewardAmount: 500,
        posterFileId: '',
        posterUrl: '',
        bannerTitle: '最美爱宠月度大赛',
        bannerSubtitle: '晒出爱宠萌照 · 争夺月度冠军现金大奖与全服专属头衔',
        rulesSummary: '每月评选 · 每日投1票 · 邀请新用户当日+1票 · 榜首享现金大奖',
        detailedRules: ''
      }
      let userInviteCode = ''
      if (openid) {
        let user = typeof getOptionalUser === 'function' ? await getOptionalUser(openid) : null
        if (user) {
          const incomingInviteCode = safeText(data && data.inviteCode).trim().toUpperCase()
          const incomingInviterOpenid = safeText(data && data.inviterOpenid).trim()
          if (!safeText(user.inviterOpenid).trim() && (incomingInviteCode || incomingInviterOpenid) && typeof bindInviteRelation === 'function') {
            user = await bindInviteRelation(user, { inviteCode: incomingInviteCode, inviterOpenid: incomingInviterOpenid, bindingSource: 'share' }).catch(() => user)
          }
          if (!safeText(user.inviteCode).trim() && typeof createInviteCode === 'function') {
            userInviteCode = createInviteCode(user)
            await db.collection('users').doc(user._id).update({ data: { inviteCode: userInviteCode, updatedAt: now() } }).catch(() => {})
          } else {
            userInviteCode = safeText(user.inviteCode).trim().toUpperCase()
          }
        }
      }
      const [pets, voteState, locked] = await Promise.all([getPublicPetsWithVotes(), todayVoteState(), isPetBeautyMonthLocked(monthKey)])
      return {
        monthKey,
        locked,
        ...voteState,
        contestConfig,
        inviteCode: userInviteCode,
        userOpenid: openid || '',
        candidates: pets.slice(0, 12),
        ranking: pets.slice(0, 10)
      }
    }

    if (action === 'getContestConfig') {
      const settings = typeof getSystemSettings === 'function' ? await getSystemSettings().catch(() => ({})) : {}
      return settings.petBeautyContest || {
        firstPrizeAmount: 500,
        rewardAmount: 500,
        posterFileId: '',
        posterUrl: '',
        bannerTitle: '最美爱宠月度大赛',
        bannerSubtitle: '晒出爱宠萌照 · 争夺月度冠军现金大奖与全服专属头衔',
        rulesSummary: '每月评选 · 每日投1票 · 邀请新用户当日+1票 · 榜首享现金大奖',
        detailedRules: ''
      }
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
          .map((item) => ({
            petId: item.petId,
            name: item.petSnapshot && item.petSnapshot.name || '',
            ageText: item.petSnapshot && item.petSnapshot.ageText || '',
            species: item.petSnapshot && item.petSnapshot.species || '',
            speciesText: petSpeciesText(item.petSnapshot && item.petSnapshot.species),
            avatarFileId: item.petSnapshot && item.petSnapshot.avatarFileId || '',
            beautyPhotos: item.petSnapshot && item.petSnapshot.beautyPhotos || [],
            exclusiveId: item.petExclusiveId || '',
            voteCount: item.voteCount || 0,
            rank: item.rank,
            prizeAmount: item.prizeAmount || (item.rank === 1 ? (item.petSnapshot && item.petSnapshot.prizeAmount) : 0),
            beautyTitle: { monthKey: item.monthKey, rank: item.rank, title: item.title }
          }))
        return { ...paginateList(histList, data), monthKey: historyMonthKey, locked: true, isHistory: true }
      }
      const settings = typeof getSystemSettings === 'function' ? await getSystemSettings().catch(() => ({})) : {}
      const firstPrizeAmount = Number(settings?.petBeautyContest?.firstPrizeAmount ?? 500)
      const pets = (await getPublicPetsWithVotes())
        .map((pet, index) => ({
          ...pet,
          rank: index + 1,
          prizeAmount: (index === 0 ? firstPrizeAmount : 0)
        }))
        .filter((pet) => !keyword || safeText(pet.exclusiveId).toUpperCase().includes(keyword) || safeText(pet.name).toUpperCase().includes(keyword))
      return paginateList(pets, { ...data, pageSize: data.pageSize || 100 })
    }

    if (action === 'vote') {
      const user = await getUser(openid)
      if (await isPetBeautyMonthLocked(monthKey)) throw new Error('本月排行榜已锁定')

      // 1. 事前核查当日基础票数与邀请新用户额外获赠票数
      const [votesRes, bonusVotesRes] = await Promise.all([
        db.collection('pet_beauty_votes').where({ openid, dateKey: today.dateKey }).get(),
        db.collection('pet_beauty_bonus_votes').where({ openid, dateKey: today.dateKey }).get().catch(() => ({ data: [] }))
      ])
      const todayVotes = votesRes.data || []
      const bonusVotes = (bonusVotesRes && bonusVotesRes.data) || []
      const totalAllowed = 1 + bonusVotes.length
      const usedCount = todayVotes.length

      if (usedCount >= totalAllowed) {
        throw new Error('今天已经投过票了')
      }

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
      if (pet.beautyContestDisqualified) throw new Error('该宠物已被取消参赛资格')
      if (!Array.isArray(pet.beautyPhotos) || !pet.beautyPhotos.length) throw new Error('该宠物还没有美照')

      const exclusiveId = await ensurePetExclusiveId({ ...pet, _id: petId })
      const time = now()
      const voteId = usedCount === 0 ? `vote_${openid}_${today.dateKey}` : `vote_${openid}_${today.dateKey}_bonus_${usedCount}`

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

        // 事务内再次校验今日总票数，杜绝并发请求穿透刷票
        const currentTxVotes = await tx.collection('pet_beauty_votes').where({ openid, dateKey: today.dateKey }).get().catch(() => ({ data: [] }))
        if ((currentTxVotes.data || []).length >= totalAllowed) {
          throw new Error('今天已经投过票了')
        }

        await tx.collection('pet_beauty_votes').doc(voteId).set({
          data: {
            openid,
            userId: user._id,
            petId,
            petExclusiveId: exclusiveId,
            monthKey,
            dateKey: today.dateKey,
            isBonusVote: usedCount > 0,
            voteIndex: usedCount + 1,
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

      if (typeof clearPetBeautyVotesCache === 'function') {
        clearPetBeautyVotesCache(monthKey)
      }

      const voteMap = await countPetBeautyVotes(monthKey)
      const nextRemaining = Math.max(0, totalAllowed - (usedCount + 1))
      return {
        petId,
        monthKey,
        dateKey: today.dateKey,
        hasVotedToday: nextRemaining === 0,
        remainingVotesToday: nextRemaining,
        todayBonusVotes: bonusVotes.length,
        totalVotesToday: totalAllowed,
        voteCount: Number(voteMap[petId] || 0)
      }
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
      const hasBeautyPhotos = Boolean(beautyPhotos.length > 0)
      const beautyPhotoCount = beautyPhotos.length
      await db.collection('pets').doc(petId).update({
        data: {
          beautyPhotos,
          hasBeautyPhotos,
          beautyPhotoCount,
          avatarFileId: pet.avatarFileId || (beautyPhotos[0] && beautyPhotos[0].fileId) || '',
          updatedAt: nowText()
        }
      })
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
      const hasBeautyPhotos = Boolean(beautyPhotos.length > 0)
      const beautyPhotoCount = beautyPhotos.length
      await db.collection('pets').doc(petId).update({
        data: {
          beautyPhotos,
          hasBeautyPhotos,
          beautyPhotoCount,
          avatarFileId,
          updatedAt: nowText()
        }
      })
      return { petId, beautyPhotos, avatarFileId }
    }

    if (action === 'disqualifyPetBeautyCandidate') {
      await requireAdmin(openid)
      const petId = safeText(data.petId).trim()
      if (!petId) throw new Error('请选择要取消参赛资格的宠物')
      const reason = safeText(data.reason).trim() || '违反大赛规则，取消参赛资格'
      const petRes = await db.collection('pets').doc(petId).get().catch(() => ({ data: null }))
      const pet = petRes && petRes.data
      if (!pet) throw new Error('宠物不存在')
      const time = nowText()
      await db.collection('pets').doc(petId).update({
        data: {
          beautyContestDisqualified: true,
          disqualifiedReason: reason,
          disqualifiedAt: time,
          disqualifiedBy: openid,
          updatedAt: time
        }
      })
      return { petId, beautyContestDisqualified: true, disqualifiedReason: reason, disqualifiedAt: time }
    }

    if (action === 'reinstatePetBeautyCandidate') {
      await requireAdmin(openid)
      const petId = safeText(data.petId).trim()
      if (!petId) throw new Error('请选择要恢复参赛资格的宠物')
      const petRes = await db.collection('pets').doc(petId).get().catch(() => ({ data: null }))
      const pet = petRes && petRes.data
      if (!pet) throw new Error('宠物不存在')
      const time = nowText()
      await db.collection('pets').doc(petId).update({
        data: {
          beautyContestDisqualified: false,
          disqualifiedReason: '',
          disqualifiedAt: '',
          updatedAt: time
        }
      })
      return { petId, beautyContestDisqualified: false }
    }

    if (action === 'grantPetBeautyChampionPrize') {
      await requireAdmin(openid)
      const targetMonthKey = normalizeMonthKey(data.monthKey || monthKey)
      // 1. 查找该月份的第 1 名
      const rankingRes = await db.collection('pet_beauty_month_rankings').where({ monthKey: targetMonthKey, rank: 1 }).limit(1).get()
      const championRank = rankingRes.data && rankingRes.data[0]
      if (!championRank) throw new Error(`未找到 ${targetMonthKey} 月度排行榜第 1 名记录，请先执行月度锁榜结算`)

      const settings = typeof getSystemSettings === 'function' ? await getSystemSettings().catch(() => ({})) : {}
      const defaultPrize = Number(settings?.petBeautyContest?.firstPrizeAmount ?? 500)
      return db.runTransaction(async tx => {
        const rank = await readOptionalDocument(tx, 'pet_beauty_month_rankings', championRank._id)
        if (!rank || rank.monthKey !== targetMonthKey || rank.rank !== 1 || rank.petId !== championRank.petId) throw new Error('冠军榜单已变化，请刷新后重试')
        const petId = rank.petId
        const pet = await readOptionalDocument(tx, 'pets', petId) || rank.petSnapshot || {}
        const targetOpenid = safeText(pet.openid || rank.openid).trim()
        if (!targetOpenid) throw new Error('无法确定第 1 名宠物主人的账号身份')
        const prizeAmount = data.amount !== undefined ? Math.round(Number(data.amount) * 100) / 100 : Number(rank.prizeAmount || defaultPrize)
        if (!Number.isFinite(prizeAmount) || prizeAmount <= 0) throw new Error('奖金金额必须为大于 0 的数值')
        const earningId = `beauty_prize_${targetMonthKey}_${petId}`
        const existing = await readOptionalDocument(tx, 'user_asset_earnings', earningId)
        if (existing) throw new Error(`${targetMonthKey} 月度冠军奖金已发放至该用户可提现零钱，请勿重复发放`)
        const time = nowText()
        const title = `${targetMonthKey} 最美爱宠月度冠军现金大奖`
        const reason = safeText(data.remark).trim() || `${targetMonthKey} 最美爱宠大赛冠军【${pet.name || '爱宠'}】现金奖金直接发放`
        await tx.collection('user_asset_earnings').doc(earningId).set({
          data: {
            userOpenid: targetOpenid,
            sourceType: 'pet_beauty_champion_prize',
            sourceId: `${targetMonthKey}_${petId}`,
            monthKey: targetMonthKey,
            petId,
            petName: pet.name || '',
            title,
            amount: prizeAmount,
            status: 'available',
            activityEnabled: true,
            reason,
            grantedBy: openid,
            createdAt: time,
            availableAt: time,
            updatedAt: time
          }
        })
        await tx.collection('pet_beauty_month_rankings').doc(championRank._id).update({
          data: { prizeGranted: true, prizeGrantedAt: time, prizeEarningId: earningId, prizeAmount, updatedAt: time }
        })
        return { monthKey: targetMonthKey, petId, targetOpenid, prizeAmount, earningId, status: 'available', grantedAt: time }
      })
    }

    if (action === 'settleMonthlyRanking') {
      await requireAdmin(openid)
      return settlePetBeautyMonthlyRanking(monthKey, { force: data.force === true, source: 'admin_repair' })
    }

    if (action === 'syncBeautyPhotoFlags') {
      await requireAdmin(openid)
      let updatedCount = 0
      let cursor = ''
      while (true) {
        const condition = {}
        if (cursor) condition._id = db.command.gt(cursor)
        const page = (await db.collection('pets').where(condition).orderBy('_id', 'asc').limit(100).get()).data || []
        if (!page.length) break
        for (const p of page) {
          const hasBeautyPhotos = Boolean(!p.deletedAt && Array.isArray(p.beautyPhotos) && p.beautyPhotos.length > 0)
          const beautyPhotoCount = Array.isArray(p.beautyPhotos) ? p.beautyPhotos.length : 0
          if (p.hasBeautyPhotos !== hasBeautyPhotos || p.beautyPhotoCount !== beautyPhotoCount) {
            await db.collection('pets').doc(p._id).update({
              data: { hasBeautyPhotos, beautyPhotoCount, updatedAt: nowText() }
            })
            updatedCount += 1
          }
        }
        if (page.length < 100) break
        cursor = page[page.length - 1]._id
      }
      return { updatedCount }
    }

    throw new Error('未知 petBeauty 操作')
  }
}
