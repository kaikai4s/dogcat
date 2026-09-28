module.exports = function createHandler(context) {
  const {
    bindInviteRelation,
    checkImageSecurity,
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
    safeFileId,
    safeText,
    syncClientOrderPhone,
    toCstParts
  } = context
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
      let phone = ''
      const settings = await getSystemSettings().catch(() => ({}))
      const isMockCode = code.includes('mock') || code === 'the code is a mock one' || code.startsWith('mock_')

      if (isMockCode || settings.enableTestAddressMode) {
        phone = '13800138000'
      } else {
        try {
          const phoneResult = await cloud.openapi.phonenumber.getPhoneNumber({ code })
          const phoneInfo = (phoneResult && (phoneResult.phoneInfo || phoneResult.phone_info)) || {}
          phone = safeText(phoneInfo.phoneNumber || phoneInfo.purePhoneNumber || phoneInfo.phone_number || phoneInfo.pure_phone_number).trim()
        } catch (error) {
          const message = error.message || error.errMsg || JSON.stringify(error)
          if (message.includes('40029') || message.includes('invalid code')) {
            throw new Error('手机号授权已过期或失效，请重新授权')
          }
          throw new Error(`调用微信手机号接口失败：${message}`)
        }
      }

      if (!phone) throw new Error('手机号授权获取失败')
      let user = await getOptionalUser(openid)
      const time = now()
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
        await db.collection('users').doc(user._id).update({ data: { phone, updatedAt: time } })
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
      const user = await getUser(openid)
      const oldPhone = safeText(user.phone).trim()
      const nickname = safeText(data.nickname).trim()
      if (!nickname) throw new Error('昵称不能为空')
      if (nickname !== user.nickname) {
        await checkTextSecurity(openid, nickname, { scene: 1, label: '用户昵称' })
      }
      const avatarUrl = safeFileId(data.avatarUrl) || safeText(data.avatarUrl)
      if (avatarUrl && avatarUrl !== user.avatarUrl) {
        await checkImageSecurity(openid, avatarUrl, { scene: 1, label: '用户头像' })
      }
      const payload = {
        nickname,
        avatarUrl,
        phone: data.phone !== undefined ? safeText(data.phone).trim() : oldPhone,
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
      const phone = String(data.phone || '').trim()
      if (!phone) throw new Error('手机号不能为空')
      if (!/^1\d{10}$/.test(phone)) throw new Error('请输入有效的11位手机号码')
      await db.collection('users').doc(user._id).update({ data: { phone, updatedAt: now() } })
      if (phone !== oldPhone) await syncClientOrderPhone(openid, phone)
      return { ...user, phone }
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
