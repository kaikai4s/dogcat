module.exports = function createHandler(context) {
  const {
    bindInviteRelation,
    bindInviteCode,
    checkImageSecurity,
    checkRateLimit,
    checkTextSecurity,
    claimCheckinReward,
    cloud,
    db,
    createUserOnce,
    enrichUserMemberLevel,
    ensureMonthConfig,
    executeDailyCheckin,
    getOptionalUser,
    getSystemSettings,
    getUser,
    grantEligiblePetTitlesForUser,
    isValidFontKey,
    isValidThemeKey,
    normalizeCheckinReward,
    normalizeFontKey,
    normalizeThemeKey,
    now,
    isProductionPaymentEnv,
    isValidMobilePhone,
    safeFileId,
    safeText,
    syncClientOrderPhone,
    toCstParts
  } = context
  const profileUpdateTimestamps = new Map()
  function checkProfileUpdateRateLimit(userOpenid, maxPerMinute = 15) {
    if (!userOpenid) return
    const nowTs = Date.now()
    const oneMinuteAgo = nowTs - 60 * 1000
    let userTimestamps = profileUpdateTimestamps.get(userOpenid) || []
    userTimestamps = userTimestamps.filter((t) => t >= oneMinuteAgo)
    if (userTimestamps.length >= maxPerMinute) {
      throw new Error('个人资料更新过于频繁，请稍后再试')
    }
    userTimestamps.push(nowTs)
    profileUpdateTimestamps.set(userOpenid, userTimestamps)
  }

  function mockPhoneCodeAllowed(settings = {}) {
    if (typeof isProductionPaymentEnv === 'function' && isProductionPaymentEnv()) return false
    if (process.env.NODE_ENV === 'production' || process.env.PAYMENT_ENV === 'production') return false
    if (settings.enableTestAddressMode === true) return true
    if (process.env.ALLOW_MOCK_PHONE_CODE === 'true') return true
    return true
  }

  async function resolveWechatPhone(code, settings = {}) {
    const isMockCode = code.includes('mock') || code === 'the code is a mock one' || code.startsWith('mock_')
    if (isMockCode) {
      if (!mockPhoneCodeAllowed(settings)) throw new Error('正式环境禁止使用模拟手机号授权码')
      return '13800138000'
    }
    if (settings.enableTestAddressMode && mockPhoneCodeAllowed(settings)) return '13800138000'
    try {
      const phoneResult = await cloud.openapi.phonenumber.getPhoneNumber({ code })
      const phoneInfo = (phoneResult && (phoneResult.phoneInfo || phoneResult.phone_info)) || {}
      return safeText(phoneInfo.phoneNumber || phoneInfo.purePhoneNumber || phoneInfo.phone_number || phoneInfo.pure_phone_number).trim()
    } catch (error) {
      const message = error.message || error.errMsg || JSON.stringify(error)
      if (message.includes('40029') || message.includes('invalid code')) {
        throw new Error('手机号授权已过期或失效，请重新授权')
      }
      throw new Error(`调用微信手机号接口失败：${message}`)
    }
  }

  async function validatePhoneBinding(phone, user, data = {}) {
    if (!isValidMobilePhone(phone)) throw new Error('手机号格式不正确，请输入有效的11位手机号码')
    const initAdminPhones = safeText(process.env.INIT_ADMIN_PHONES)
      .split(',')
      .map(p => p.trim())
      .filter(Boolean)
    if (initAdminPhones.includes(phone) && (!Array.isArray(user.roles) || !user.roles.includes('admin'))) {
      const secret = safeText(process.env.INIT_ADMIN_SECRET).trim()
      const providedSecret = safeText(data.secret).trim()
      if (!secret || providedSecret !== secret) {
        throw new Error('该手机号受系统安全保护，禁止直接绑定')
      }
    }
    const settings = await getSystemSettings().catch(() => ({}))
    if (phone === '13800138000' && mockPhoneCodeAllowed(settings)) {
      return
    }
    const existingRes = await db.collection('users').where({ phone, status: 'active' }).limit(1).get()
    const existingUser = existingRes && existingRes.data && existingRes.data[0]
    if (existingUser && existingUser.openid && existingUser.openid !== user.openid) {
      throw new Error('该手机号码已被其他账号绑定')
    }
  }

  return async function auth(openid, action, data) {
    if (action === 'login') {
      let user = await getOptionalUser(openid)
      const time = now()
      if (!user) {
        const userData = {
          openid,
          phone: '',
          nickname: '微信用户',
          avatarUrl: '',
          roles: ['client'],
          activeRole: 'client',
          status: 'active',
          themeKey: normalizeThemeKey(data.themeKey),
          fontKey: normalizeFontKey(data.fontKey),
          preferences: { themeKey: normalizeThemeKey(data.themeKey), fontKey: normalizeFontKey(data.fontKey) },
          retroCardCount: 0,
          completedOrderCount: 0,
          inviterOpenid: '',
          inviteCode: '',
          createdAt: time,
          updatedAt: time
        }
        user = await createUserOnce(openid, userData)
      }
      if (user.status !== 'active') throw new Error('账号不可用')
      if (data.agreementVersion === '2026-10-23') {
        await db.collection('users').doc(user._id).update({ data: { loginAgreementVersion: data.agreementVersion, loginAgreementAcceptedAt: time } })
        user = { ...user, loginAgreementVersion: data.agreementVersion, loginAgreementAcceptedAt: time }
      }
      user = await bindInviteRelation(user, data)
      const enriched = await enrichUserMemberLevel(user)
      await grantEligiblePetTitlesForUser(enriched)
      return enriched
    }

    if (action === 'loginByPhoneCode') {
      const code = safeText(data.code).trim()
      if (!code) throw new Error('未获取到手机号授权码')
      const settings = await getSystemSettings().catch(() => ({}))
      const phone = await resolveWechatPhone(code, settings)
      if (!phone) throw new Error('手机号授权获取失败')
      const time = now()
      let user = await getOptionalUser(openid)
      const userForValidation = user || { openid, roles: ['client'], status: 'active' }
      await validatePhoneBinding(phone, userForValidation, data)
      if (!user) {
        const userData = {
          openid,
          phone,
          nickname: '微信用户',
          avatarUrl: '',
          roles: ['client'],
          activeRole: 'client',
          status: 'active',
          themeKey: normalizeThemeKey(data.themeKey),
          fontKey: normalizeFontKey(data.fontKey),
          preferences: { themeKey: normalizeThemeKey(data.themeKey), fontKey: normalizeFontKey(data.fontKey) },
          retroCardCount: 0,
          completedOrderCount: 0,
          inviterOpenid: '',
          inviteCode: '',
          createdAt: time,
          updatedAt: time
        }
        user = await createUserOnce(openid, userData)
      }
      if (user.status !== 'active') throw new Error('账号不可用')
      const oldPhone = safeText(user.phone).trim()
      if (phone !== oldPhone) {
        await db.collection('users').doc(user._id).update({ data: { phone, updatedAt: time } })
        await syncClientOrderPhone(openid, phone)
        user = { ...user, phone, updatedAt: time }
      }
      user = await bindInviteRelation(user, data)
      const enriched = await enrichUserMemberLevel(user)
      await grantEligiblePetTitlesForUser(enriched)
      return enriched
    }

    if (action === 'checkSession') {
      // Page entry must not wait for reward checks or grant writes.
      return enrichUserMemberLevel(await getUser(openid))
    }

    if (action === 'me') {
      const user = await getUser(openid)
      const enriched = await enrichUserMemberLevel(user)
      await grantEligiblePetTitlesForUser(enriched)
      return enriched
    }

    if (action === 'dailyCheckin') {
      const result = await executeDailyCheckin(openid, { allowAlreadyCheckedIn: true })
      if (result.alreadyCheckedIn) {
        return {
          checkedIn: true,
          points: Number(result.user.points || 0),
          retroCardCount: Number(result.user.retroCardCount || 0)
        }
      }
      return {
        checkedIn: false,
        points: Number(result.user.points || 0),
        retroCardCount: Number(result.user.retroCardCount || 0),
        delta: result.claimed.pointsDelta,
        rewardSnapshot: result.claimed.rewardSnapshot
      }
    }

    if (action === 'updateProfile') {
      checkProfileUpdateRateLimit(openid, 15)
      if (typeof checkRateLimit === 'function') await checkRateLimit(openid, 'auth.updateProfile', { max: 15, windowMs: 60 * 1000, message: '个人资料更新过于频繁，请稍后再试' })
      const user = await getUser(openid)
      const oldPhone = safeText(user.phone).trim()
      const nickname = safeText(data.nickname).trim()
      if (!nickname) throw new Error('昵称不能为空')
      if (nickname.length > 30) throw new Error('昵称不能超过 30 字')
      if (nickname !== user.nickname) {
        await checkTextSecurity(openid, nickname, { scene: 1, label: '用户昵称' })
      }
      const avatarUrl = safeFileId(data.avatarUrl) || safeText(data.avatarUrl)
      if (avatarUrl && avatarUrl !== user.avatarUrl) {
        await checkImageSecurity(openid, avatarUrl, { scene: 1, label: '用户头像' })
      }
      const rawPhone = data.phone !== undefined ? safeText(data.phone).trim() : oldPhone
      if (rawPhone !== oldPhone) {
        throw new Error('修改手机号请使用微信手机号授权')
      }
      const payload = {
        nickname,
        avatarUrl,
        phone: rawPhone,
        updatedAt: now()
      }
      if (data.residentialCommunity !== undefined) {
        if (!data.residentialCommunity || !data.residentialCommunity.name) {
          payload.residentialCommunity = null
        } else {
          payload.residentialCommunity = {
            name: safeText(data.residentialCommunity.name).trim(),
            address: safeText(data.residentialCommunity.address || '').trim(),
            latitude: Number(data.residentialCommunity.latitude || 0),
            longitude: Number(data.residentialCommunity.longitude || 0),
            city: safeText(data.residentialCommunity.city || '').trim(),
            district: safeText(data.residentialCommunity.district || '').trim(),
            ...(data.residentialCommunity.serviceCommunityId ? { serviceCommunityId: safeText(data.residentialCommunity.serviceCommunityId) } : {}),
            updatedAt: now()
          }
        }
      }
      if (data.residentialCommunity !== undefined) {
        if (payload.residentialCommunity?.serviceCommunityId) payload.residentialCommunity = (await require('../services/playground-communities')(context).entry(payload.residentialCommunity, user)).community
        payload.residentialCommunity = await require('../services/playground-world').updateCommunity(db, openid, user._id, payload.residentialCommunity, payload, checkTextSecurity)
      } else {
        await db.collection('users').doc(user._id).update({ data: payload })
      }
      if (payload.phone !== oldPhone) await syncClientOrderPhone(openid, payload.phone)
      return { ...user, ...payload }
    }

    if (action === 'updateCommunity') {
      const user = await getUser(openid)
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
          ...(community.serviceCommunityId ? { serviceCommunityId: safeText(community.serviceCommunityId) } : {}),
          updatedAt: now()
        }
      }
      if (normalizedCommunity?.serviceCommunityId) normalizedCommunity = (await require('../services/playground-communities')(context).entry(normalizedCommunity, user)).community
      normalizedCommunity = await require('../services/playground-world').updateCommunity(db, openid, user._id, normalizedCommunity, { updatedAt: now() }, checkTextSecurity)
      return { ...user, residentialCommunity: normalizedCommunity }
    }

    if (action === 'updateTheme') {
      const user = await getUser(openid)
      if (!isValidThemeKey(data.themeKey)) throw new Error('主题无效')
      const themeKey = normalizeThemeKey(data.themeKey)
      const preferences = {
        ...(user.preferences || {}),
        themeKey
      }
      const payload = { themeKey, preferences, updatedAt: now() }
      await db.collection('users').doc(user._id).update({ data: payload })
      return { ...user, ...payload }
    }

    if (action === 'updateFont') {
      const user = await getUser(openid)
      if (!isValidFontKey(data.fontKey)) throw new Error('字体无效')
      const fontKey = normalizeFontKey(data.fontKey)
      const preferences = {
        ...(user.preferences || {}),
        fontKey
      }
      const payload = { fontKey, preferences, updatedAt: now() }
      await db.collection('users').doc(user._id).update({ data: payload })
      return { ...user, ...payload }
    }

    if (action === 'updatePrivacySettings') {
      const user = await getUser(openid)
      const privacySettings = {
        ...(user.privacySettings || {}),
        hidePublicCheckinPhotos: data.hidePublicCheckinPhotos === true
      }
      const payload = {
        privacySettings,
        hidePublicCheckinPhotos: privacySettings.hidePublicCheckinPhotos,
        updatedAt: now()
      }
      await db.collection('users').doc(user._id).update({ data: payload })
      return { ...user, ...payload }
    }

    if (action === 'bindPhone') {
      const user = await getUser(openid)
      const oldPhone = safeText(user.phone).trim()
      const code = safeText(data.code).trim()
      if (!code) throw new Error('请使用微信手机号授权')
      const settings = await getSystemSettings()
      const phone = await resolveWechatPhone(code, settings)
      await validatePhoneBinding(phone, user, data)

      const updateTime = now()
      await db.collection('users').doc(user._id).update({ data: { phone, updatedAt: updateTime } })
      if (phone !== oldPhone) await syncClientOrderPhone(openid, phone)
      return { ...user, phone, updatedAt: updateTime }
    }

    if (action === 'switchRole') {
      const user = await getUser(openid)
      if (!Array.isArray(user.roles) || !user.roles.includes(data.role)) throw new Error('当前账号无此角色权限')
      await db.collection('users').doc(user._id).update({ data: { activeRole: data.role, updatedAt: now() } })
      return { ...user, activeRole: data.role }
    }

    if (action === 'bindInviteCode') {
      return bindInviteCode(openid, data)
    }

    throw new Error('未知 auth 操作')
  }
}
