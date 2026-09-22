module.exports = function createHandler(context) {
  const {
    requestStaffDepositRefund,
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
    parseDateTimeParts,
    publicTrainingQuiz,
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
    wechatPayRequest,
    withSitterUserProfile
  } = context
  return async function staff(openid, action, data) {
    if (action === 'listApprovedSitters') {
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
      const res = await db.collection('staff_profiles').where({ auditStatus: 'approved' }).orderBy('updatedAt', 'desc').get()
      let sitters = await Promise.all((res.data || []).filter((item) => canTakeOrders(item, settings.staffDeposit)).map(withSitterUserProfile))

      sitters = sitters.filter((profile) => {
        const areas = splitServiceAreas(profile.serviceAreas)
        if (serviceCity) {
          const normFilterCity = normalizeCityName(serviceCity)
          const normSitterCity = normalizeCityName(profile.serviceCity)
          if (normFilterCity && normSitterCity && normFilterCity !== normSitterCity) return false
        }
        if (serviceArea && !areas.includes(serviceArea)) return false
        if (keyword && !(matchText(profile.nickname, keyword) || matchText(profile.realName, keyword) || matchText(profile.serviceCity, keyword) || matchText(profile.serviceAreas, keyword))) return false

        return true
      })

      const publicList = sitters.map((profile) => {
        const publicData = toPublicSitter(profile)
        if (!userHasLoc) return { ...publicData, inServiceRange: true, canDirectBook: true }

        const hasSitterLoc = hasCoordinate(profile.serviceLatitude, profile.serviceLongitude) && Boolean(profile.serviceAddress)
        const radiusKm = Math.max(Number(profile.serviceRadiusKm || 5), 1)
        const distanceKm = hasSitterLoc ? calcDistanceKm(userLat, userLng, profile.serviceLatitude, profile.serviceLongitude) : null
        const inServiceRange = distanceKm !== null && distanceKm <= radiusKm
        return {
          ...publicData,
          distanceKm,
          distanceText: formatDistance(distanceKm),
          inServiceRange,
          canDirectBook: inServiceRange,
          rangeStatusText: inServiceRange ? '服务范围内' : '超出服务范围'
        }
      })

      const compareRating = (a, b) => Number(b.ratingAverage || 0) - Number(a.ratingAverage || 0) || Number(b.reviewCount || 0) - Number(a.reviewCount || 0) || toTimeValue(b.ratingUpdatedAt || b.updatedAt) - toTimeValue(a.ratingUpdatedAt || a.updatedAt)
      const compareFeatured = (a, b) => {
        const featuredDiff = Number(b.isFeatured === true) - Number(a.isFeatured === true)
        if (featuredDiff) return featuredDiff
        if (a.isFeatured === true && b.isFeatured === true) return toTimeValue(b.featuredAt) - toTimeValue(a.featuredAt)
        return 0
      }
      const compareDefault = (a, b) => compareRating(a, b) || toTimeValue(b.updatedAt) - toTimeValue(a.updatedAt)
      const compareByMode = (a, b) => {
        if (sortBy === 'distance' && userHasLoc) return (a.distanceKm ?? 9999) - (b.distanceKm ?? 9999) || compareRating(a, b)
        if (sortBy === 'city') return String(a.serviceCity || '').localeCompare(String(b.serviceCity || '')) || String(a.serviceAreas || '').localeCompare(String(b.serviceAreas || '')) || compareRating(a, b)
        if (sortBy === 'latest') return toTimeValue(b.updatedAt || b.createdAt) - toTimeValue(a.updatedAt || a.createdAt) || compareRating(a, b)
        if (sortBy === 'rating') return compareRating(a, b)
        return compareDefault(a, b)
      }
      publicList.sort((a, b) => compareFeatured(a, b) || compareByMode(a, b))

      return paginateList(publicList, { ...data, page, pageSize })
    }
    if (action === 'getPublicSitterDetail') {
      const user = await getOptionalUser(openid)
      const settings = await getSystemSettings().catch(() => ({}))
      const profileRes = await db.collection('staff_profiles').doc(data.staffProfileId).get()
      const profile = profileRes.data
      if (!profile || !canTakeOrders(profile, settings.staffDeposit)) throw new Error('宠托师不可用')
      return toPublicSitterDetail(user ? openid : '', await withSitterUserProfile(normalizeStaffWorkflow(profile)))
    }
    if (action === 'favoriteSitter') {
      const user = await getUser(openid)
      const settings = await getSystemSettings().catch(() => ({}))
      const profileRes = await db.collection('staff_profiles').doc(data.staffProfileId).get()
      const profile = profileRes.data
      if (!profile || !canTakeOrders(profile, settings.staffDeposit)) throw new Error('宠托师不可用')
      const existing = await db.collection('sitter_favorites').where({ openid, staffProfileId: data.staffProfileId }).limit(1).get()
      if (existing.data[0]) return { staffProfileId: data.staffProfileId, favorite: true }
      await db.collection('sitter_favorites').add({ data: { userId: user._id, openid, staffProfileId: data.staffProfileId, createdAt: now() } })
      return { staffProfileId: data.staffProfileId, favorite: true }
    }
    if (action === 'unfavoriteSitter') {
      await getUser(openid)
      const existing = await db.collection('sitter_favorites').where({ openid, staffProfileId: data.staffProfileId }).limit(1).get()
      if (existing.data[0]) await db.collection('sitter_favorites').doc(existing.data[0]._id).remove()
      return { staffProfileId: data.staffProfileId, favorite: false }
    }
    if (action === 'listFavoriteSitters') {
      await getUser(openid)
      const settings = await getSystemSettings().catch(() => ({}))
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const favorites = await db.collection('sitter_favorites').where({ openid }).orderBy('createdAt', 'desc').get()
      const list = []
      for (let i = 0; i < favorites.data.length; i += 1) {
        try {
          const profileRes = await db.collection('staff_profiles').doc(favorites.data[i].staffProfileId).get()
          if (profileRes.data && canTakeOrders(profileRes.data, settings.staffDeposit)) {
            const profile = await withSitterUserProfile(normalizeStaffWorkflow(profileRes.data))
            list.push({ ...(await toPublicSitterDetail(openid, profile)), favorite: true })
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
        phone,
        avatarUrl: user.avatarUrl || data.avatarUrl || '',
        serviceCity,
        serviceAreas,
        serviceAddress,
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
      const existing = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      if (existing.data[0]) {
        if (existing.data[0].auditStatus === 'approved') throw new Error('已是安心宠护师，认证资料不可重复提交')
        await db.collection('staff_profiles').doc(existing.data[0]._id).update({ data: profile })
        const identityPayload = { staffProfileId: existing.data[0]._id, userId: user._id, openid, realName, phone, ...identitySummary, auditStatus: 'pending', updatedAt: time }
        const identityRes = await db.collection('staff_identity_verifications').where({ staffProfileId: existing.data[0]._id }).limit(1).get()
        if (identityRes.data[0]) await db.collection('staff_identity_verifications').doc(identityRes.data[0]._id).update({ data: identityPayload })
        else await db.collection('staff_identity_verifications').add({ data: { ...identityPayload, createdAt: time } })
        return { _id: existing.data[0]._id, ...profile }
      }
      const created = await db.collection('staff_profiles').add({ data: { ...profile, createdAt: time } })
      await db.collection('staff_identity_verifications').add({ data: { staffProfileId: created._id, userId: user._id, openid, realName, phone, ...identitySummary, auditStatus: 'pending', createdAt: time, updatedAt: time } })
      return { _id: created._id, ...profile, createdAt: time }
    }
    if (action === 'updateStaffProfileConfig') {
      await getUser(openid)
      const existing = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = existing.data[0]
      if (!profile) throw new Error('请先提交宠托师认证')
      if (profile.auditStatus !== 'approved') throw new Error('宠托师认证审核通过后方可设置接单配置')

      console.log('【调试-updateStaffProfileConfig】接收到的 data:', JSON.stringify(data))

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
        console.log('【调试-updateStaffProfileConfig】只更新 weeklySchedule:', JSON.stringify(weeklySchedule))
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

        if (!serviceAddress || !hasCoordinate(serviceLatitude, serviceLongitude)) {
          throw new Error('请选择有效的固定服务地址及坐标')
        }

        updateData.serviceAddress = serviceAddress
        updateData.serviceLatitude = serviceLatitude
        updateData.serviceLongitude = serviceLongitude
        updateData.serviceRadiusKm = serviceRadiusKm
        updateData.weeklySchedule = weeklySchedule
      }

      console.log('【调试-updateStaffProfileConfig】准备保存的 updateData:', JSON.stringify(updateData))

      await db.collection('staff_profiles').doc(profile._id).update({ data: updateData })
      return { _id: profile._id, ...profile, ...updateData }
    }
    if (action === 'updateCurrentLocation') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可更新定位')
      const latitude = Number(data.latitude || 0)
      const longitude = Number(data.longitude || 0)
      if (!hasCoordinate(latitude, longitude)) throw new Error('定位信息无效')
      const existing = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      if (!existing.data[0]) throw new Error('请先提交员工认证')
      const location = { currentLatitude: latitude, currentLongitude: longitude, locationAccuracy: Number(data.accuracy || 0), locationUpdatedAt: now(), updatedAt: now() }
      await db.collection('staff_profiles').doc(existing.data[0]._id).update({ data: location })
      return { _id: existing.data[0]._id, ...location }
    }
    if (action === 'listNearbyOrders') {
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

      const res = await db.collection('orders').where({ status: 'paid' }).orderBy('startTime', 'asc').get()
      const radiusKm = Math.max(Number(profile.serviceRadiusKm || 5), 1)
      const normalizedSchedule = normalizeWeeklySchedule(profile.weeklySchedule)

      function isOrderInRange(order) {
        return order.distanceKm !== null && order.distanceKm <= radiusKm
      }

      function isOrderInTime(order) {
        if (!normalizedSchedule) {
          console.log('【调试-isOrderInTime】normalizedSchedule 为空，返回 true')
          return true
        }

        // 获取订单的所有时间段（支持单次和多次服务）
        const sessions = getOrderTimeRanges(order)
        console.log('【调试-isOrderInTime】订单时间段:', JSON.stringify(sessions))
        if (!sessions || sessions.length === 0) return true

        console.log('【调试-isOrderInTime】normalizedSchedule:', JSON.stringify(normalizedSchedule))

        // 检查每个时间段是否都在接单时间内
        for (const session of sessions) {
          if (!session.startTime) continue

          // 使用 parseDateTimeParts 正确解析北京时间
          const startParts = parseDateTimeParts(session.startTime)
          console.log('【调试-isOrderInTime】解析时间 session.startTime:', session.startTime)
          console.log('【调试-isOrderInTime】startParts:', JSON.stringify(startParts))
          console.log('【调试-isOrderInTime】dayOfWeek:', startParts.dayOfWeek, 'hour:', startParts.hour, 'minute:', startParts.minute)
          if (!startParts) continue

          const dayKey = String(startParts.dayOfWeek)
          const slots = normalizedSchedule[dayKey]
          console.log('【调试-isOrderInTime】dayKey:', dayKey)
          console.log('【调试-isOrderInTime】slots:', JSON.stringify(slots))

          // 如果某一天没有配置接单时间，视为不在时间内
          if (!Array.isArray(slots) || !slots.length) {
            console.log('【调试-isOrderInTime】该天未配置接单时间，返回 false')
            return false
          }

          // 使用北京时间的小时和分钟
          const orderHour = startParts.hour + startParts.minute / 60
          console.log('【调试-isOrderInTime】orderHour:', orderHour)

          // 检查是否在该天的任一时间段内
          const inSlot = slots.some((slot) => {
            const result = orderHour >= slot.start && orderHour < slot.end
            console.log('【调试-isOrderInTime】检查时间段 [', slot.start, '-', slot.end, ']:', result)
            return result
          })

          console.log('【调试-isOrderInTime】inSlot:', inSlot)

          // 如果任一时间段不在接单时间内，返回 false
          if (!inSlot) {
            console.log('【调试-isOrderInTime】订单时间不在接单时间段内，返回 false')
            return false
          }
        }

        // 所有时间段都在接单时间内
        console.log('【调试-isOrderInTime】所有时间段都在接单时间内，返回 true')
        return true
      }

      let orders = await Promise.all((res.data || []).filter((order) => !isAdminDeletedOrder(order) && isOpenOrder(order) && !order.isUrgent).map(async (order) => {
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
        result.inTime = isOrderInTime(result)
        return result
      }))

      // 1. 城市筛选：优先用订单 city 字段，历史订单无 city 时从服务地址解析；解析不到城市的旧数据默认保留。
      if (filterCity) {
        orders = orders.filter((order) => orderMatchesCity(order, filterCity))
      }

      // 2. 服务日期筛选 (Date Filter: YYYY-MM-DD)
      if (filterDate) {
        orders = orders.filter((order) => {
          if (!order.startTime) return false
          return String(order.startTime).startsWith(filterDate)
        })
      }

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
      const res = await db.collection('orders').where({ status: 'paid' }).orderBy('startTime', 'asc').get()
      const directOrders = await Promise.all((res.data || [])
        .filter((order) => !isAdminDeletedOrder(order) && order.publishMode === 'direct' && !order.staffOpenid && order.requestedStaffOpenid === openid)
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

      const res = await db.collection('orders').where({ status: 'paid' }).orderBy('startTime', 'asc').get()
      const urgentOrders = await Promise.all((res.data || [])
        .filter((order) => !isAdminDeletedOrder(order) && (order.isUrgent === true || order.assignmentSource === 'admin_urgent_republish') && !order.staffOpenid)
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
      const time = now()
      const existing = await db.collection('staff_schedule_exceptions').where({ staffOpenid: openid, dateKey: payload.dateKey }).limit(1).get()
      if (existing.data[0]) {
        await db.collection('staff_schedule_exceptions').doc(existing.data[0]._id).update({ data: { ...payload, updatedAt: time } })
        return { _id: existing.data[0]._id, ...existing.data[0], ...payload, updatedAt: time }
      }
      const created = await db.collection('staff_schedule_exceptions').add({ data: { ...payload, createdAt: time, updatedAt: time } })
      return { _id: created._id, ...payload, createdAt: time, updatedAt: time }
    }
    if (action === 'deleteScheduleException') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可设置排班')
      const dateKey = safeText(data.dateKey).trim()
      const existing = await db.collection('staff_schedule_exceptions').where({ staffOpenid: openid, dateKey }).limit(1).get()
      if (existing.data[0]) await db.collection('staff_schedule_exceptions').doc(existing.data[0]._id).remove()
      return { dateKey, deleted: true }
    }
    if (action === 'listScheduleAvailability') {
      const profileId = data.staffProfileId || data.requestedStaffProfileId
      let profile = null
      if (profileId) {
        profile = (await db.collection('staff_profiles').doc(profileId).get()).data
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
      const res = await db.collection('service_reviews').where({ staffProfileId: profile._id, status: 'visible' }).orderBy('createdAt', 'desc').get()
      return res.data.map((item) => ({ ...item, clientName: maskClientName(item.clientName) }))
    }
    if (action === 'checkUpcomingReminders') {
      const list = await sendUpcomingServiceRemindersToStaff()
      return { remindedCount: list.length, list }
    }
    if (action === 'listStaffOrders') {
      await sendUpcomingServiceRemindersToStaff()
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可查看')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = profileRes.data[0] || {}
      const latitude = Number(data.latitude || profile.currentLatitude || 0)
      const longitude = Number(data.longitude || profile.currentLongitude || 0)
      const res = await db.collection('orders').where({ staffOpenid: openid }).orderBy('createdAt', 'desc').get()
      let list = (res.data || []).filter((order) => !isAdminDeletedOrder(order))
      // 最近的订单排在最前面
      list.sort((a, b) => {
        const bTime = toTimeValue(b.createdAt || b.startTime)
        const aTime = toTimeValue(a.createdAt || a.startTime)
        return bTime - aTime
      })
      if (data.status && data.status !== 'all') list = list.filter((order) => order.status === data.status)
      if (data.statusGroup === 'waiting_service') list = list.filter((order) => ['assigned', 'in_service', 'day_completed'].includes(order.status))
      const orderKeyword = safeText(data.orderKeyword || data.keyword || data.orderNo).trim().toLowerCase()
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
      const startDate = safeText(data.startDate).trim()
      const endDate = safeText(data.endDate).trim()
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
      const decorate = async (order) => {
        const enriched = await attachOrderDisplayData(order)
        const distanceKm = calcDistanceKm(latitude, longitude, enriched.addressLatitude, enriched.addressLongitude)
        // 【新增】添加收益信息
        const earning = await calculateStaffEarningForOrder(enriched)
        return {
          ...enriched,
          distanceKm,
          distanceText: formatDistance(distanceKm),
          staffEarning: earning.earningAmount,
          staffEarningText: `¥${earning.earningAmount.toFixed(2)}`
        }
      }
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      if (wantsPage) {
        const page = paginateList(list, data)
        return { ...page, list: await Promise.all(page.list.map(decorate)) }
      }
      return Promise.all(list.map(decorate))
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
      const orderRes = await db.collection('orders').doc(data.orderId).get()
      const order = await expireUnacceptedOrder(data.orderId, orderRes.data)
      assertOrderTransition(order.status, ORDER_STATUS.ASSIGNED, '订单状态不可接单')
      if (order.staffOpenid) throw new Error('订单已被分配')
      const publishMode = order.publishMode === 'direct' ? 'direct' : 'open'
      if (publishMode === 'direct' && order.requestedStaffOpenid !== openid) throw new Error('该订单指定了其他宠托师')
      if (publishMode === 'open' && order.requestedStaffOpenid) throw new Error('该订单指定了其他宠托师')
      const conflict = await findStaffOrderConflict(profile.openid, order, data.orderId)
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

      const orderRes = await db.collection('orders').doc(data.orderId).get()
      const order = await expireUnacceptedOrder(data.orderId, orderRes.data)
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
      const assignedOrder = await assignOrderAtomically(data.orderId, order, assignmentUpdate, { depositConfig: settings.staffDeposit })
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

      const eventsRes = await db.collection('staff_deposit_events')
        .where({ staffOpenid: openid })
        .orderBy('createdAt', 'desc')
        .get()
        .catch(() => ({ data: [] }))
      const eventTypeMap = {
        pay: '充值缴纳',
        forfeit: '违规扣除/没收',
        refund_request: '申请退还',
        refund: '退款到账',
        refund_audit: '退款审核'
      }
      const events = (eventsRes.data || []).map((e) => ({
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
      let depositRes = await db.collection('staff_deposits').where({ staffOpenid: openid }).orderBy('createdAt', 'desc').limit(1).get()
      let deposit = depositRes.data && depositRes.data[0]
      const needsRepay = Boolean(profile && (profile.requireDepositRepay === true || profile.depositStatus === 'supplement_required' || profile.depositStatus === 'forfeited' || (deposit && deposit.status === 'forfeited')))
      if (deposit && deposit.status !== 'unpaid' && !needsRepay) throw new Error('您已足额缴纳保证金或记录正在处理中，无需重复缴纳')
      const time = now()
      const amount = Number(config.amount)
      if (!deposit || deposit.status !== 'unpaid') {
        const created = await db.collection('staff_deposits').add({
          data: {
            staffOpenid: openid,
            staffUserId: user._id,
            staffProfileId: profile._id,
            amount,
            paidAmount: 0,
            refundedAmount: 0,
            forfeitedAmount: 0,
            availableRefundAmount: 0,
            status: 'unpaid',
            statusText: '待支付',
            refundStatus: '',
            clientRequestId,
            createdAt: time,
            updatedAt: time
          }
        })
        deposit = { _id: created._id, staffOpenid: openid, staffUserId: user._id, staffProfileId: profile._id, amount, paidAmount: 0, refundedAmount: 0, forfeitedAmount: 0, availableRefundAmount: 0, status: 'unpaid', statusText: '待支付', refundStatus: '', clientRequestId, createdAt: time, updatedAt: time }
      }
      const paymentMode = (settings.payment && settings.payment.mode) || 'mock'
      if (paymentMode === 'mock') {
        const paymentNo = `dep_mock_${Date.now()}`
        await markStaffDepositPaid(deposit._id, { paymentNo, channel: 'mock' })
        return { paid: true, depositId: deposit._id }
      } else {
        const configWechat = getWechatPayConfig(settings)
        let paymentRecord = (await db.collection('payments').where({ orderId: deposit._id, targetType: 'staff_deposit', status: 'pending' }).limit(1).get()).data[0]
        if (!paymentRecord) {
          const paymentNo = createPaymentNo()
          const pCreated = await db.collection('payments').add({
            data: {
              orderId: deposit._id,
              depositId: deposit._id,
              targetType: 'staff_deposit',
              openid,
              paymentNo,
              prepayId: '',
              wxTransactionId: '',
              amount,
              currency: 'CNY',
              status: 'pending',
              channel: 'wechat',
              clientRequestId,
              idempotencyKey: clientRequestId || makeIdempotencyKey('payment', deposit._id, paymentNo),
              rawRequest: {},
              rawCallback: {},
              createdAt: time,
              updatedAt: time
            }
          })
          paymentRecord = { _id: pCreated._id, paymentNo, prepayId: '' }
        }
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
      const res = await db.collection('staff_deposits').where({ staffOpenid: openid }).orderBy('createdAt', 'desc').limit(1).get()
      if (!res.data[0]) throw new Error('暂无可退还保证金')
      return requestStaffDepositRefund(openid, res.data[0]._id, reason)
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
