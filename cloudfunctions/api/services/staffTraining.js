module.exports = function createService({
  DEFAULT_DISPOSABLE_SUPPLY_ITEMS,
  DEFAULT_STAFF_TRAINING_PASS_SCORE,
  DEFAULT_STAFF_TRAINING_QUIZ,
  QUIZ_OPTION_VALUES,
  STAFF_TRAINING_VIDEOS,
  STAFF_VIDEO_AUDIT_GUIDE,
  safeText
}) {
  function parseDurationSeconds(item = {}) {
    const explicit = Number(item.durationSeconds)
    if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit)
    const text = safeText(item.durationText).trim()
    const minuteMatch = text.match(/(\d+(?:\.\d+)?)\s*分钟/)
    if (minuteMatch) return Math.round(Number(minuteMatch[1]) * 60)
    const secondMatch = text.match(/(\d+(?:\.\d+)?)\s*秒/)
    if (secondMatch) return Math.round(Number(secondMatch[1]))
    return 0
  }

  function normalizeTrainingVideos(videos = STAFF_TRAINING_VIDEOS) {
    const source = Array.isArray(videos) ? videos : []
    const normalized = source.map((item, index) => {
      const title = safeText(item.title).trim()
      const key = safeText(item.key).trim() || `video_${index + 1}`
      if (!title || !key) return null
      return {
        key,
        title,
        durationText: safeText(item.durationText).trim(),
        durationSeconds: parseDurationSeconds(item),
        description: safeText(item.description).trim(),
        fileId: safeText(item.fileId).trim(),
        posterFileId: safeText(item.posterFileId).trim(),
        enabled: item.enabled !== false,
        sort: Number(item.sort) || (index + 1) * 10
      }
    }).filter(Boolean).sort((a, b) => a.sort - b.sort)
    return normalized.length ? normalized : STAFF_TRAINING_VIDEOS.map((item, index) => ({ ...item, durationSeconds: parseDurationSeconds(item), fileId: '', posterFileId: '', enabled: true, sort: (index + 1) * 10 }))
  }

  function enabledTrainingVideos(training = {}) {
    return normalizeTrainingVideos(training.videos).filter((item) => item.enabled !== false)
  }

  function normalizeVideoAuditGuide(guide = {}) {
    const source = guide || {}
    return {
      wechatId: safeText(source.wechatId).trim() || STAFF_VIDEO_AUDIT_GUIDE.wechatId,
      remarkTemplate: safeText(source.remarkTemplate).trim() || STAFF_VIDEO_AUDIT_GUIDE.remarkTemplate,
      description: safeText(source.description).trim() || STAFF_VIDEO_AUDIT_GUIDE.description,
      requiredItemsNotice: safeText(source.requiredItemsNotice).trim() || STAFF_VIDEO_AUDIT_GUIDE.requiredItemsNotice,
      strictWarning: safeText(source.strictWarning).trim() || STAFF_VIDEO_AUDIT_GUIDE.strictWarning
    }
  }

  function normalizeStaffTrainingConfig(training = {}) {
    const passScore = Math.min(Math.max(Math.round(Number(training.passScore ?? DEFAULT_STAFF_TRAINING_PASS_SCORE)), 1), 100)
    const sourceQuiz = Array.isArray(training.quiz) ? training.quiz : []
    const quiz = sourceQuiz.map((item, index) => {
      const question = safeText(item.question).trim()
      const options = (Array.isArray(item.options) ? item.options : []).map((option, optionIndex) => ({
        value: QUIZ_OPTION_VALUES[optionIndex] || safeText(option.value).trim(),
        label: safeText(option.label).trim()
      })).filter((option) => option.value && option.label).slice(0, QUIZ_OPTION_VALUES.length)
      const answer = safeText(item.answer).trim()
      if (!question || options.length < 2 || !options.some((option) => option.value === answer)) return null
      return {
        id: safeText(item.id).trim() || `q${index + 1}`,
        type: 'single',
        question,
        options,
        answer
      }
    }).filter(Boolean)

    return {
      passScore,
      quiz: quiz.length ? quiz : DEFAULT_STAFF_TRAINING_QUIZ,
      videos: normalizeTrainingVideos(training.videos),
      videoAuditGuide: normalizeVideoAuditGuide(training.videoAuditGuide)
    }
  }

  function publicTrainingQuiz(quiz = []) {
    return quiz.map(({ answer, ...item }) => item)
  }

  function normalizeStaffDepositConfig(deposit = {}) {
    return {
      enabled: deposit.enabled === true && Number.isFinite(Number(deposit.amount)) && Number(deposit.amount) > 0,
      amount: Number.isFinite(Number(deposit.amount)) ? Math.max(Number(deposit.amount || 0), 0) : 0,
      rulesText: safeText(deposit.rulesText).trim() || '资料审核通过后需支付宠托师保证金；退出宠托师且无未结事项时可申请退还。',
      refundRulesText: safeText(deposit.refundRulesText).trim() || '退出宠托师时平台审核后按可退余额原路退回。',
      forfeitRulesText: safeText(deposit.forfeitRulesText).trim() || '如出现私单、严重服务违规、虚假打卡等不合规行为，平台可按规则扣除或没收保证金。'
    }
  }

  function normalizeStaffSuppliesItems(items = [], fallbackRequired = []) {
    if (Array.isArray(items) && items.length) {
      const list = items.map((item, index) => {
        if (typeof item === 'string') {
          const name = safeText(item).trim()
          if (!name) return null
          const defaultMatch = DEFAULT_DISPOSABLE_SUPPLY_ITEMS.find((d) => d.name === name)
          return {
            id: `supply_${index + 1}`,
            name,
            description: defaultMatch ? defaultMatch.description : '',
            purchaseUrl: '',
            enabled: true
          }
        }
        const name = safeText(item && item.name).trim()
        if (!name) return null
        return {
          id: safeText(item.id).trim() || `supply_${index + 1}`,
          name,
          description: safeText(item.description).trim(),
          purchaseUrl: safeText(item.purchaseUrl).trim(),
          enabled: item.enabled !== false
        }
      }).filter(Boolean)
      if (!list.some((item) => item.name.includes('鞋套'))) {
        list.splice(2, 0, { id: 'supply_shoes', name: '一次性鞋套', description: '进门即穿戴，保护家庭卫生', purchaseUrl: '', enabled: true })
      }
      return list
    }
    if (Array.isArray(fallbackRequired) && fallbackRequired.length) {
      const list = fallbackRequired.map((name, index) => {
        const cleanName = safeText(name).trim()
        if (!cleanName) return null
        const defaultMatch = DEFAULT_DISPOSABLE_SUPPLY_ITEMS.find((d) => d.name === cleanName)
        return {
          id: `supply_${index + 1}`,
          name: cleanName,
          description: defaultMatch ? defaultMatch.description : '',
          purchaseUrl: '',
          enabled: true
        }
      }).filter(Boolean)
      if (!list.some((item) => item.name.includes('鞋套'))) {
        list.splice(2, 0, { id: 'supply_shoes', name: '一次性鞋套', description: '进门即穿戴，保护家庭卫生', purchaseUrl: '', enabled: true })
      }
      return list
    }
    return DEFAULT_DISPOSABLE_SUPPLY_ITEMS.map((item, index) => ({
      id: `supply_${index + 1}`,
      ...item
    }))
  }

  function normalizeTransferLimit(value) {
    if (value === undefined || value === null || value === '') return ''
    const number = Number(value)
    const fen = Math.round(number * 100)
    if (!Number.isFinite(number) || number < 0 || !Number.isSafeInteger(fen) || Math.abs(number * 100 - fen) > 0.000001) throw new Error('微信转账额度配置不正确，金额需为非负数且最多两位小数')
    return fen / 100
  }

  function normalizeReimbursementCount(value, label) {
    if (value === undefined) return 0
    const count = Number(value)
    const validType = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()))
    if (!validType || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`【用品报销设置】${label}必须是有效的非负整数，不设门槛请填写 0`)
    }
    return count
  }

  function normalizeStaffSuppliesConfig(supplies = {}) {
    const items = normalizeStaffSuppliesItems(supplies.items, supplies.requiredItems)
    const requiredItems = items.filter((i) => i.enabled !== false).map((i) => i.name)
    const rawScenes = supplies.transfer?.scenes || {}
    const normalizeScene = (scene, defaultSceneId = '', defaultPerception = '', defaultReports = []) => {
      const sceneId = safeText(scene?.sceneId || defaultSceneId).trim()
      const userRecvPerception = safeText(scene?.userRecvPerception || defaultPerception).trim()
      const rawReports = Array.isArray(scene?.sceneReportInfos) && scene.sceneReportInfos.length ? scene.sceneReportInfos : (Array.isArray(defaultReports) ? defaultReports : [])
      const sceneReportInfos = rawReports.map((item) => ({
        info_type: safeText(item && item.info_type).trim(),
        info_content: safeText(item && item.info_content).trim()
      })).filter(item => item.info_type && item.info_content)
      return { sceneId, userRecvPerception, sceneReportInfos }
    }

    const topSceneId = safeText(supplies.transfer?.sceneId).trim()
    const topPerception = safeText(supplies.transfer?.userRecvPerception).trim()
    const topReports = (Array.isArray(supplies.transfer?.sceneReportInfos) ? supplies.transfer.sceneReportInfos : []).map((item) => ({
      info_type: safeText(item && item.info_type).trim(),
      info_content: safeText(item && item.info_content).trim()
    })).filter(item => item.info_type && item.info_content)

    const commissionScene = normalizeScene(rawScenes.commission, topSceneId, topPerception, topReports)
    const marketingScene = normalizeScene(rawScenes.marketing, '', '', [])
    const reimbursementScene = normalizeScene(rawScenes.reimbursement, '', '', [])

    const finalSceneId = topSceneId || commissionScene.sceneId
    const finalPerception = topPerception || commissionScene.userRecvPerception
    const finalReports = topReports.length ? topReports : commissionScene.sceneReportInfos

    return {
      reimbursementEnabled: supplies.reimbursementEnabled !== false,
      maxReimbursementAmount: Number.isFinite(Number(supplies.maxReimbursementAmount)) && Number(supplies.maxReimbursementAmount) > 0 ? Number(supplies.maxReimbursementAmount) : 200,
      reimbursementAmount: Number.isFinite(Number(supplies.reimbursementAmount)) && Number(supplies.reimbursementAmount) > 0 ? Math.round(Number(supplies.reimbursementAmount) * 100) / 100 : (Number.isFinite(Number(supplies.maxReimbursementAmount)) && Number(supplies.maxReimbursementAmount) > 0 ? Number(supplies.maxReimbursementAmount) : 200),
      reimbursementMode: ['order_count', 'invite_count', 'either'].includes(safeText(supplies.reimbursementMode).trim()) ? safeText(supplies.reimbursementMode).trim() : 'order_count',
      reimbursementOrderCount: normalizeReimbursementCount(supplies.reimbursementOrderCount, '需完成订单数量'),
      reimbursementInviteCount: normalizeReimbursementCount(supplies.reimbursementInviteCount, '需邀请绑定人数'),
      purchaseRequired: supplies.purchaseRequired === true,
      transfer: {
        enabled: supplies.transfer?.enabled === true,
        sceneId: finalSceneId,
        userRecvPerception: finalPerception,
        platformDailyMaxAmount: normalizeTransferLimit(supplies.transfer?.platformDailyMaxAmount),
        maxAmount: normalizeTransferLimit(supplies.transfer?.maxAmount),
        recipientDailyMaxAmount: normalizeTransferLimit(supplies.transfer?.recipientDailyMaxAmount),
        sceneReportInfos: finalReports,
        scenes: {
          commission: commissionScene,
          marketing: marketingScene,
          reimbursement: reimbursementScene
        }
      },
      items,
      requiredItems: requiredItems.length ? requiredItems : ['一次性手套', '一次性口罩', '一次性鞋套', '安全宠物消毒用品'],
      auditNotice: safeText(supplies.auditNotice).trim() || '线上视频审核会严格检查必备用品准备情况，用品齐全不代表一定通过；如因其他原因未正式通过，平台不提供报销。',
      serviceReminder: safeText(supplies.serviceReminder).trim() || '出发前请确认已携带一次性手套、一次性口罩、一次性鞋套和安全宠物消毒用品；开始服务后请先完成隔离病菌/消毒拍照打卡。'
    }
  }

  function getSupplyReimbursementQualification(supplies, completedOrderCount, eligibleInviteCount) {
    const mode = supplies.reimbursementMode || 'order_count'
    const modes = mode === 'either' ? ['order_count', 'invite_count'] : [mode]
    const conditions = modes.map(conditionMode => {
      const requiredCount = Number(conditionMode === 'invite_count' ? supplies.reimbursementInviteCount ?? 0 : supplies.reimbursementOrderCount ?? 0)
      const progressCount = conditionMode === 'invite_count' ? eligibleInviteCount : completedOrderCount
      return { mode: conditionMode, requiredCount, progressCount, met: requiredCount <= 0 || progressCount >= requiredCount }
    })
    // Preserve the original single-progress fields for older app versions.
    const progress = conditions.find(condition => condition.met) || conditions[0]
    return {
      mode,
      requiredCount: progress.requiredCount,
      progressCount: progress.progressCount,
      completedOrderCount,
      eligibleInviteCount,
      conditions,
      qualificationMet: conditions.some(condition => condition.met)
    }
  }

  return {
    normalizeTrainingVideos,
    enabledTrainingVideos,
    normalizeVideoAuditGuide,
    normalizeStaffTrainingConfig,
    publicTrainingQuiz,
    normalizeStaffDepositConfig,
    normalizeStaffSuppliesItems,
    normalizeStaffSuppliesConfig,
    getSupplyReimbursementQualification
  }
}
