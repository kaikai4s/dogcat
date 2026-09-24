const { requireStaffGender, normalizeStaffGenderRequirement, matchesStaffGender, assertStaffGenderMatches, isStaffProfileLocked } = require('../utils/staffGender')

module.exports = function createHandler(context) {
  const {
    saveStaffScheduleException,
    requestStaffDepositRefund,
    reserveStaffDepositPayment,
    assertPaymentModeAllowed,
    submitStaffSupplyOnce,
    DEFAULT_STAFF_TRAINING_QUIZ,
    ORDER_STATUS,
    amountYuanToFen,
    appendOrderClientMessage,
    appendOrderTimeline,
    appendPaymentEvent,
    assertOrderTransition,
    assignOrderAtomically,
    attachOrderDisplayData,
    buildMiniProgramPayParams,
    buildStaffAvailability,
    calcDistanceKm,
    calculateStaffEarningForOrder,
    canTakeOrders,
    checkAcceptOrderRisk,
    checkTextSecurity,
    createPaymentNo,
    db,
    enabledTrainingVideos,
    expireDueUnacceptedOrders,
    expireUnacceptedOrder,
    findByClientRequestId,
    findStaffOrderConflict,
    formatDistance,
    formatWeeklyScheduleText,
    getClientRequestId,
    getCompletedStaffOrders,
    getOptionalUser,
    getOrderTimeRanges,
    getStaffProfileByOpenid,
    getSystemSettings,
    getUser,
    getWechatPayConfig,
    readScopedDocuments,
    hasCoordinate,
    isAdminDeletedOrder,
    isOpenOrder,
    isTrainingComplete,
    makeIdempotencyKey,
    markStaffDepositPaid,
    maskClientName,
    maskOrderForStaffPreview,
    maskStaffName,
    matchText,
    normalizeCityName,
    normalizeScheduleException,
    normalizeStaffDepositConfig,
    normalizeStaffSuppliesConfig,
    normalizeStaffTrainingConfig,
    normalizeStaffWorkflow,
    normalizeVideoAuditGuide,
    normalizeWeeklySchedule,
    notifyOrderAccepted,
    now,
    orderMatchesCity,
    paginateList,
    publicTrainingQuiz,
    requireAdmin,
    safeFileId,
    safeText,
    sanitizeWechatPayload,
    sendUpcomingServiceRemindersToStaff,
    splitServiceAreas,
    staffDepositSatisfied,
    toPublicSitter,
    toPublicSitterDetail,
    toTimeValue,
    updateOrderWhenStatus,
    validateStaffTakeOrderAbility,
    validateStaffScheduleOnly,
    wechatPayRequest,
    withSitterUserProfile,
    batchWithSitterUserProfiles
  } = context
  async function readAll(collectionName, where = {}, maxLimit = 2000) {
    const rows = []
    let cursor = ''
    while (rows.length < maxLimit) {
      const condition = { ...where }
      if (cursor) condition._id = db.command.gt(cursor)
      const fetchLimit = Math.min(100, maxLimit - rows.length)
      const page = (await db.collection(collectionName).where(condition).orderBy('_id', 'asc').limit(fetchLimit).get()).data || []
      rows.push(...page)
      if (page.length < fetchLimit) return rows
      cursor = page[page.length - 1]._id
    }
    return rows
  }
  async function queryCandidateSitters(whereCondition = {}, maxLimit = 300) {
    const rows = []
    let cursor = ''
    while (rows.length < maxLimit) {
      const condition = { ...whereCondition }
      if (cursor) condition._id = db.command.gt(cursor)
      const fetchLimit = Math.min(100, maxLimit - rows.length)
      const page = (await db.collection('staff_profiles').where(condition).orderBy('_id', 'asc').limit(fetchLimit).get()).data || []
      rows.push(...page)
      if (page.length < fetchLimit) break
      cursor = page[page.length - 1]._id
    }
    return rows
  }
  return async function staff(openid, action, data) {
    if (action === 'listApprovedSitters') {
      const staffGenderRequirement = normalizeStaffGenderRequirement(data.staffGenderRequirement)
      const keyword = String(data.keyword || '').trim().toLowerCase()
      const serviceCity = String(data.serviceCity || '').trim()
      const serviceArea = String(data.serviceArea || '').trim()
      const sortBy = data.sortBy || 'default'
      const userLat = Number(data.latitude || 0)
      const userLng = Number(data.longitude || 0)
      const userHasLoc = hasCoordinate(userLat, userLng)

      const page = Math.max(Number(data.page || 1), 1)
      const pageSize = Math.min(Math.max(Number(data.pageSize || 20), 1), 50)
      const settings = await getSystemSettings().catch(() => ({}))

      // 1. 数据库条件下推：基础状态下推与城市下推
      const whereCondition = { auditStatus: 'approved' }
      if (staffGenderRequirement !== 'any') whereCondition.gender = staffGenderRequirement
      if (serviceCity) {
        const normFilterCity = normalizeCityName(serviceCity)
        if (normFilterCity) {
          const cityCandidates = [serviceCity, normFilterCity, `${normFilterCity}市`].filter(Boolean)
          whereCondition.serviceCity = db.command.in([...new Set(cityCandidates)])
        }
      }

      // 读取候选集（限制最大候选规模，避免全表无节制扫描）
      let rawCandidates = await queryCandidateSitters(whereCondition, 300)

      // 2. 内存初筛（城市、区域及履约资质过滤）
      rawCandidates = rawCandidates.filter((profile) => {
        if (!canTakeOrders(profile, settings.staffDeposit)) return false
        const areas = splitServiceAreas(profile.serviceAreas)
        if (serviceCity) {
          const normFilterCity = normalizeCityName(serviceCity)
          const normSitterCity = normalizeCityName(profile.serviceCity)
          if (normFilterCity && normSitterCity && normFilterCity !== normSitterCity) return false
        }
        if (serviceArea && !areas.includes(serviceArea)) return false
        return true
      })

      // 3. 关键词匹配优化：
      // 若有关键词，仅对初筛后的候选集批量装配用户信息（1次批量查询），再进行匹配；
      // 若无关键词，此时完全不需要查 users 表，留到分页截断后按需装配！
      let userEnriched = false
      if (keyword) {
        rawCandidates = await batchWithSitterUserProfiles(rawCandidates)
        userEnriched = true
        rawCandidates = rawCandidates.filter((profile) => {
          return matchText(profile.nickname, keyword) ||
                 matchText(profile.realName, keyword) ||
                 matchText(profile.serviceCity, keyword) ||
                 matchText(profile.serviceAreas, keyword)
        })
      }

      // 4. 计算距离与中间元数据
      const candidateList = rawCandidates.map((profile) => {
        const hasSitterLoc = hasCoordinate(profile.serviceLatitude, profile.serviceLongitude) && Boolean(profile.serviceAddress)
        const radiusKm = Math.max(Number(profile.serviceRadiusKm || 5), 1)
        const distanceKm = (userHasLoc && hasSitterLoc)
          ? calcDistanceKm(userLat, userLng, profile.serviceLatitude, profile.serviceLongitude)
          : null
        const inServiceRange = !userHasLoc || (distanceKm !== null && distanceKm <= radiusKm)
        return {
          profile,
          distanceKm,
          inServiceRange,
          canDirectBook: inServiceRange
        }
      })

      // 5. 稳定排序（带有 _id 兜底保证确定性无重复跳变）
      const compareRating = (a, b) => Number(b.profile.ratingAverage || 0) - Number(a.profile.ratingAverage || 0) || Number(b.profile.reviewCount || 0) - Number(a.profile.reviewCount || 0) || toTimeValue(b.profile.ratingUpdatedAt || b.profile.updatedAt) - toTimeValue(a.profile.ratingUpdatedAt || a.profile.updatedAt)
      const compareFeatured = (a, b) => {
        const featuredDiff = Number(b.profile.isFeatured === true) - Number(a.profile.isFeatured === true)
        if (featuredDiff) return featuredDiff
        if (a.profile.isFeatured === true && b.profile.isFeatured === true) return toTimeValue(b.profile.featuredAt) - toTimeValue(a.profile.featuredAt)
        return 0
      }
      const compareDefault = (a, b) => compareRating(a, b) || toTimeValue(b.profile.updatedAt) - toTimeValue(a.profile.updatedAt)
      const compareByMode = (a, b) => {
        if (sortBy === 'distance' && userHasLoc) return (a.distanceKm ?? 9999) - (b.distanceKm ?? 9999) || compareRating(a, b)
        if (sortBy === 'city') return String(a.profile.serviceCity || '').localeCompare(String(b.profile.serviceCity || '')) || String(a.profile.serviceAreas || '').localeCompare(String(b.profile.serviceAreas || '')) || compareRating(a, b)
        if (sortBy === 'latest') return toTimeValue(b.profile.updatedAt || b.profile.createdAt) - toTimeValue(a.profile.updatedAt || a.profile.createdAt) || compareRating(a, b)
        if (sortBy === 'rating') return compareRating(a, b)
        return compareDefault(a, b)
      }
      const compareTieBreaker = (a, b) => String(b.profile._id || '').localeCompare(String(a.profile._id || ''))

      candidateList.sort((a, b) => compareFeatured(a, b) || compareByMode(a, b) || compareTieBreaker(a, b))

      // 6. 分页截断：仅针对当前页
      const total = candidateList.length
      const start = (page - 1) * pageSize
      const pagedCandidates = candidateList.slice(start, start + pageSize)

      // 7. 当前页按需批量补充用户资料（若前面未查过，此时仅对当前页的至多 20 条发 1 次批量查询）
      let pagedProfiles = pagedCandidates.map((c) => c.profile)
      if (!userEnriched) {
        pagedProfiles = await batchWithSitterUserProfiles(pagedProfiles)
      }

      // 8. 构造公开 DTO（确保不泄漏坐标与敏感地址）
      const list = pagedCandidates.map((item, index) => {
        const fullProfile = pagedProfiles[index] || item.profile
        const publicData = toPublicSitter(fullProfile)
        if (!userHasLoc) return { ...publicData, inServiceRange: true, canDirectBook: true }
        return {
          ...publicData,
          distanceKm: item.distanceKm,
          distanceText: formatDistance(item.distanceKm),
          inServiceRange: item.inServiceRange,
          canDirectBook: item.canDirectBook,
          rangeStatusText: item.inServiceRange ? '服务范围内' : '超出服务范围'
        }
      })

      return {
        list,
        total,
        page,
        pageSize,
        hasMore: start + pageSize < total
      }
    }
    if (action === 'getPublicSitterDetail') {
      const user = await getOptionalUser(openid)
      const settings = await getSystemSettings().catch(() => ({}))
      const staffProfileId = safeText(data.staffProfileId).trim()
      if (!staffProfileId) throw new Error('宠托师不可用')
      const profileRes = await db.collection('staff_profiles').doc(staffProfileId).get().catch(() => ({ data: null }))
      const profile = profileRes && profileRes.data
      if (!profile || !canTakeOrders(profile, settings.staffDeposit)) throw new Error('宠托师不可用')
      const detail = await toPublicSitterDetail(user ? openid : '', await withSitterUserProfile(normalizeStaffWorkflow(profile)))

      const userLat = Number(data.latitude !== undefined ? data.latitude : (data.addressLatitude || 0))
      const userLng = Number(data.longitude !== undefined ? data.longitude : (data.addressLongitude || 0))
      const userHasLoc = hasCoordinate(userLat, userLng)
      const hasSitterLoc = hasCoordinate(profile.serviceLatitude, profile.serviceLongitude) && Boolean(profile.serviceAddress)
      const radiusKm = Math.max(Number(profile.serviceRadiusKm || 5), 1)

      let distanceKm = null
      let inServiceRange = true
      let canDirectBook = true
      let rangeStatusText = ''
      if (userHasLoc) {
        if (hasSitterLoc) {
          distanceKm = calcDistanceKm(userLat, userLng, profile.serviceLatitude, profile.serviceLongitude)
          inServiceRange = distanceKm !== null && distanceKm <= radiusKm
          canDirectBook = inServiceRange
          rangeStatusText = inServiceRange ? '服务范围内' : '超出服务范围'
        } else {
          inServiceRange = false
          canDirectBook = false
          rangeStatusText = '宠托师未设置有效常驻坐标'
        }
      }

      return {
        ...detail,
        distanceKm,
        distanceText: distanceKm !== null ? formatDistance(distanceKm) : '',
        inServiceRange,
        canDirectBook,
        rangeStatusText
      }
    }
    if (action === 'checkSitterRange') {
      const staffProfileId = safeText(data.staffProfileId).trim()
      if (!staffProfileId) throw new Error('请选择宠托师')
      const profileRes = await db.collection('staff_profiles').doc(staffProfileId).get().catch(() => ({ data: null }))
      const profile = profileRes && profileRes.data
      if (!profile) throw new Error('宠托师档案不存在')

      const userLat = Number(data.latitude !== undefined ? data.latitude : (data.addressLatitude || 0))
      const userLng = Number(data.longitude !== undefined ? data.longitude : (data.addressLongitude || 0))
      const userHasLoc = hasCoordinate(userLat, userLng)
      const hasSitterLoc = hasCoordinate(profile.serviceLatitude, profile.serviceLongitude) && Boolean(profile.serviceAddress)
      const radiusKm = Math.max(Number(profile.serviceRadiusKm || 5), 1)

      if (!hasSitterLoc) {
        return {
          ok: false,
          inServiceRange: false,
          canDirectBook: false,
          serviceRadiusKm: radiusKm,
          distanceKm: null,
          distanceText: '',
          message: '该宠托师尚未设置有效常驻服务地址坐标，无法指定预约'
        }
      }
      if (!userHasLoc) {
        return {
          ok: true,
          inServiceRange: true,
          canDirectBook: true,
          serviceRadiusKm: radiusKm,
          distanceKm: null,
          distanceText: '',
          message: ''
        }
      }

      const dist = calcDistanceKm(userLat, userLng, profile.serviceLatitude, profile.serviceLongitude)
      const inRange = dist !== null && dist <= radiusKm
      const distText = dist !== null ? formatDistance(dist) : ''
      return {
        ok: inRange,
        inServiceRange: inRange,
        canDirectBook: inRange,
        serviceRadiusKm: radiusKm,
        distanceKm: dist,
        distanceText: distText,
        message: inRange ? '' : `服务地址距宠托师服务区域约 ${distText}，超出其设定的 ${radiusKm}km 接单范围，无法指定预约`
      }
    }
    if (action === 'favoriteSitter') {
      const user = await getUser(openid)
      const settings = await getSystemSettings().catch(() => ({}))
      const staffProfileId = safeText(data.staffProfileId).trim()
      if (!staffProfileId) throw new Error('请选择宠托师')
      const profileRes = await db.collection('staff_profiles').doc(staffProfileId).get().catch(() => ({ data: null }))
      const profile = profileRes && profileRes.data
      if (!profile || !canTakeOrders(profile, settings.staffDeposit)) throw new Error('宠托师不可用')
      const existing = await db.collection('sitter_favorites').where({ openid, staffProfileId }).limit(1).get()
      if (existing.data[0]) return { staffProfileId, favorite: true }
      await db.collection('sitter_favorites').add({ data: { userId: user._id, openid, staffProfileId, createdAt: now() } })
      return { staffProfileId, favorite: true }
    }
    if (action === 'unfavoriteSitter') {
      await getUser(openid)
      const staffProfileId = safeText(data.staffProfileId).trim()
      if (!staffProfileId) return { staffProfileId: '', favorite: false }
      const existing = await db.collection('sitter_favorites').where({ openid, staffProfileId }).limit(1).get()
      if (existing.data[0]) await db.collection('sitter_favorites').doc(existing.data[0]._id).remove()
      return { staffProfileId, favorite: false }
    }
    if (action === 'listFavoriteSitters') {
      await getUser(openid)
      const settings = await getSystemSettings().catch(() => ({}))
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const userLat = Number(data.latitude !== undefined ? data.latitude : (data.addressLatitude || 0))
      const userLng = Number(data.longitude !== undefined ? data.longitude : (data.addressLongitude || 0))
      const userHasLoc = hasCoordinate(userLat, userLng)

      const favorites = await db.collection('sitter_favorites').where({ openid }).orderBy('createdAt', 'desc').get()
      const list = []
      for (let i = 0; i < favorites.data.length; i += 1) {
        try {
          const profileRes = await db.collection('staff_profiles').doc(favorites.data[i].staffProfileId).get()
          if (profileRes.data && canTakeOrders(profileRes.data, settings.staffDeposit)) {
            const rawProfile = profileRes.data
            const profile = await withSitterUserProfile(normalizeStaffWorkflow(rawProfile))
            const detail = await toPublicSitterDetail(openid, profile)
            let distanceKm = null
            let inServiceRange = true
            if (userHasLoc && hasCoordinate(rawProfile.serviceLatitude, rawProfile.serviceLongitude)) {
              distanceKm = calcDistanceKm(userLat, userLng, rawProfile.serviceLatitude, rawProfile.serviceLongitude)
              const radiusKm = Math.max(Number(rawProfile.serviceRadiusKm || 5), 1)
              inServiceRange = distanceKm !== null && distanceKm <= radiusKm
            }
            list.push({
              ...detail,
              distanceKm,
              distanceText: distanceKm !== null ? formatDistance(distanceKm) : '',
              inServiceRange,
              canDirectBook: inServiceRange,
              favorite: true
            })
          }
        } catch (error) {}
      }
      const filtered = list.filter((item) => !keyword || [item.displayName, item.serviceCity, item.serviceSummary, item.bio].some((value) => safeText(value).toLowerCase().includes(keyword)))
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(filtered, data) : filtered
    }
    if (action === 'getStaffProfile') {
      await getUser(openid)
      const res = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = normalizeStaffWorkflow(res.data[0] || null)
      if (!profile) return null
      const settings = await getSystemSettings().catch(() => ({}))
      const depositConfig = settings.staffDeposit || normalizeStaffDepositConfig()
      const ability = validateStaffTakeOrderAbility(profile, depositConfig)
      const depositSatisfied = staffDepositSatisfied(profile, depositConfig)
      return {
        ...profile,
        certificationLocked: isStaffProfileLocked(profile),
        depositConfig: {
          enabled: depositConfig.enabled,
          amount: depositConfig.amount
        },
        canTakeOrders: ability.can,
        cannotTakeOrderReason: ability.can ? '' : ability.reason,
        cannotTakeOrderMessage: ability.can ? '' : ability.message,
        depositNotice: (!depositSatisfied && depositConfig.enabled && depositConfig.amount > 0) ? {
          needDeposit: true,
          isRepay: Boolean(profile.requireDepositRepay === true || profile.depositStatus === 'supplement_required' || profile.depositStatus === 'forfeited'),
          amount: depositConfig.amount,
          title: (profile.requireDepositRepay === true || profile.depositStatus === 'supplement_required' || profile.depositStatus === 'forfeited') ? '要求重新足额缴纳保证金' : '未缴纳履约保证金',
          reason: profile.requireDepositRepayReason || '',
          message: (profile.requireDepositRepay === true || profile.depositStatus === 'supplement_required' || profile.depositStatus === 'forfeited')
            ? `平台要求重新足额缴纳履约保证金（¥${depositConfig.amount}）。原因：${profile.requireDepositRepayReason || '保证金余额不足或存在违规出险'}。请先完成足额缴纳后继续接单。`
            : `平台已开启宠托师履约保证金（¥${depositConfig.amount}），请先完成缴纳后再开始抢单/接单。`
        } : null
      }
    }
    if (action === 'getTrainingStatus') {
      await getUser(openid)
      const profile = await getStaffProfileByOpenid(openid)
      if (!profile) throw new Error('请先提交宠托师认证')
      const progress = profile.trainingVideoProgress || {}
      const settings = await getSystemSettings()
      const training = settings.staffTraining || normalizeStaffTrainingConfig()
      const completedOrders = await getCompletedStaffOrders(openid, 3)
      const videos = enabledTrainingVideos(training).map((video) => ({ ...video, watched: Boolean(progress[video.key] && progress[video.key].watched), watchedAt: progress[video.key] && progress[video.key].watchedAt || '' }))
      return {
        profile,
        quiz: { questions: publicTrainingQuiz(training.quiz), passScore: training.passScore, passed: Boolean(profile.quizPassedAt), score: Number(profile.quizScore || 0), passedAt: profile.quizPassedAt || '' },
        videos,
        videoAuditGuide: normalizeVideoAuditGuide(training.videoAuditGuide),
        supplies: settings.staffSupplies || normalizeStaffSuppliesConfig(),
        completedInternOrders: completedOrders,
        completedInternOrderCount: completedOrders.length,
        canRequestVideoAudit: profile.auditStatus === 'approved' && isTrainingComplete(profile, training) && profile.videoAuditStatus !== 'pending' && profile.videoAuditStatus !== 'approved',
        canSubmitPromotion: profile.staffLevel === 'intern' && profile.promotionStatus !== 'pending' && completedOrders.length >= 3,
        canTakeOrders: canTakeOrders(profile, settings.staffDeposit)
      }
    }
    if (action === 'submitTrainingQuiz') {
      await getUser(openid)
      const profile = await getStaffProfileByOpenid(openid)
      if (!profile || profile.auditStatus !== 'approved') throw new Error('资料审核通过后方可参加培训答题')
      const settings = await getSystemSettings()
      const training = settings.staffTraining || normalizeStaffTrainingConfig()
      const questions = training.quiz || DEFAULT_STAFF_TRAINING_QUIZ
      const answers = data.answers || {}
      const correct = questions.filter((item) => safeText(answers[item.id]).trim() === item.answer).length
      const score = Math.round((correct / questions.length) * 100)
      const passed = score >= training.passScore
      const time = now()
      const update = { quizScore: score, updatedAt: time }
      if (passed) {
        update.quizPassedAt = time
        update.onboardingStatus = 'quiz_passed'
      }
      await db.collection('staff_profiles').doc(profile._id).update({ data: update })
      return { score, passed, passScore: training.passScore }
    }
    if (action === 'markTrainingVideoWatched') {
      await getUser(openid)
      const profile = await getStaffProfileByOpenid(openid)
      if (!profile || profile.auditStatus !== 'approved') throw new Error('资料审核通过后方可观看培训视频')
      const settings = await getSystemSettings()
      const training = settings.staffTraining || normalizeStaffTrainingConfig()
      const videos = enabledTrainingVideos(training)
      const videoKey = safeText(data.videoKey).trim()
      if (!videos.some((item) => item.key === videoKey)) throw new Error('培训视频不存在')

      // 全程观看防作弊校验：如果前端传递了视频时长，必须观看达到90%以上
      const watchedSeconds = Number(data.watchedSeconds)
      const duration = Number(data.duration)
      if (Number.isFinite(duration) && duration > 5) {
        if (!Number.isFinite(watchedSeconds) || watchedSeconds < duration * 0.9) {
          throw new Error('培训视频须全程完整观看，当前播放时长未达标')
        }
      }

      const progress = { ...(profile.trainingVideoProgress || {}) }
      const time = now()
      progress[videoKey] = {
        watched: true,
        watchedAt: time,
        watchedSeconds: Number.isFinite(watchedSeconds) ? watchedSeconds : null,
        duration: Number.isFinite(duration) ? duration : null
      }
      const allWatched = videos.every((video) => progress[video.key] && progress[video.key].watched === true)
      const update = { trainingVideoProgress: progress, updatedAt: time }
      if (allWatched) {
        update.trainingVideosCompletedAt = time
        update.onboardingStatus = profile.quizPassedAt ? 'videos_completed' : profile.onboardingStatus
      }
      await db.collection('staff_profiles').doc(profile._id).update({ data: update })
      return { videoKey, allWatched }
    }
    if (action === 'submitVideoAuditRequest') {
      await getUser(openid)
      const profile = await getStaffProfileByOpenid(openid)
      if (!profile || profile.auditStatus !== 'approved') throw new Error('资料审核通过后方可提交视频审核')
      const settings = await getSystemSettings()
      const training = settings.staffTraining || normalizeStaffTrainingConfig()
      if (!isTrainingComplete(profile, training)) throw new Error('请先完成答题和全部培训视频')
      const time = now()
      const update = { videoAuditStatus: 'pending', videoAuditRequestedAt: time, onboardingStatus: 'video_audit_pending', videoAuditRemark: '', updatedAt: time }
      await db.collection('staff_profiles').doc(profile._id).update({ data: update })
      return { ...profile, ...update }
    }
    if (action === 'submitPromotionApplication') {
      const user = await getUser(openid)
      const profile = await getStaffProfileByOpenid(openid)
      if (!profile || profile.staffLevel !== 'intern') throw new Error('仅实习宠托师可申请晋升')
      if (profile.promotionStatus === 'pending') throw new Error('已有待审核晋升申请')
      const completedOrders = await getCompletedStaffOrders(openid, 3)
      if (completedOrders.length < 3) throw new Error('完成 3 单实习服务后才可申请晋升')
      const time = now()
      const created = await db.collection('staff_promotion_applications').add({ data: { staffProfileId: profile._id, staffOpenid: openid, staffUserId: user._id, orderIds: completedOrders.map((order) => order._id), status: 'pending', staffRemark: safeText(data.remark).trim(), adminRemark: '', createdAt: time, updatedAt: time } })
      await db.collection('staff_profiles').doc(profile._id).update({ data: { promotionStatus: 'pending', promotionApplicationId: created._id, promotionAppliedAt: time, updatedAt: time } })
      return { applicationId: created._id, status: 'pending' }
    }
    if (action === 'submitStaffProfile') {
      const user = await getUser(openid)
      const existing = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      if (isStaffProfileLocked(existing.data[0])) throw new Error('认证资料已锁定，如需更正请联系平台审核')
      const gender = requireStaffGender(data.gender)
      const realName = safeText(data.realName).trim()
      const phone = safeText(data.phone || user.phone).trim()
      const serviceCity = safeText(data.serviceCity).trim()
      const serviceAreas = safeText(data.serviceAreas).trim()
      const serviceAddress = safeText(data.serviceAddress).trim()
      const serviceLatitude = Number(data.latitude || data.serviceLatitude || 0)
      const serviceLongitude = Number(data.longitude || data.serviceLongitude || 0)
      const serviceRadiusKm = Math.max(Number(data.serviceRadiusKm || 5), 1)
      const idCardFrontFileId = safeFileId(data.idCardFrontFileId)
      const idCardBackFileId = safeFileId(data.idCardBackFileId)
      const facePhotoFileId = safeFileId(data.facePhotoFileId)

      if (!realName) throw new Error('请输入真实姓名')
      if (!phone) throw new Error('请输入手机号')
      if (!serviceAddress || !hasCoordinate(serviceLatitude, serviceLongitude)) {
        throw new Error('宠托师认证必须设置固定服务地址及坐标')
      }
      if (!idCardFrontFileId || !idCardBackFileId) throw new Error('请上传身份证正反面照片')
      if (!facePhotoFileId) throw new Error('请上传自拍/人脸照片')

      const staffText = [realName, serviceCity, serviceAreas, serviceAddress, data.bio, data.intro, data.experience].filter(Boolean).join(' ')
      if (staffText) {
        await checkTextSecurity(openid, staffText, { scene: 1, label: '认证资料' })
      }

      const time = now()
      const identitySummary = {
        idCardFrontFileId,
        idCardBackFileId,
        facePhotoFileId,
        identityStatus: 'pending',
        faceVerifyStatus: 'manual_pending',
        faceVerifyProvider: '',
        faceVerifyRequestId: ''
      }
      const profile = {
        userId: user._id,
        openid,
        realName,
        gender,
        phone,
        avatarUrl: user.avatarUrl || data.avatarUrl || '',
        serviceCity,
        serviceAreas,
        serviceAddress,
        publicServiceAddress: safeText(data.publicServiceAddress || '').trim(),
        serviceLatitude,
        serviceLongitude,
        serviceRadiusKm,
        weeklySchedule: normalizeWeeklySchedule(data.weeklySchedule),
        idCardFrontFileId,
        idCardBackFileId,
        facePhotoFileId,
        identityStatus: identitySummary.identityStatus,
        faceVerifyStatus: identitySummary.faceVerifyStatus,
        faceVerifyProvider: identitySummary.faceVerifyProvider,
        faceVerifyRequestId: identitySummary.faceVerifyRequestId,
        auditStatus: 'pending',
        auditRemark: '',
        staffLevel: 'applicant',
        onboardingStatus: 'application_pending',
        videoAuditStatus: 'not_started',
        promotionStatus: 'none',
        quizPassedAt: null,
        quizScore: 0,
        trainingVideoProgress: {},
        trainingVideosCompletedAt: null,
        videoAuditRequestedAt: null,
        videoAuditRemark: '',
        internStartedAt: null,
        internCompletedOrderCount: 0,
        promotionApplicationId: '',
        promotionAppliedAt: null,
        updatedAt: time
      }
      if (existing.data[0]) {
        await db.runTransaction(async (tx) => {
          const current = (await tx.collection('staff_profiles').doc(existing.data[0]._id).get()).data
          if (isStaffProfileLocked(current)) throw new Error('认证资料已锁定，如需更正请联系平台审核')
          await tx.collection('staff_profiles').doc(existing.data[0]._id).update({ data: profile })
        })
        const identityPayload = { staffProfileId: existing.data[0]._id, userId: user._id, openid, realName, gender, phone, ...identitySummary, auditStatus: 'pending', updatedAt: time }
        const identityRes = await db.collection('staff_identity_verifications').where({ staffProfileId: existing.data[0]._id }).limit(1).get()
        if (identityRes.data[0]) await db.collection('staff_identity_verifications').doc(identityRes.data[0]._id).update({ data: identityPayload })
        else await db.collection('staff_identity_verifications').add({ data: { ...identityPayload, createdAt: time } })
        return { _id: existing.data[0]._id, ...profile }
      }
      const created = await db.collection('staff_profiles').add({ data: { ...profile, createdAt: time } })
      await db.collection('staff_identity_verifications').add({ data: { staffProfileId: created._id, userId: user._id, openid, realName, gender, phone, ...identitySummary, auditStatus: 'pending', createdAt: time, updatedAt: time } })
      return { _id: created._id, ...profile, createdAt: time }
    }
    if (action === 'updateStaffProfileConfig') {
      await getUser(openid)
      const existing = await db.collection('staff_profiles').where({ openid }).limit(1).get().catch(() => ({ data: [] }))
      const profile = existing && existing.data && existing.data[0]
      if (!profile) throw new Error('请先提交宠托师认证')
      if (profile.auditStatus !== 'approved') throw new Error('宠托师认证审核通过后方可设置接单配置')
      const identityFields = ['gender', 'realName', 'phone', 'idCardFrontFileId', 'idCardBackFileId', 'facePhotoFileId', 'serviceCity', 'serviceAreas']
      if (identityFields.some((key) => data[key] !== undefined && data[key] !== profile[key])) {
        throw new Error('认证资料已锁定，如需更正请联系平台审核')
      }

      const time = now()
      const updateData = { updatedAt: time }

      // 判断是否只更新 weeklySchedule（从排班日历调用）
      const isOnlyWeeklyScheduleUpdate = data.weeklySchedule !== undefined &&
                                          data.serviceAddress === undefined &&
                                          data.serviceLatitude === undefined &&
                                          data.serviceLongitude === undefined &&
                                          data.serviceRadiusKm === undefined

      if (isOnlyWeeklyScheduleUpdate) {
        // 只更新按周服务时间规则
        const weeklySchedule = normalizeWeeklySchedule(data.weeklySchedule)
        updateData.weeklySchedule = weeklySchedule
      } else {
        // 完整更新（从个人中心调用）
        const serviceAddress = safeText(data.serviceAddress !== undefined ? data.serviceAddress : profile.serviceAddress).trim()
        let serviceLatitude = Number(data.serviceLatitude !== undefined ? data.serviceLatitude : (data.latitude !== undefined ? data.latitude : (profile.serviceLatitude || 0)))
        let serviceLongitude = Number(data.serviceLongitude !== undefined ? data.serviceLongitude : (data.longitude !== undefined ? data.longitude : (profile.serviceLongitude || 0)))
        if (!hasCoordinate(serviceLatitude, serviceLongitude) && hasCoordinate(profile.serviceLatitude, profile.serviceLongitude)) {
          serviceLatitude = Number(profile.serviceLatitude)
          serviceLongitude = Number(profile.serviceLongitude)
        }
        const serviceRadiusKm = Math.max(Number(data.serviceRadiusKm !== undefined ? data.serviceRadiusKm : (profile.serviceRadiusKm || 5)), 1)
        const weeklySchedule = data.weeklySchedule !== undefined ? normalizeWeeklySchedule(data.weeklySchedule) : profile.weeklySchedule
        const publicServiceAddress = safeText(data.publicServiceAddress !== undefined ? data.publicServiceAddress : (profile.publicServiceAddress || '')).trim()

        if (!serviceAddress || !hasCoordinate(serviceLatitude, serviceLongitude)) {
          throw new Error('请选择有效的固定服务地址及坐标')
        }

        updateData.serviceAddress = serviceAddress
        updateData.publicServiceAddress = publicServiceAddress
        updateData.serviceLatitude = serviceLatitude
        updateData.serviceLongitude = serviceLongitude
        updateData.serviceRadiusKm = serviceRadiusKm
        updateData.weeklySchedule = weeklySchedule
      }

      await db.collection('staff_profiles').doc(profile._id).update({ data: updateData })
      return { _id: profile._id, ...profile, ...updateData }
    }
    if (action === 'updateCurrentLocation') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可更新定位')
      const latitude = Number(data.latitude || 0)
      const longitude = Number(data.longitude || 0)
      if (!hasCoordinate(latitude, longitude)) throw new Error('定位信息无效')
      const existing = await db.collection('staff_profiles').where({ openid }).limit(1).get().catch(() => ({ data: [] }))
      const profile = existing && existing.data && existing.data[0]
      if (!profile) throw new Error('请先提交员工认证')
      const location = { currentLatitude: latitude, currentLongitude: longitude, locationAccuracy: Number(data.accuracy || 0), locationUpdatedAt: now(), updatedAt: now() }
      await db.collection('staff_profiles').doc(profile._id).update({ data: location })
      return { _id: profile._id, ...location }
    }
    if (action === 'listNearbyOrders' || action === 'listAvailableOrders') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可查看')

      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = normalizeStaffWorkflow(profileRes.data[0] || {})
      const settings = await getSystemSettings().catch(() => ({}))
      const ability = validateStaffTakeOrderAbility(profile, settings.staffDeposit)
      if (!ability.can) throw new Error(ability.message || '完成培训和视频审核成为实习宠托师后方可查看可接订单')
      const latitude = Number(data.latitude || profile.currentLatitude || 0)
      const longitude = Number(data.longitude || profile.currentLongitude || 0)

      const filterCity = data.city ? String(data.city).trim() : ''
      const inServiceRange = Boolean(data.inServiceRange)
      const inServiceTime = Boolean(data.inServiceTime)
      const filterDate = data.filterDate ? String(data.filterDate).trim() : ''
      await expireDueUnacceptedOrders()

      const openWhere = {
        status: 'paid',
        publishMode: 'open'
      }
      if (db.command && typeof db.command.neq === 'function') {
        openWhere.isUrgent = db.command.neq(true)
      } else {
        openWhere.isUrgent = false
      }
      const availableOrders = (await readAll('orders', openWhere)).sort((a, b) => toTimeValue(a.startTime) - toTimeValue(b.startTime))
      const radiusKm = Math.max(Number(profile.serviceRadiusKm || 5), 1)

      function isOrderInRange(order) {
        return order.distanceKm !== null && order.distanceKm <= radiusKm
      }

      async function isOrderInTime(order, exceptions) {
        const sessions = getOrderTimeRanges(order)
        if (!sessions.length) return false
        try {
          for (const session of sessions) {
            await validateStaffScheduleOnly(profile, session.startTime, session.endTime, { exceptions })
          }
          return true
        } catch (error) {
          return false
        }
      }

      let candidates = availableOrders.filter((order) => matchesStaffGender(order, profile) && !isAdminDeletedOrder(order) && isOpenOrder(order) && !order.isUrgent && order.assignmentSource !== 'admin_urgent_republish')
      if (filterDate) {
        candidates = candidates.filter((order) => {
          if (!order.startTime) return false
          return String(order.startTime).startsWith(filterDate)
        })
      }
      if (filterCity) {
        candidates = candidates.filter((order) => orderMatchesCity(order, filterCity))
      }

      const scheduleExceptions = candidates.length
        ? await readAll('staff_schedule_exceptions', { staffOpenid: openid })
        : []
      let orders = await Promise.all(candidates.map(async (order) => {
        const enriched = await attachOrderDisplayData(order)
        let distanceKm = null
        if (hasCoordinate(latitude, longitude) && hasCoordinate(enriched.addressLatitude, enriched.addressLongitude)) {
          distanceKm = calcDistanceKm(latitude, longitude, enriched.addressLatitude, enriched.addressLongitude)
        }
        // 【新增】添加收益信息
        const earning = await calculateStaffEarningForOrder(enriched)
        const result = {
          ...enriched,
          distanceKm,
          distanceText: formatDistance(distanceKm),
          staffEarning: earning.earningAmount,
          staffEarningText: `¥${earning.earningAmount.toFixed(2)}`
        }
        result.inRange = isOrderInRange(result)
        result.inTime = await isOrderInTime(result, scheduleExceptions)
        return result
      }))

      // 3. 服务范围与时间筛选需在分页前执行，避免当前页被前端过滤后为空
      if (inServiceRange) orders = orders.filter((order) => order.inRange)
      if (inServiceTime) orders = orders.filter((order) => order.inTime)

      const sortedOrders = orders.sort((a, b) => (a.distanceKm === null ? 999999 : a.distanceKm) - (b.distanceKm === null ? 999999 : b.distanceKm))
      const maskedOrders = sortedOrders.map(maskOrderForStaffPreview)
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(maskedOrders, data) : maskedOrders.slice(0, 20)
    }
    if (action === 'listDirectOrders') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可查看')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = normalizeStaffWorkflow(profileRes.data[0] || {})
      const settings = await getSystemSettings().catch(() => ({}))
      const ability = validateStaffTakeOrderAbility(profile, settings.staffDeposit)
      if (!ability.can) throw new Error(ability.message || '完成培训和视频审核成为实习宠托师后方可查看指定订单')
      const latitude = Number(data.latitude || profile.currentLatitude || 0)
      const longitude = Number(data.longitude || profile.currentLongitude || 0)
      await expireDueUnacceptedOrders()
      const directCandidates = await readAll('orders', { status: 'paid', requestedStaffOpenid: openid })
      const directOrders = await Promise.all(directCandidates
        .sort((a, b) => toTimeValue(a.startTime) - toTimeValue(b.startTime))
        .filter((order) => matchesStaffGender(order, profile) && !isAdminDeletedOrder(order) && order.publishMode === 'direct' && !order.staffOpenid && order.requestedStaffOpenid === openid)
        .map(async (order) => {
          const enriched = await attachOrderDisplayData(order)
          let distanceKm = null
          if (hasCoordinate(latitude, longitude) && hasCoordinate(enriched.addressLatitude, enriched.addressLongitude)) {
            distanceKm = calcDistanceKm(latitude, longitude, enriched.addressLatitude, enriched.addressLongitude)
          }
          return { ...enriched, distanceKm, distanceText: formatDistance(distanceKm) }
        }))
      const maskedDirectOrders = directOrders.map(maskOrderForStaffPreview)
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(maskedDirectOrders, data) : maskedDirectOrders
    }
    if (action === 'listUrgentOrders') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可查看')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = normalizeStaffWorkflow(profileRes.data[0] || {})
      const settings = await getSystemSettings().catch(() => ({}))
      const ability = validateStaffTakeOrderAbility(profile, settings.staffDeposit)
      if (!ability.can) throw new Error(ability.message || '完成培训和视频审核成为实习宠托师后方可查看加急订单')
      const latitude = Number(data.latitude || profile.currentLatitude || 0)
      const longitude = Number(data.longitude || profile.currentLongitude || 0)
      await expireDueUnacceptedOrders()

      // 仅检索标记为加急或后台转加急重派的待接订单，避免对全平台所有普通 paid 订单做全表扫描
      const [urgentFlaggedOrders, urgentRepublishedOrders] = await Promise.all([
        readAll('orders', { status: 'paid', isUrgent: true }),
        readAll('orders', { status: 'paid', assignmentSource: 'admin_urgent_republish' })
      ])
      const urgentCandidateMap = new Map()
      for (const order of urgentFlaggedOrders) {
        urgentCandidateMap.set(order._id, order)
      }
      for (const order of urgentRepublishedOrders) {
        urgentCandidateMap.set(order._id, order)
      }
      const rawUrgentOrders = Array.from(urgentCandidateMap.values())

      const urgentOrders = await Promise.all(rawUrgentOrders
        .sort((a, b) => toTimeValue(a.startTime) - toTimeValue(b.startTime))
        .filter((order) => matchesStaffGender(order, profile) && !isAdminDeletedOrder(order) && (order.isUrgent === true || order.assignmentSource === 'admin_urgent_republish') && !order.staffOpenid)
        .map(async (order) => {
          const enriched = await attachOrderDisplayData(order)
          let distanceKm = null
          if (hasCoordinate(latitude, longitude) && hasCoordinate(enriched.addressLatitude, enriched.addressLongitude)) {
            distanceKm = calcDistanceKm(latitude, longitude, enriched.addressLatitude, enriched.addressLongitude)
          }
          const earning = await calculateStaffEarningForOrder(enriched)
          return {
            ...enriched,
            distanceKm,
            distanceText: formatDistance(distanceKm),
            isUrgent: true,
            urgentStaffReward: order.urgentStaffReward || earning.earningAmount,
            urgentBonus: order.urgentBonus || 0,
            urgentRemark: order.urgentRemark || '',
            staffEarning: earning.earningAmount,
            staffEarningText: `¥${Number(earning.earningAmount).toFixed(2)}`
          }
        }))
      const sorted = urgentOrders.sort((a, b) => (a.distanceKm === null ? 999999 : a.distanceKm) - (b.distanceKm === null ? 999999 : b.distanceKm))
      const maskedUrgentOrders = sorted.map(maskOrderForStaffPreview)
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(maskedUrgentOrders, data) : maskedUrgentOrders
    }
    if (action === 'getScheduleCalendar') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可查看')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = profileRes.data[0]
      if (!profile) throw new Error('请先提交宠托师认证')
      const availability = await buildStaffAvailability(profile, data.startDate || data.dateKey || '', data.days || 14)
      return { weeklySchedule: normalizeWeeklySchedule(profile.weeklySchedule), weeklyScheduleText: formatWeeklyScheduleText(profile.weeklySchedule), availability }
    }
    if (action === 'saveScheduleException') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可设置排班')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = profileRes.data[0]
      if (!profile || profile.auditStatus !== 'approved') throw new Error('宠托师认证审核通过后方可设置排班')
      const payload = normalizeScheduleException(data, profile)
      return saveStaffScheduleException(user, payload)
    }
    if (action === 'deleteScheduleException') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可设置排班')
      const dateKey = safeText(data.dateKey).trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error('请选择有效日期')
      return saveStaffScheduleException(user, { dateKey }, true)
    }
    if (action === 'listScheduleAvailability') {
      const profileId = safeText(data.staffProfileId || data.requestedStaffProfileId).trim()
      let profile = null
      if (profileId) {
        const profileRes = await db.collection('staff_profiles').doc(profileId).get().catch(() => ({ data: null }))
        profile = profileRes && profileRes.data
      } else {
        const user = await getUser(openid)
        if (!user.roles.includes('staff')) throw new Error('请选择宠托师')
        profile = (await db.collection('staff_profiles').where({ openid }).limit(1).get()).data[0]
      }
      const settings = await getSystemSettings().catch(() => ({}))
      if (!profile || !canTakeOrders(profile, settings.staffDeposit)) throw new Error('宠托师不可用')
      return buildStaffAvailability(profile, data.startDate || data.dateKey || '', data.days || 14)
    }
    if (action === 'listStaffReviews') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可查看')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = profileRes.data[0]
      if (!profile) throw new Error('请先提交员工认证')
      const where = { staffProfileId: profile._id, status: 'visible' }
      const wantsPage = data && (data.page !== undefined || data.pageSize !== undefined)
      if (wantsPage) {
        const countRes = await db.collection('service_reviews').where(where).count()
        const total = (countRes && countRes.total) || 0
        const page = Math.max(1, Number(data.page || 1))
        const pageSize = Math.min(100, Math.max(1, Number(data.pageSize || 20)))
        const offset = (page - 1) * pageSize
        if (offset >= total) {
          return { list: [], total, page, pageSize, hasMore: false }
        }
        const res = await db.collection('service_reviews')
          .where(where)
          .orderBy('createdAt', 'desc')
          .skip(offset)
          .limit(pageSize)
          .get()
        const list = (res.data || []).map((item) => ({ ...item, clientName: maskClientName(item.clientName) }))
        return {
          list,
          total,
          page,
          pageSize,
          hasMore: offset + list.length < total
        }
      }
      const rows = []
      let cursor = ''
      while (rows.length < 1000) {
        const cond = { ...where }
        if (cursor && db.command && typeof db.command.gt === 'function') cond._id = db.command.gt(cursor)
        const batch = (await db.collection('service_reviews').where(cond).orderBy('_id', 'asc').limit(100).get()).data || []
        rows.push(...batch)
        if (batch.length < 100) break
        cursor = batch[batch.length - 1]._id
      }
      rows.sort((a, b) => toTimeValue(b.createdAt) - toTimeValue(a.createdAt))
      return rows.map((item) => ({ ...item, clientName: maskClientName(item.clientName) }))
    }
    if (action === 'checkUpcomingReminders') {
      await requireAdmin(openid)
      const list = await sendUpcomingServiceRemindersToStaff()
      return { remindedCount: list.length }
    }
    async function readAllStaffOrders(where = {}, maxLimit = 2000) {
      const rows = []
      let cursor = ''
      while (rows.length < maxLimit) {
        const condition = { ...where }
        if (cursor && db.command && typeof db.command.gt === 'function') {
          condition._id = db.command.gt(cursor)
        }
        const page = (await db.collection('orders').where(condition).orderBy('_id', 'asc').limit(100).get()).data || []
        rows.push(...page)
        if (page.length < 100) break
        cursor = page[page.length - 1]._id
      }
      return rows
    }

    if (action === 'listStaffOrders') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可查看')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = profileRes.data[0] || {}
      const latitude = Number(data.latitude || profile.currentLatitude || 0)
      const longitude = Number(data.longitude || profile.currentLongitude || 0)

      const where = { staffOpenid: openid }
      if (data.status && data.status !== 'all') {
        where.status = data.status
      } else if (data.statusGroup === 'waiting_service') {
        where.status = db.command.in(['assigned', 'in_service', 'day_completed'])
      }

      const orderKeyword = safeText(data.orderKeyword || data.keyword || data.orderNo).trim().toLowerCase()
      const startDate = safeText(data.startDate).trim()
      const endDate = safeText(data.endDate).trim()
      const wantsPage = data.page !== undefined || data.pageSize !== undefined

      let pagedOrders = []
      const page = Math.max(1, Number(data.page || 1))
      const pageSize = Math.min(100, Math.max(1, Number(data.pageSize || 10)))
      const offset = (page - 1) * pageSize

      const allCandidates = await readAllStaffOrders(where, 2000)
      let list = allCandidates.filter((order) => !isAdminDeletedOrder(order))
      list.sort((a, b) => toTimeValue(b.createdAt || b.startTime) - toTimeValue(a.createdAt || a.startTime))

      if (orderKeyword) {
        list = list.filter((order) => [
          order._id,
          order.orderNo,
          order.petName,
          order.serviceSummary,
          order.serviceAddress,
          order.clientSnapshot && order.clientSnapshot.displayName,
          order.clientSnapshot && order.clientSnapshot.nickname
        ].some((val) => safeText(val).toLowerCase().includes(orderKeyword)))
      }

      if (startDate) {
        list = list.filter((order) => {
          const start = String(order.serviceStartDate || order.startTime || order.createdAt || '').slice(0, 10)
          const end = String(order.serviceEndDate || order.endTime || start).slice(0, 10)
          return end >= startDate
        })
      }

      if (endDate) {
        list = list.filter((order) => {
          const start = String(order.serviceStartDate || order.startTime || order.createdAt || '').slice(0, 10)
          return start <= endDate
        })
      }

      const total = list.length
      pagedOrders = wantsPage ? list.slice(offset, offset + pageSize) : list

      const decorate = async (order) => {
        const enriched = await attachOrderDisplayData(order)
        const distanceKm = calcDistanceKm(latitude, longitude, enriched.addressLatitude, enriched.addressLongitude)
        const earning = await calculateStaffEarningForOrder(enriched)
        return {
          ...enriched,
          distanceKm,
          distanceText: formatDistance(distanceKm),
          staffEarning: earning.earningAmount,
          staffEarningText: `¥${earning.earningAmount.toFixed(2)}`
        }
      }

      const decoratedList = await Promise.all(pagedOrders.map(decorate))
      if (wantsPage) {
        return {
          list: decoratedList,
          total,
          page,
          pageSize,
          hasMore: offset + pagedOrders.length < total
        }
      }
      return decoratedList
    }
    if (action === 'checkAcceptOrderRisk') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可接单')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = normalizeStaffWorkflow(profileRes.data[0])
      const settings = await getSystemSettings().catch(() => ({}))
      const ability = validateStaffTakeOrderAbility(profile, settings.staffDeposit)
      if (!ability.can) throw new Error(ability.message || '完成培训和视频审核成为实习宠托师后方可接单')
      if (!hasCoordinate(profile.serviceLatitude, profile.serviceLongitude) || !profile.serviceAddress) {
        throw new Error('请先在个人中心设置固定服务地址与接单范围，方可接单')
      }
      const orderId = safeText(data.orderId).trim()
      if (!orderId) throw new Error('订单不存在')
      const orderRes = await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))
      if (!orderRes || !orderRes.data) throw new Error('订单不存在')
      const order = await expireUnacceptedOrder(orderId, orderRes.data)
      assertStaffGenderMatches(order, profile)
      assertOrderTransition(order.status, ORDER_STATUS.ASSIGNED, '订单状态不可接单')
      if (order.staffOpenid) throw new Error('订单已被分配')
      const publishMode = order.publishMode === 'direct' ? 'direct' : 'open'
      if (publishMode === 'direct' && order.requestedStaffOpenid !== openid) throw new Error('该订单指定了其他宠托师')
      if (publishMode === 'open' && order.requestedStaffOpenid) throw new Error('该订单指定了其他宠托师')
      const conflict = await findStaffOrderConflict(profile.openid, order, orderId)
      if (conflict) throw new Error('宠托师该时间段已有订单，无法重复预约')
      return checkAcceptOrderRisk(profile, order)
    }
    if (action === 'acceptOrder') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可接单')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = normalizeStaffWorkflow(profileRes.data[0])
      const settings = await getSystemSettings().catch(() => ({}))
      const ability = validateStaffTakeOrderAbility(profile, settings.staffDeposit)
      if (!ability.can) throw new Error(ability.message || '完成培训和视频审核成为实习宠托师后方可接单')
      if (!hasCoordinate(profile.serviceLatitude, profile.serviceLongitude) || !profile.serviceAddress) {
        throw new Error('请先在个人中心设置固定服务地址与接单范围，方可接单')
      }

      const orderId = safeText(data.orderId).trim()
      if (!orderId) throw new Error('订单不存在')
      const orderRes = await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))
      if (!orderRes || !orderRes.data) throw new Error('订单不存在')
      const order = await expireUnacceptedOrder(orderId, orderRes.data)
      assertStaffGenderMatches(order, profile)
      assertOrderTransition(order.status, ORDER_STATUS.ASSIGNED, '订单状态不可接单')
      if (order.staffOpenid) throw new Error('订单已被分配')
      const publishMode = order.publishMode === 'direct' ? 'direct' : 'open'
      if (publishMode === 'direct' && order.requestedStaffOpenid !== openid) throw new Error('该订单指定了其他宠托师')
      if (publishMode === 'open' && order.requestedStaffOpenid) throw new Error('该订单指定了其他宠托师')

      // 验证抢单时的实时位置与订单距离
      const currentLat = Number(data.currentLatitude)
      const currentLng = Number(data.currentLongitude)
      const orderLat = Number(order.serviceLatitude || order.addressLatitude || 0)
      const orderLng = Number(order.serviceLongitude || order.addressLongitude || 0)

      let distanceFromCurrent = null
      if (hasCoordinate(currentLat, currentLng) && hasCoordinate(orderLat, orderLng)) {
        distanceFromCurrent = calcDistanceKm(currentLat, currentLng, orderLat, orderLng)
        const serviceRadiusKm = Number(profile.serviceRadiusKm || 5)
        if (distanceFromCurrent !== null && distanceFromCurrent > serviceRadiusKm) {
          throw new Error(`订单距离你当前位置约 ${formatDistance(distanceFromCurrent)}，超出 ${serviceRadiusKm}km 服务范围，无法接单`)
        }
      }

      const risk = await checkAcceptOrderRisk(profile, order)
      const conflict = await findStaffOrderConflict(profile.openid, order, data.orderId)
      if (conflict) throw new Error('宠托师该时间段已有订单，无法重复预约')
      if (risk.requiresConfirmation && data.riskConfirmed !== true) throw new Error('请先阅读并确认超出接单设置的履约责任')
      const time = now()
      const isUrgentGrab = Boolean(
        order.isUrgent === true ||
        order.assignmentSource === 'admin_urgent_republish' ||
        (Number(order.urgentBonus || 0) > 0) ||
        (Number(order.urgentStaffReward || 0) > 0)
      )
      const assignmentSource = publishMode === 'direct' ? 'direct_accept' : (isUrgentGrab ? 'urgent_grab' : 'open_grab')

      const assignmentUpdate = {
        staffUserId: user._id,
        staffOpenid: openid,
        staffProfileId: profile._id,
        status: 'assigned',
        assignmentSource,
        assignedAt: time,
        updatedAt: time
      }
      if (isUrgentGrab && order.urgentRepublishedAt) {
        const urgentTime = toTimeValue(order.urgentRepublishedAt)
        if (urgentTime > 0) {
          assignmentUpdate.urgentGrabDurationSeconds = Math.max(0, Math.floor((time.getTime() - urgentTime) / 1000))
        }
      }
      // 【新增】只在有有效值时记录接单位置信息
      if (hasCoordinate(currentLat, currentLng)) {
        assignmentUpdate.acceptLocationLatitude = currentLat
        assignmentUpdate.acceptLocationLongitude = currentLng
      }
      if (distanceFromCurrent !== null && !isNaN(distanceFromCurrent)) {
        assignmentUpdate.acceptDistanceKm = distanceFromCurrent
      }
      if (risk.requiresConfirmation) {
        assignmentUpdate.acceptRiskConfirmedAt = time
        assignmentUpdate.acceptRiskWarnings = risk.warnings
      }
      const assignedOrder = await assignOrderAtomically(data.orderId, order, assignmentUpdate, { depositConfig: settings.staffDeposit, riskConfirmed: data.riskConfirmed === true })
      let assignedTitle = publishMode === 'direct' ? '指定宠托师已接单' : (isUrgentGrab ? '加急揭榜抢单' : '宠托师已抢单')
      let timelineDetail = maskStaffName(profile.realName)
      if (isUrgentGrab) {
        const durationMin = assignmentUpdate.urgentGrabDurationSeconds != null
          ? Math.ceil(assignmentUpdate.urgentGrabDurationSeconds / 60)
          : null
        const durationText = durationMin != null ? `（加急响应耗时：${durationMin}分钟）` : ''
        timelineDetail = `宠托师（${maskStaffName(profile.realName)}）已加急揭榜抢单${durationText}，平台加价补贴生效中。`
      }
      await appendOrderTimeline(data.orderId, 'assigned', assignedTitle, timelineDetail, 'staff')
      await appendOrderClientMessage(assignedOrder, { eventType: 'assigned', title: assignedTitle, detail: timelineDetail, actorRole: 'staff' })
      const notifyResult = await notifyOrderAccepted(assignedOrder, maskStaffName(profile.realName))
      await db.collection('orders').doc(data.orderId).update({ data: { acceptedNotifyStatus: notifyResult && notifyResult.status || 'skipped', acceptedNotifyError: notifyResult && notifyResult.error || '', updatedAt: time } })
      return { orderId: data.orderId, status: 'assigned', assignmentSource, notifyStatus: notifyResult && notifyResult.status || 'skipped', notifyError: notifyResult && notifyResult.error || '' }
    }
    if (action === 'getDepositStatus') {
      const user = await getUser(openid)
      const profile = await getStaffProfileByOpenid(openid)
      const settings = await getSystemSettings()
      const config = settings.staffDeposit || normalizeStaffDepositConfig()
      const supplies = settings.staffSupplies || normalizeStaffSuppliesConfig()
      let deposit = null
      const depositRes = await db.collection('staff_deposits').where({ staffOpenid: openid }).orderBy('createdAt', 'desc').limit(1).get()
      if (depositRes.data && depositRes.data[0]) {
        const rawDeposit = depositRes.data[0]
        const safeDeposit = { ...rawDeposit }
        // 严格隔离管理员内部举证照片，仅管理员可见，宠托师端不可见
        delete safeDeposit.lastForfeitImages
        delete safeDeposit.evidenceImages
        delete safeDeposit.forfeitProofImages
        delete safeDeposit.forfeitImages
        deposit = safeDeposit
      }
      const auditApproved = profile && profile.auditStatus === 'approved'
      const needsRepay = Boolean(profile && (profile.requireDepositRepay === true || profile.depositStatus === 'supplement_required' || profile.depositStatus === 'forfeited' || (deposit && deposit.status === 'forfeited')))
      const canPay = Boolean(config.enabled && config.amount > 0 && auditApproved && (!deposit || deposit.status === 'unpaid' || needsRepay))
      const canRequestRefund = Boolean(deposit && ['paid', 'partially_refunded'].includes(deposit.status) && (deposit.availableRefundAmount || 0) > 0 && deposit.refundStatus !== 'requested')

      const eventsRes = await readScopedDocuments('staff_deposit_events', { staffOpenid: openid }, 'createdAt', 'desc').catch(() => [])
      const eventTypeMap = {
        pay: '充值缴纳',
        forfeit: '违规扣除/没收',
        refund_request: '申请退还',
        refund: '退款到账',
        refund_audit: '退款审核'
      }
      const events = eventsRes.map((e) => ({
        _id: e._id,
        type: e.type,
        typeName: eventTypeMap[e.type] || e.type,
        amount: Number(e.amount || 0),
        amountText: e.type === 'pay' ? `+¥${Number(e.amount || 0).toFixed(2)}` : (e.type === 'forfeit' ? `-¥${Number(e.amount || 0).toFixed(2)}` : `¥${Number(e.amount || 0).toFixed(2)}`),
        reason: e.reason || '',
        operatorRole: e.operatorRole || '',
        createdAt: e.createdAt || ''
      }))

      return {
        config,
        supplies,
        deposit,
        profile,
        canPay,
        canRequestRefund,
        needsRepay,
        repayReason: profile && profile.requireDepositRepayReason || '',
        events
      }
    }
    if (action === 'createDepositPayment') {
      if (data.agreed !== true) throw new Error('请先阅读并同意保证金缴纳规则')
      const user = await getUser(openid)
      const profile = await getStaffProfileByOpenid(openid)
      if (!profile || profile.auditStatus !== 'approved') throw new Error('资料审核通过后方可缴纳保证金')
      const settings = await getSystemSettings({ includeSecrets: true })
      const config = settings.staffDeposit || normalizeStaffDepositConfig()
      if (!config.enabled || !config.amount || config.amount <= 0) throw new Error('保证金缴纳当前未开放')
      const clientRequestId = getClientRequestId(data)
      const paymentMode = (settings.payment && settings.payment.mode) || 'mock'
      assertPaymentModeAllowed({ ...settings.payment, mode: paymentMode })
      const { deposit, payment: paymentRecord } = await reserveStaffDepositPayment(user, profile, config.amount, paymentMode, clientRequestId)
      const amount = deposit.amount
      if (deposit.status === 'paid') return { paid: true, depositId: deposit._id }
      if (paymentMode === 'mock') {
        await markStaffDepositPaid(deposit._id, { paymentNo: paymentRecord.paymentNo, channel: 'mock' })
        return { paid: true, depositId: deposit._id }
      } else {
        const configWechat = getWechatPayConfig(settings)
        if (paymentRecord.prepayId) {
          return {
            paid: false,
            depositId: deposit._id,
            paymentNo: paymentRecord.paymentNo,
            payParams: buildMiniProgramPayParams(paymentRecord.prepayId, configWechat)
          }
        }
        const requestBody = {
          appid: configWechat.appId,
          mchid: configWechat.mchId,
          description: '宠托师入驻保证金',
          out_trade_no: paymentRecord.paymentNo,
          notify_url: configWechat.notifyUrl,
          amount: { total: amountYuanToFen(amount), currency: 'CNY' },
          payer: { openid }
        }
        try {
          const response = await wechatPayRequest('POST', '/v3/pay/transactions/jsapi', requestBody, configWechat)
          if (!response.prepay_id) throw new Error('微信支付未返回 prepay_id')
          await db.collection('payments').doc(paymentRecord._id).update({
            data: {
              prepayId: response.prepay_id,
              rawRequest: sanitizeWechatPayload(requestBody),
              rawResponse: sanitizeWechatPayload(response),
              updatedAt: now()
            }
          })
          return {
            paid: false,
            depositId: deposit._id,
            paymentNo: paymentRecord.paymentNo,
            payParams: buildMiniProgramPayParams(response.prepay_id, configWechat)
          }
        } catch (error) {
          await appendPaymentEvent('prepay_failed', { orderId: deposit._id, paymentNo: paymentRecord.paymentNo, status: 'failed', detail: { message: error.message, targetType: 'staff_deposit' } })
          throw new Error(`微信支付保证金下单失败：${error.message}`)
        }
      }
    }
    if (action === 'requestDepositRefund') {
      const reason = safeText(data.reason).trim()
      if (!reason) throw new Error('请填写自愿退出及退款原因')
      await getUser(openid)
      const res = await db.collection('staff_deposits').where({ staffOpenid: openid }).orderBy('createdAt', 'desc').limit(1).get().catch(() => ({ data: [] }))
      const deposit = res && res.data && res.data[0]
      if (!deposit) throw new Error('暂无可退还保证金')
      return requestStaffDepositRefund(openid, deposit._id, reason)
    }
    if (action === 'getSupplyReimbursementStatus') {
      const user = await getUser(openid)
      const profile = await getStaffProfileByOpenid(openid)
      const settings = await getSystemSettings()
      const supplies = settings.staffSupplies || normalizeStaffSuppliesConfig()
      const res = await db.collection('staff_supply_reimbursements').where({ staffOpenid: openid }).orderBy('createdAt', 'desc').limit(1).get()
      const application = res.data && res.data[0] || null
      const isCertified = Boolean(profile && profile.auditStatus === 'approved' && profile.staffLevel === 'certified')
      const canApply = Boolean(!application && isCertified && supplies.reimbursementEnabled !== false)
      return {
        application,
        canApply,
        supplies
      }
    }
    if (action === 'submitSupplyReimbursement') {
      const clientRequestId = getClientRequestId(data)
      if (clientRequestId) {
        const existingReq = await findByClientRequestId('staff_supply_reimbursements', { staffOpenid: openid, clientRequestId })
        if (existingReq) return existingReq
      }
      const user = await getUser(openid)
      const profile = await getStaffProfileByOpenid(openid)
      if (!profile || profile.auditStatus !== 'approved' || profile.staffLevel !== 'certified') {
        throw new Error('仅正式认证宠托师可申请首次用品报销，实习人员不具备报销资格')
      }
      const settings = await getSystemSettings()
      const supplies = settings.staffSupplies || normalizeStaffSuppliesConfig()
      if (supplies.reimbursementEnabled === false) throw new Error('用品报销申请暂未开放')
      const existing = await db.collection('staff_supply_reimbursements').where({ staffOpenid: openid }).limit(1).get()
      if (existing.data && existing.data.length > 0) {
        throw new Error('每位宠托师仅限申请一次首次宠物用品报销，后续服务用品须自备自费')
      }
      const mediaFileIds = Array.isArray(data.mediaFileIds) ? data.mediaFileIds.filter(Boolean) : []
      if (!mediaFileIds.length) throw new Error('请上传首次购买凭证截图')
      const amount = Number(data.amount)
      if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) {
        throw new Error('请填写有效的报销金额，最多两位小数')
      }
      const maxCap = supplies.maxReimbursementAmount || 200
      if (amount > maxCap) {
        throw new Error(`首次用品报销金额不能超过上限 ¥${maxCap}`)
      }
      const remark = safeText(data.remark).trim()
      const time = now()
      const record = {
        staffOpenid: openid,
        staffUserId: user._id,
        staffProfileId: profile._id,
        mediaFileIds,
        amount,
        approvedAmount: null,
        remark,
        clientRequestId,
        status: 'pending',
        statusText: '待审核',
        transferStatus: '',
        createdAt: time,
        updatedAt: time
      }
      return submitStaffSupplyOnce(record)
    }
    if (action === 'querySupplyReimbursement') {
      await getUser(openid)
      const res = await db.collection('staff_supply_reimbursements').where({ staffOpenid: openid }).orderBy('createdAt', 'desc').limit(1).get()
      return res.data && res.data[0] || null
    }
    if (action === 'getSupplyTransferConfirmation') {
      await getUser(openid)
      const res = await db.collection('staff_supply_reimbursements').where({ staffOpenid: openid }).orderBy('createdAt', 'desc').limit(1).get()
      const app = res.data && res.data[0]
      if (!app) throw new Error('暂无报销申请')
      const settings = await getSystemSettings()
      const mchId = (settings.payment && settings.payment.mchId) || ''
      const appId = (settings.payment && settings.payment.appId) || ''
      return {
        status: app.transferStatus || app.status,
        mchId,
        appId,
        packageInfo: app.transferPackageInfo || ''
      }
    }
    throw new Error('未知 staff 操作')
  }
}
