module.exports = function createHandler(context) {
  const {
    VISIT_FEE_SERVICE_KEY,
    checkImageSecurity,
    checkTextSecurity,
    checkinEventText,
    crypto,
    db,
    getHomePageData,
    getSubscriptionBalanceSummary,
    getSystemSettings,
    getUser,
    listServiceCheckinRules,
    listServicePrices,
    notifyAdminAudit,
    now,
    recordSubscriptionBalance,
    resolveCheckinRequirements,
    safeFileId,
    safeText
  } = context

  const DEFAULT_STEP_DESCRIPTIONS = {
    sanitization: '上门前穿戴一次性防护用品，并使用宠物安全消毒液完成手部与随身工具消毒',
    enter_door: '宠托师按预约时间准时到达，拍照打卡确认入户并留意门锁与室内环境',
    leash_on: '仔细核对并佩戴好牵引绳、胸背带或防逃脱装备后再外出',
    feed: '按宠物主喂养说明清洗食碗、定量添粮，并记录进食情况',
    water: '彻底清洗饮水盆并更换新鲜干净饮用水',
    clean: '清理猫砂盆/宠物厕所及周边散落物，保持居家环境整洁卫生',
    medicine: '严格核对药品名称、剂量与喂食时间，按要求温柔协助喂药',
    pet_status: '观察宠物精神状态、食欲及排便情况，拍照或视频同步给家长',
    return_home: '安全护送宠物返家，擦拭脚爪并确认室内水电门窗安全',
    leave_door: '整理物品、确认门锁落锁到位后拍照打卡离户，同步生成服务报告',
    video_checkin: '通过视频记录互动或服务关键瞬间，让家长更直观了解爱宠状态',
    pet_beauty_photo: '为爱宠拍摄可爱定妆美照，记录本次上门的美好瞬间'
  }

  const feedbackTimestamps = new Map()
  function checkFeedbackRateLimit(userOpenid, maxPerMinute = 5) {
    if (!userOpenid) return
    const nowTs = Date.now()
    const oneMinuteAgo = nowTs - 60 * 1000
    let userTimestamps = feedbackTimestamps.get(userOpenid) || []
    userTimestamps = userTimestamps.filter((t) => t >= oneMinuteAgo)
    if (userTimestamps.length >= maxPerMinute) {
      throw new Error('反馈提交过于频繁，请稍后再试')
    }
    userTimestamps.push(nowTs)
    feedbackTimestamps.set(userOpenid, userTimestamps)
  }

  return async function system(openid, action, data) {
    if (action === 'getSettings') return getSystemSettings()
    if (action === 'getHomePageData') return getHomePageData(openid, data)
    if (action === 'getPublicServiceDetail') {
      const key = safeText(data.key || data.serviceType).trim()
      if (!key) throw new Error('缺少服务项目标识')
      const [services, rules, requirements, settings] = await Promise.all([
        listServicePrices(false),
        listServiceCheckinRules(),
        resolveCheckinRequirements([key]),
        getSystemSettings()
      ])
      const service = services.find((item) => item.key === key)
      if (!service) throw new Error('服务项目不存在或已下架')
      const visitFeeItem = services.find((item) => item.key === VISIT_FEE_SERVICE_KEY)
      const ruleMap = rules
        .filter((rule) => rule.serviceType === key && rule.enabled !== false)
        .reduce((map, rule) => ({ ...map, [rule.eventType]: rule }), {})
      const flowSteps = (requirements || []).map((step, index) => {
        const rule = ruleMap[step.eventType] || {}
        const label = safeText(step.label || rule.label || checkinEventText(step.eventType)).trim() || '服务环节'
        const description = safeText(rule.description || DEFAULT_STEP_DESCRIPTIONS[step.eventType] || '').trim()
        return {
          stepNumber: String(index + 1).padStart(2, '0'),
          eventType: step.eventType,
          label,
          description,
          required: step.required !== false && !step.optional,
          optional: Boolean(step.optional)
        }
      })
      return {
        service: {
          ...service,
          priceText: `¥${service.price}起`
        },
        visitFeePrice: visitFeeItem ? Number(visitFeeItem.price || 0) : 0,
        flowSteps,
        maintenance: (settings && settings.maintenance) || {}
      }
    }
    if (action === 'getSubscriptionSummary') {
      await getUser(openid)
      const settings = await getSystemSettings()
      const templates = settings.subscription && settings.subscription.templates || {}
      const templateIds = Array.from(new Set(Object.values(templates).map(value => safeText(value).trim()).filter(Boolean)))
      const balances = await getSubscriptionBalanceSummary(openid, templateIds)
      return {
        items: Object.fromEntries(Object.entries(templates).map(([templateKey, value]) => {
          const templateId = safeText(value).trim()
          const balance = balances[templateId]
          return [templateKey, {
            templateId,
            known: Boolean(balance),
            acceptedCount: balance && balance.acceptedCount || 0,
            consumedCount: balance && balance.consumedCount || 0,
            estimatedRemaining: balance && balance.estimatedRemaining || 0,
            needsResubscribe: Boolean(balance && balance.needsResubscribe),
            updatedAt: balance && balance.updatedAt || null
          }]
        }))
      }
    }
    if (action === 'recordSubscriptionConsent') {
      await getUser(openid)
      const templateKeys = Array.isArray(data.templateKeys) ? Array.from(new Set(data.templateKeys.map(value => safeText(value).trim()).filter(Boolean))) : []
      if (!templateKeys.length || templateKeys.length > 12) throw new Error('订阅模板数量不正确')
      const requestId = safeText(data.requestId).trim()
      if (!requestId || requestId.length > 100) throw new Error('订阅请求标识无效')
      const results = data.results && typeof data.results === 'object' ? data.results : {}
      const settings = await getSystemSettings()
      const configuredTemplates = settings.subscription && settings.subscription.templates || {}
      const time = now()
      const scene = safeText(data.scene).trim().slice(0, 100)
      const allowedStatuses = new Set(['accept', 'reject', 'ban', 'filter', 'unknown'])
      const records = templateKeys.map((templateKey) => {
        const templateId = safeText(configuredTemplates[templateKey]).trim()
        if (!templateId) throw new Error(`订阅模板未配置：${templateKey}`)
        const status = safeText(results[templateId] || results[templateKey] || 'unknown').trim()
        if (!allowedStatuses.has(status)) throw new Error('订阅授权状态无效')
        return { openid, requestId, templateKey, templateId, status, scene, createdAt: time, updatedAt: time }
      })
      if (new Set(records.map(record => record.templateId)).size > 3) throw new Error('每次最多订阅 3 个模板')
      for (const record of records) {
        const consentId = `consent_${crypto.createHash('sha256').update(`${openid}|${requestId}|${record.templateKey}`).digest('hex').slice(0, 32)}`
        await db.collection('subscription_consents').doc(consentId).set({ data: record })
      }
      const acceptedTemplateIds = Array.from(new Set(records.filter(record => record.status === 'accept').map(record => record.templateId)))
      for (const templateId of acceptedTemplateIds) {
        await recordSubscriptionBalance(openid, templateId, requestId)
      }
      const balances = await getSubscriptionBalanceSummary(openid, acceptedTemplateIds)
      return { count: records.length, acceptedCount: acceptedTemplateIds.length, balances }
    }
    if (action === 'getCustomerServiceInfo') {
      const settings = await getSystemSettings()
      return {
        ...(settings.customerService || {}),
        officialAccount: settings.officialAccount || {}
      }
    }
    if (action === 'getOfficialAccountConfig') {
      const settings = await getSystemSettings()
      return settings.officialAccount || {}
    }
    if (action === 'checkTextSecurity') {
      return checkTextSecurity(openid, data.content, data.options || {})
    }
    if (action === 'checkImageSecurity') {
      return checkImageSecurity(openid, data.fileId || data.mediaUrl, data.options || {})
    }
    if (action === 'submitFeedback') {
      const user = await getUser(openid)
      checkFeedbackRateLimit(openid, 5)
      const content = safeText(data.content).trim()
      const category = safeText(data.category).trim() || 'general'
      const contactInfo = safeText(data.contactInfo).trim()
      if (!content) throw new Error('请输入反馈内容')
      if (content.length > 2000) throw new Error('反馈内容不超过 2000 字')
      if (contactInfo.length > 100) throw new Error('联系方式不能超过 100 字')
      if (typeof checkTextSecurity === 'function') {
        await checkTextSecurity(openid, content, { scene: 2, label: '反馈内容' })
        if (contactInfo) {
          await checkTextSecurity(openid, contactInfo, { scene: 2, label: '联系方式' })
        }
      }
      const mediaFileIds = Array.isArray(data.mediaFileIds) ? data.mediaFileIds.slice(0, 9).map(safeFileId).filter(Boolean) : []
      if (mediaFileIds.length && typeof checkImageSecurity === 'function') {
        await Promise.all(mediaFileIds.map((fileId) => checkImageSecurity(openid, fileId, { scene: 2, label: '反馈附件图片' })))
      }
      const time = now()
      const feedback = {
        openid,
        userId: user._id,
        nickname: user.nickname || '',
        phone: user.phone || '',
        category,
        content,
        contactInfo,
        mediaFileIds,
        status: 'pending',
        createdAt: time,
        updatedAt: time
      }
      const created = await db.collection('user_feedback').add({ data: feedback })
      if (typeof notifyAdminAudit === 'function') {
        notifyAdminAudit({
          auditType: 'user_feedback',
          targetId: created._id,
          applicant: user.nickname || user.phone || '用户',
          type: '用户反馈待处理',
          reason: content.slice(0, 20) || '提交产品意见与建议',
          page: 'pages/admin/home/index'
        }).catch(() => {})
      }
      return { _id: created._id }
    }
    throw new Error('未知 system 操作')
  }
}
