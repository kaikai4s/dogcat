module.exports = function createService({
  ORDER_STATUS,
  createPetSnapshot,
  db,
  getActiveServiceSession,
  getMemberLevels,
  readScopedDocuments,
  updateByQuery,
  getNextPendingServiceSession,
  mask,
  normalizeServiceSessions,
  now,
  resolveUserMemberLevel,
  roleText,
  safeFileId,
  safeText,
  sitterDisplayName,
  toTimeValue
}) {
  function safeUserSummary(user = {}, extra = {}) {
    const roles = Array.isArray(user.roles) ? user.roles : ['client']
    return {
      _id: user._id || '',
      openid: user.openid || '',
      nickname: user.nickname || '微信用户',
      avatarUrl: user.avatarUrl || '',
      phone: user.phone || '',
      roles,
      rolesText: roleText(roles),
      activeRole: user.activeRole || 'client',
      status: user.status || 'active',
      memberLevel: user.memberLevel || '',
      memberLevelName: user.memberLevelName || '普通会员',
      badgeTag: user.badgeTag || 'V1',
      badgeStyle: user.badgeStyle || 'gold',
      nameColor: user.nameColor || '',
      nameEffect: user.nameEffect || '',
      points: Number(user.points || 0),
      totalPoints: Number(user.totalPoints || 0),
      retroCardCount: Number(user.retroCardCount || 0),
      completedOrderCount: Number(user.completedOrderCount || 0),
      createdAt: user.createdAt || '',
      updatedAt: user.updatedAt || '',
      ...extra
    }
  }

  function maskOrderClientContact(order) {
    if (!order) return order
    const maskedPhone = mask(order.contactPhone || (order.clientSnapshot && (order.clientSnapshot.contactPhone || order.clientSnapshot.phone))) || '受隐私保护'
    const maskedSnapshot = order.clientSnapshot ? {
      ...order.clientSnapshot,
      phone: maskedPhone,
      phoneMasked: maskedPhone,
      contactPhone: maskedPhone
    } : null
    return {
      ...order,
      phone: maskedPhone,
      clientPhone: maskedPhone,
      contactPhone: maskedPhone,
      contactPhoneMasked: maskedPhone,
      clientSnapshot: maskedSnapshot
    }
  }

  function maskOrderForStaffPreview(order) {
    if (!order) return order
    const withMaskedContact = maskOrderClientContact(order)
    return {
      ...withMaskedContact,
      addressDetail: '接单后可见',
      doorplate: '接单后可见',
      addressLatitude: null,
      addressLongitude: null,
      serviceLatitude: null,
      serviceLongitude: null,
      latitude: null,
      longitude: null,
      orderHomeSecurity: null,
      homeSecuritySnapshot: null,
      hasDoorLockCode: false,
      lockMethod: 'hidden',
      lockMethodText: '接单后可见'
    }
  }

  async function attachPetSnapshot(order) {
    let snapshot = order.petSnapshot || null
    if (order.petId) {
      try {
        const pet = (await db.collection('pets').doc(order.petId).get()).data
        if (pet) {
          const latest = createPetSnapshot({ ...pet, name: pet.name || order.petName || '' })
          snapshot = snapshot ? { ...snapshot, ...latest, avatarFileId: pet.avatarFileId || snapshot.avatarFileId || '', beautyTitle: pet.beautyTitle || null } : latest
        }
      } catch (error) {}
    }
    return {
      ...order,
      petSnapshot: snapshot
    }
  }

  function maskClientName(value) {
    const name = String(value || '').trim()
    if (!name) return '宠物主'
    return name.length <= 1 ? `${name}用户` : `${name.slice(0, 1)}* 用户`
  }

  function createClientSnapshot(user = {}, levels = []) {
    const nickname = safeText(user.nickname).trim()
    const levelInfo = resolveUserMemberLevel(user, levels)
    return {
      userId: safeText(user._id),
      nickname,
      displayName: maskClientName(nickname),
      avatarUrl: safeFileId(user.avatarUrl) || safeText(user.avatarUrl),
      phoneMasked: mask(safeText(user.phone).trim()),
      memberLevel: levelInfo.memberLevel,
      memberLevelName: levelInfo.memberLevelName,
      badgeTag: levelInfo.badgeTag,
      badgeStyle: levelInfo.badgeStyle,
      nameColor: levelInfo.nameColor,
      nameEffect: levelInfo.nameEffect
    }
  }

  async function syncClientOrderPhone(openid, phone) {
    const cleanPhone = safeText(phone).trim()
    const time = now()
    await updateByQuery('orders', { clientOpenid: openid }, (order) => ({
      contactPhone: cleanPhone,
      clientSnapshot: {
        ...(order.clientSnapshot || {}),
        phoneMasked: mask(cleanPhone)
      },
      updatedAt: time
    }))
  }

  async function getAdminClientContact(order) {
    if (!order.clientOpenid) return { phone: safeText(order.contactPhone).trim(), displayName: '', openid: '' }
    const userRes = await db.collection('users').where({ openid: order.clientOpenid }).limit(1).get()
    const user = userRes.data[0] || {}
    return {
      phone: safeText(user.phone || order.contactPhone).trim(),
      displayName: safeText(user.nickname).trim() || maskClientName(order.clientName || ''),
      openid: safeText(order.clientOpenid)
    }
  }

  async function getAdminStaffContact(order) {
    const staffOpenid = safeText(order.staffOpenid || order.requestedStaffOpenid).trim()
    const staffProfileId = safeText(order.staffProfileId || order.requestedStaffProfileId).trim()
    let profile = null
    if (staffProfileId) {
      try {
        const profileRes = await db.collection('staff_profiles').doc(staffProfileId).get()
        profile = profileRes.data || null
      } catch (error) {}
    }
    if (!profile && staffOpenid) {
      const profileRes = await db.collection('staff_profiles').where({ openid: staffOpenid }).limit(1).get()
      profile = profileRes.data[0] || null
    }
    let user = null
    const openidForUser = staffOpenid || safeText(profile && profile.openid).trim()
    if (openidForUser) {
      const userRes = await db.collection('users').where({ openid: openidForUser }).limit(1).get()
      user = userRes.data[0] || null
    }
    return {
      phone: safeText((profile && profile.phone) || (user && user.phone)).trim(),
      displayName: sitterDisplayName({ ...(profile || {}), nickname: user && user.nickname }) || safeText(order.staffName || order.requestedStaffName).trim(),
      openid: openidForUser,
      staffProfileId: staffProfileId || safeText(profile && profile._id).trim()
    }
  }

  async function attachClientSnapshot(order, levelsCache = null, userCache = null) {
    if (!order || !order.clientOpenid) return order
    try {
      const hasMapCache = userCache && typeof userCache.get === 'function'
      let user = hasMapCache ? userCache.get(order.clientOpenid) : null
      if (!user) {
        const userRes = await db.collection('users').where({ openid: order.clientOpenid }).limit(1).get()
        user = userRes.data[0]
        if (user && hasMapCache) userCache.set(order.clientOpenid, user)
      }
      if (!user) return order
      const levels = (Array.isArray(levelsCache) && levelsCache.length) ? levelsCache : await getMemberLevels()
      const latestSnapshot = createClientSnapshot(user, levels)
      return {
        ...order,
        clientSnapshot: {
          ...(order.clientSnapshot || {}),
          ...latestSnapshot,
          displayName: (order.clientSnapshot && order.clientSnapshot.displayName) || latestSnapshot.displayName,
          avatarUrl: (order.clientSnapshot && order.clientSnapshot.avatarUrl) || latestSnapshot.avatarUrl,
          memberLevel: latestSnapshot.memberLevel,
          memberLevelName: latestSnapshot.memberLevelName,
          badgeTag: latestSnapshot.badgeTag,
          badgeStyle: latestSnapshot.badgeStyle,
          nameColor: latestSnapshot.nameColor,
          nameEffect: latestSnapshot.nameEffect
        }
      }
    } catch (error) {
      return order
    }
  }

  async function attachOrderDisplayData(order, levelsCache = null, userCache = null) {
    const safeLevels = (Array.isArray(levelsCache) && levelsCache.length) ? levelsCache : null
    const safeUserCache = (userCache && typeof userCache.get === 'function') ? userCache : null
    const withPet = await attachPetSnapshot({ ...order, serviceSessions: normalizeServiceSessions(order) })
    return attachClientSnapshot(withPet, safeLevels, safeUserCache)
  }

  function isOrderOverdue(order, currentTime = now()) {
    if (!order) return false
    if (order.isStartOverdue || order.isFinishOverdue || order.finishOverdueIncidentCreated) return true
    const currentTs = toTimeValue(currentTime)
    if (!currentTs) return false

    if (order.status === ORDER_STATUS.ASSIGNED || order.status === ORDER_STATUS.DAY_COMPLETED) {
      const activeSession = getActiveServiceSession(order) || getNextPendingServiceSession(order) || (Array.isArray(order.serviceSessions) && order.serviceSessions[0])
      const sessionStartTime = toTimeValue((activeSession && activeSession.startTime) || order.startTime)
      if (sessionStartTime && currentTs - sessionStartTime >= 15 * 60 * 1000) {
        return true
      }
    } else if (order.status === ORDER_STATUS.IN_SERVICE) {
      const activeSession = getActiveServiceSession(order) || (Array.isArray(order.serviceSessions) && order.serviceSessions[0])
      const sessionStartedAt = toTimeValue(order.currentSessionStartedAt || (activeSession && activeSession.startedAt) || order.startedAt)
      const sessionEndTime = toTimeValue((activeSession && activeSession.endTime) || order.endTime)
      const durationMs = (Math.max(Number(order.durationMinutes || 60), 30)) * 60 * 1000
      const estimatedEndTime = sessionEndTime || (sessionStartedAt ? sessionStartedAt + durationMs : 0)
      if (estimatedEndTime && currentTs - estimatedEndTime >= 15 * 60 * 1000) {
        return true
      }
    }
    return false
  }

  async function attachAdminOrderContactData(order) {
    const displayOrder = await attachOrderDisplayData(order)
    const isOverdue = isOrderOverdue(order)
    return {
      ...displayOrder,
      autoCompleted: order.autoCompleted === true,
      isOverdue,
      isStartOverdue: order.isStartOverdue === true,
      isFinishOverdue: order.isFinishOverdue === true,
      clientContact: await getAdminClientContact(order),
      staffContact: await getAdminStaffContact(order),
      originalStaffContact: (order.originalStaffOpenid || (Array.isArray(order.previousStaffRecords) && order.previousStaffRecords[0]))
        ? await getAdminStaffContact({
            staffOpenid: order.originalStaffOpenid || order.previousStaffRecords[0].staffOpenid,
            staffProfileId: order.originalStaffProfileId || order.previousStaffRecords[0].staffProfileId,
            staffName: order.originalStaffName || order.previousStaffRecords[0].staffName
          })
        : null
    }
  }

  function toServiceReportOrder(order) {
    if (!order) return null
    const petSnapshot = order.petSnapshot || (Array.isArray(order.petSnapshots) && order.petSnapshots[0]) || null
    return {
      _id: order._id || '',
      orderNo: order.orderNo || '',
      status: order.status || '',
      autoCompleted: order.autoCompleted === true,
      petId: order.petId || '',
      petIds: Array.isArray(order.petIds) ? order.petIds : [order.petId].filter(Boolean),
      petName: order.petName || order.petSummary || '',
      petNames: Array.isArray(order.petNames) ? order.petNames : [],
      petSummary: order.petSummary || order.petName || '',
      petCategory: order.petCategory || (petSnapshot && petSnapshot.species) || '',
      pet: petSnapshot ? {
        name: petSnapshot.name || order.petName || '',
        species: petSnapshot.species || '',
        breed: petSnapshot.breed || '',
        avatarFileId: petSnapshot.avatarFileId || '',
        beautyTitle: petSnapshot.beautyTitle || null
      } : null,
      serviceType: order.serviceType || '',
      serviceTypes: Array.isArray(order.serviceTypes) ? order.serviceTypes : [order.serviceType].filter(Boolean),
      serviceLabels: Array.isArray(order.serviceLabels) ? order.serviceLabels : [],
      serviceSummary: order.serviceSummary || '',
      businessTypeText: order.businessTypeText || order.serviceSummary || '',
      serviceTime: order.serviceTime || `${order.startTime || ''}${order.endTime ? ` - ${order.endTime}` : ''}`,
      serviceStartDate: order.serviceStartDate || '',
      serviceEndDate: order.serviceEndDate || '',
      startTime: order.startTime || '',
      endTime: order.endTime || '',
      durationMinutes: Number(order.durationMinutes || 0),
      sessionCount: Number(order.sessionCount || 0),
      serviceSessions: Array.isArray(order.serviceSessions) ? order.serviceSessions.map((session) => ({
        index: session.index,
        date: session.date || '',
        startTime: session.startTime || '',
        endTime: session.endTime || '',
        status: session.status || '',
        startedAt: session.startedAt || '',
        finishedAt: session.finishedAt || ''
      })) : [],
      staffName: order.staffName || order.requestedStaffName || '',
      staffNickName: order.staffNickName || order.staffName || order.requestedStaffName || '',
      completedAt: order.completedAt || '',
      createdAt: order.createdAt || ''
    }
  }

  return {
    safeUserSummary,
    maskOrderClientContact,
    maskOrderForStaffPreview,
    attachPetSnapshot,
    maskClientName,
    createClientSnapshot,
    syncClientOrderPhone,
    getAdminClientContact,
    getAdminStaffContact,
    attachClientSnapshot,
    attachOrderDisplayData,
    isOrderOverdue,
    attachAdminOrderContactData,
    toServiceReportOrder
  }
}
