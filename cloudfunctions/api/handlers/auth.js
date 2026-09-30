module.exports = function createHandler(context) {
  const {
    bindInviteRelation,
    checkImageSecurity,
    checkRateLimit,
    checkTextSecurity,
    claimCheckinReward,
    cloud,
    db,
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
    if (settings.enableTestAddressMode) return '13800138000'
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
    const existingRes = await db.collection('users').where({ phone, status: 'active' }).limit(1).get().catch(() => ({ data: [] }))
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
        const created = await db.collection('users').add({ data: userData })
        user = { _id: created._id, ...userData }
      }
      if (user.status !== 'active') throw new Error('账号不可用')
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
        const created = await db.collection('users').add({ data: userData })
        user = { _id: created._id, ...userData }
      } else {
        if (user.status !== 'active') throw new Error('账号不可用')
        const oldPhone = safeText(user.phone).trim()
        await db.collection('users').doc(user._id).update({ data: { phone, updatedAt: time } })
        if (phone !== oldPhone) await syncClientOrderPhone(openid, phone)
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
      if (rawPhone && rawPhone !== oldPhone) {
        await validatePhoneBinding(rawPhone, user, data)
      }
      const payload = {
        nickname,
        avatarUrl,
        phone: rawPhone,
        updatedAt: now()
      }
      await db.collection('users').doc(user._id).update({ data: payload })
      if (payload.phone !== oldPhone) await syncClientOrderPhone(openid, payload.phone)
      return { ...user, ...payload }
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
      let phone = String(data.phone || '').trim()
      const code = safeText(data.code).trim()

      if (code) {
        const settings = await getSystemSettings().catch(() => ({}))
        phone = phone || await resolveWechatPhone(code, settings)
      }

      if (!phone) throw new Error('手机号不能为空')
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

    throw new Error('未知 auth 操作')
  }
}
