module.exports = function createService({
  db,
  defaultHomeModules,
  normalizeStaffDepositConfig,
  normalizeStaffSuppliesConfig,
  normalizeStaffTrainingConfig,
  now,
  safeNumber,
  safeText
}) {
  function normalizeHomeHeroCarousel(carousel = {}) {
    const source = typeof carousel === 'object' && carousel !== null ? carousel : {}
    const rawItems = Array.isArray(source.items) ? source.items : []
    const items = rawItems
      .map((item, index) => {
        const type = item && item.type === 'video' ? 'video' : 'image'
        const fileId = safeText(item && item.fileId).trim()
        if (!fileId) return null
        return {
          id: safeText(item && item.id).trim() || `hero_${Date.now()}_${index}`,
          type,
          fileId,
          posterFileId: safeText(item && item.posterFileId).trim(),
          title: safeText(item && item.title).trim(),
          subtitle: safeText(item && item.subtitle).trim(),
          linkType: safeText(item && item.linkType).trim() || (item && item.linkUrl ? 'custom' : 'none'),
          linkUrl: safeText(item && (item.linkUrl || item.url || item.path)).trim(),
          linkTitle: safeText(item && item.linkTitle).trim(),
          enabled: item && item.enabled !== false,
          sort: safeNumber(item && item.sort) || (index + 1) * 10
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.sort - b.sort)

    const interval = safeNumber(source.rotateIntervalMs || source.interval)
    const rotateIntervalMs = interval >= 1000 ? Math.min(interval, 30000) : 5000

    return {
      enabled: source.enabled === true,
      autoRotate: source.autoRotate !== false,
      rotateIntervalMs,
      items
    }
  }

  function normalizeHomePageConfig(homePage = {}) {
    const modules = homePage.modules || {}
    return {
      ctaTitle: safeText(homePage.ctaTitle).trim() || '立即预约上门宠护',
      ctaSubtitle: safeText(homePage.ctaSubtitle).trim() || '填写宠物和服务时间，平台认证宠托师快速响应。',
      ctaText: safeText(homePage.ctaText).trim() || '立即预约',
      nearbyTitle: safeText(homePage.nearbyTitle).trim() || '附近宠托师',
      repeatTitle: safeText(homePage.repeatTitle).trim() || '一键复购',
      couponTitle: safeText(homePage.couponTitle).trim() || '新人优惠',
      assuranceTitle: safeText(homePage.assuranceTitle).trim() || '平台保障',
      modules: Object.keys(defaultHomeModules).reduce((result, key) => ({
        ...result,
        [key]: modules[key] !== false
      }), {})
    }
  }

  function pickPaymentSecret(payment, existingPayment, field, inputField) {
    const directValue = payment[field]
    const inputValue = inputField ? payment[inputField] : undefined
    if (inputValue !== undefined) {
      const normalized = safeText(inputValue).trim()
      return normalized || safeText(existingPayment[field]).trim()
    }
    if (directValue !== undefined) {
      const normalized = safeText(directValue).trim()
      return normalized || safeText(existingPayment[field]).trim()
    }
    return safeText(existingPayment[field]).trim()
  }

  function maskConfigured(value) {
    return safeText(value).trim() ? true : false
  }

  function normalizePaymentConfig(payment = {}, existingPayment = {}, includeSecrets = false) {
    const apiV3Key = pickPaymentSecret(payment, existingPayment, 'apiV3Key', 'apiV3KeyInput')
    const privateKey = pickPaymentSecret(payment, existingPayment, 'privateKey', 'privateKeyInput')
    const platformPublicKey = pickPaymentSecret(payment, existingPayment, 'platformPublicKey', 'platformPublicKeyInput')
    const certSerialNo = safeText(payment.certSerialNo ?? payment.merchantCertSerialNo ?? existingPayment.certSerialNo).trim()
    const rawMode = payment.mode ?? existingPayment.mode
    const normalized = {
      enabled: payment.enabled !== undefined ? payment.enabled !== false : existingPayment.enabled !== false,
      mode: rawMode === 'wechat' ? 'wechat' : 'mock',
      mchId: safeText(payment.mchId ?? existingPayment.mchId).trim(),
      appId: safeText(payment.appId ?? existingPayment.appId).trim(),
      notifyUrl: safeText(payment.notifyUrl ?? existingPayment.notifyUrl).trim(),
      certSerialNo,
      merchantCertSerialNo: certSerialNo,
      refundEnabled: payment.refundEnabled !== undefined ? payment.refundEnabled !== false : existingPayment.refundEnabled !== false,
      allowMockInProduction: payment.allowMockInProduction !== undefined ? payment.allowMockInProduction === true : existingPayment.allowMockInProduction === true,
      apiV3KeyConfigured: maskConfigured(apiV3Key || process.env.WECHAT_PAY_API_V3_KEY),
      privateKeyConfigured: maskConfigured(privateKey || process.env.WECHAT_PAY_PRIVATE_KEY),
      platformPublicKeyConfigured: maskConfigured(platformPublicKey || process.env.WECHAT_PAY_PLATFORM_PUBLIC_KEY)
    }
    if (includeSecrets) {
      normalized.apiV3Key = apiV3Key
      normalized.privateKey = privateKey
      normalized.platformPublicKey = platformPublicKey
    }
    return normalized
  }

  function normalizeSystemSettings(value = {}, options = {}) {
    const payment = value.payment || {}
    const existingPayment = options.existingPayment || {}
    const settlement = value.settlement || {}
    const subscription = value.subscription || {}
    const reliability = value.reliability || {}
    const includeSecrets = options.includeSecrets === true
    const existingSettings = options.existingSettings || options.previousValue || {}
    const rawQwenApiKey = value.qwenApiKeyInput !== undefined ? value.qwenApiKeyInput : value.qwenApiKey
    const qwenApiKey = (rawQwenApiKey !== undefined ? safeText(rawQwenApiKey).trim() : '') || safeText(existingSettings.qwenApiKey).trim()
    const qwenApiKeyConfigured = maskConfigured(qwenApiKey || process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY)

    const normalized = {
      enableTestAddressMode: value.enableTestAddressMode === true,
      enablePetBreedAi: value.enablePetBreedAi !== false,
      qwenApiKeyConfigured,
      qwenModel: safeText(value.qwenModel).trim() || 'qwen3.5-flash',
      staffTraining: normalizeStaffTrainingConfig(value.staffTraining),
      staffDeposit: normalizeStaffDepositConfig(value.staffDeposit),
      staffSupplies: normalizeStaffSuppliesConfig(value.staffSupplies),
      homeHeroCarousel: normalizeHomeHeroCarousel(value.homeHeroCarousel),
      homePage: normalizeHomePageConfig(value.homePage),
      payment: normalizePaymentConfig(payment, existingPayment, includeSecrets),
      settlement: {
        staffCommissionRate: Math.min(Math.max(Number(settlement.staffCommissionRate ?? 0.7), 0), 1),
        settlementDelayDays: Math.max(Math.round(Number(settlement.settlementDelayDays ?? 1)), 0),
        minWithdrawAmount: Math.max(Number(settlement.minWithdrawAmount ?? 10), 0),
        withdrawFeeRate: Math.min(Math.max(Number(settlement.withdrawFeeRate || 0), 0), 1)
      },
      subscription: {
        enabled: subscription.enabled === true,
        templates: {
          orderPaid: safeText(subscription.templates && subscription.templates.orderPaid).trim(),
          orderAssigned: safeText(subscription.templates && subscription.templates.orderAssigned).trim(),
          orderAccepted: safeText(subscription.templates && subscription.templates.orderAccepted).trim(),
          serviceStart: safeText(subscription.templates && subscription.templates.serviceStart).trim(),
          serviceFinish: safeText(subscription.templates && subscription.templates.serviceFinish).trim(),
          remoteUnlock: safeText(subscription.templates && subscription.templates.remoteUnlock).trim(),
          refundResult: safeText(subscription.templates && subscription.templates.refundResult).trim(),
          disputeUpdate: safeText(subscription.templates && subscription.templates.disputeUpdate).trim(),
          withdrawResult: safeText(subscription.templates && subscription.templates.withdrawResult).trim(),
          upcomingServiceReminder: safeText(subscription.templates && (subscription.templates.upcomingServiceReminder || subscription.templates.serviceReminder)).trim()
        }
      },
      reliability: {
        enableOfflineQueue: reliability.enableOfflineQueue !== false,
        maxTrackBatchSize: Math.min(Math.max(Math.round(Number(reliability.maxTrackBatchSize || 50)), 1), 200),
        maxRetryTimes: Math.min(Math.max(Math.round(Number(reliability.maxRetryTimes || 5)), 0), 20)
      },
      customerService: {
        phone: safeText((value.customerService || {}).phone).trim(),
        wechatId: safeText((value.customerService || {}).wechatId).trim(),
        workHours: safeText((value.customerService || {}).workHours).trim() || '每天 9:00-21:00',
        officialAccountName: safeText((value.customerService || {}).officialAccountName).trim()
      },
      checkinShare: {
        title: safeText((value.checkinShare || {}).title).trim() || '来签到领福利，补签卡也能拿',
        imageUrl: safeText((value.checkinShare || {}).imageUrl).trim()
      }
    }

    if (includeSecrets) {
      normalized.qwenApiKey = qwenApiKey
    }

    return normalized
  }

  async function getSystemSettings(options = {}) {
    const res = await db.collection('platform_configs').where({ key: 'system_settings' }).limit(1).get()
    return normalizeSystemSettings(res.data[0] ? res.data[0].value : {}, options)
  }

  async function saveSystemSettings(settings) {
    if (settings.staffDeposit) {
      const amount = Number(settings.staffDeposit.amount ?? 0)
      // 先验证基本条件，避免 amountYuanToFen 抛出通用错误
      if (!Number.isFinite(amount) || amount < 0) {
        throw new Error('【保证金设置】保证金金额必须是有效的非负数')
      }
      if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) {
        throw new Error('【保证金设置】保证金金额最多两位小数')
      }
      if (settings.staffDeposit.enabled === true && amount <= 0) {
        throw new Error('【保证金设置】启用保证金时金额必须大于0')
      }
      // 验证金额转换为分是否安全
      const amountFen = Math.round(amount * 100)
      if (!Number.isSafeInteger(amountFen)) {
        throw new Error('【保证金设置】金额过大，请输入合理的金额')
      }
    }
    const time = now()
    const existing = await db.collection('platform_configs').where({ key: 'system_settings' }).limit(1).get()
    const previousValue = existing.data[0] ? existing.data[0].value : {}
    const value = normalizeSystemSettings(settings, { includeSecrets: true, existingSettings: previousValue, existingPayment: previousValue.payment || {} })
    const payload = { key: 'system_settings', value, updatedAt: time }
    if (existing.data[0]) {
      await db.collection('platform_configs').doc(existing.data[0]._id).update({ data: payload })
      return { _id: existing.data[0]._id, ...payload }
    }
    const created = await db.collection('platform_configs').add({ data: { ...payload, createdAt: time } })
    return { _id: created._id, ...payload, createdAt: time }
  }

  return {
    normalizeHomeHeroCarousel,
    normalizeHomePageConfig,
    pickPaymentSecret,
    maskConfigured,
    normalizePaymentConfig,
    normalizeSystemSettings,
    getSystemSettings,
    saveSystemSettings
  }
}
