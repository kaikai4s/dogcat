module.exports = function createService({
  checkTextSecurity,
  db,
  incUpdateValue,
  now,
  readScopedDocuments,
  safeText
}) {
  const QUESTION_TYPES = ['single', 'multiple', 'rating', 'short_text', 'long_text']
  const ROLE_TYPES = ['client', 'staff']

  function cleanText(value, maxLength = 1000) {
    return safeText(value).trim().slice(0, maxLength)
  }

  function deterministicId(...parts) {
    return parts.map(part => cleanText(part, 120).replace(/[^a-zA-Z0-9_-]/g, '_')).filter(Boolean).join('_').slice(0, 500)
  }

  function normalizeRoles(value) {
    const list = Array.isArray(value) ? value : [value]
    return Array.from(new Set(list.map(item => cleanText(item, 20)).filter(item => ROLE_TYPES.includes(item))))
  }

  function normalizeQuestion(raw, index) {
    const type = cleanText(raw.type, 20)
    if (!QUESTION_TYPES.includes(type)) throw new Error(`第 ${index + 1} 题类型无效`)
    const title = cleanText(raw.title, 120)
    if (!title) throw new Error(`第 ${index + 1} 题标题不能为空`)
    const options = Array.isArray(raw.options)
      ? raw.options.map(item => cleanText(item, 80)).filter(Boolean).slice(0, 20)
      : []
    if (['single', 'multiple'].includes(type) && options.length < 2) throw new Error(`第 ${index + 1} 题至少需要 2 个选项`)
    const max = Math.min(Math.max(Math.round(Number(raw.max || 5)), 2), 10)
    return {
      id: cleanText(raw.id, 40) || `q_${index + 1}`,
      type,
      title,
      required: raw.required !== false,
      options,
      max,
      placeholder: cleanText(raw.placeholder, 80)
    }
  }

  function normalizeQuestions(value) {
    const questions = Array.isArray(value) ? value.map(normalizeQuestion) : []
    if (!questions.length) throw new Error('请至少添加 1 道题')
    if (questions.length > 30) throw new Error('单份问卷最多 30 道题')
    const ids = new Set()
    return questions.map((question, index) => {
      let id = question.id
      if (ids.has(id)) id = `q_${index + 1}`
      ids.add(id)
      return { ...question, id }
    })
  }

  function normalizeRewardConfig(value = {}) {
    const points = Math.max(Math.round(Number(value.points || 0)), 0)
    const couponTemplateId = cleanText(value.couponTemplateId, 80)
    const enabled = value.enabled !== false && (points > 0 || couponTemplateId)
    return { enabled, points, couponTemplateId }
  }

  function normalizeQuestionnairePayload(data = {}) {
    const title = cleanText(data.title, 80)
    if (!title) throw new Error('请填写问卷标题')
    const targetRoles = normalizeRoles(data.targetRoles)
    if (!targetRoles.length) throw new Error('请选择发布对象')
    return {
      title,
      description: cleanText(data.description, 500),
      targetRoles,
      questions: normalizeQuestions(data.questions),
      rewardConfig: normalizeRewardConfig(data.rewardConfig)
    }
  }

  function getUserRole(user, preferredRole = '') {
    const roles = Array.isArray(user.roles) ? user.roles : []
    const preferred = cleanText(preferredRole, 20)
    if (ROLE_TYPES.includes(preferred) && roles.includes(preferred)) return preferred
    if (roles.includes('staff')) return 'staff'
    return 'client'
  }

  function formatQuestionnaire(item, options = {}) {
    const reward = item.rewardConfig || {}
    return {
      _id: item._id,
      title: item.title || '',
      description: item.description || '',
      status: item.status || 'draft',
      targetRoles: Array.isArray(item.targetRoles) ? item.targetRoles : [],
      questions: options.includeQuestions ? (Array.isArray(item.questions) ? item.questions : []) : [],
      rewardConfig: reward,
      responseCount: Number(item.responseCount || 0),
      validResponseCount: Number(item.validResponseCount || 0),
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || null,
      publishedAt: item.publishedAt || null,
      closedAt: item.closedAt || null
    }
  }

  function formatResponse(item) {
    return {
      _id: item._id,
      questionnaireId: item.questionnaireId,
      questionnaireTitle: item.questionnaireTitle || '',
      openid: item.openid || '',
      userId: item.userId || '',
      role: item.role || 'client',
      answers: Array.isArray(item.answers) ? item.answers : [],
      aiQuality: item.aiQuality || null,
      rewardStatus: item.rewardStatus || 'pending',
      rewardMailIds: Array.isArray(item.rewardMailIds) ? item.rewardMailIds : [],
      createdAt: item.createdAt || null
    }
  }

  function matchOptionOrPrefix(val, options) {
    if (!val || !Array.isArray(options)) return false
    if (options.includes(val)) return true
    const colonIndex = val.indexOf(':')
    if (colonIndex > 0) {
      const prefix = val.slice(0, colonIndex).trim()
      if (options.includes(prefix)) return true
    }
    return false
  }

  function normalizeAnswer(question, rawAnswer) {
    const value = rawAnswer && Object.prototype.hasOwnProperty.call(rawAnswer, 'value') ? rawAnswer.value : rawAnswer
    if (question.type === 'single') {
      const text = cleanText(value, 120)
      if (!text && question.required) throw new Error(`请填写：${question.title}`)
      if (text && !matchOptionOrPrefix(text, question.options)) throw new Error(`选项无效：${question.title}`)
      return text
    }
    if (question.type === 'multiple') {
      const list = Array.isArray(value) ? value.map(item => cleanText(item, 120)).filter(Boolean) : []
      if (!list.length && question.required) throw new Error(`请填写：${question.title}`)
      if (list.some(item => !matchOptionOrPrefix(item, question.options))) throw new Error(`选项无效：${question.title}`)
      return Array.from(new Set(list))
    }
    if (question.type === 'rating') {
      const score = Math.round(Number(value || 0))
      if (!score && question.required) throw new Error(`请评分：${question.title}`)
      if (score && (score < 1 || score > Number(question.max || 5))) throw new Error(`评分无效：${question.title}`)
      return score
    }
    const maxLength = question.type === 'long_text' ? 1000 : 200
    const text = cleanText(value, maxLength)
    if (!text && question.required) throw new Error(`请填写：${question.title}`)
    return text
  }

  async function normalizeAnswers(openid, questionnaire, rawAnswers) {
    const map = new Map()
    const answers = Array.isArray(rawAnswers) ? rawAnswers : []
    answers.forEach(answer => map.set(cleanText(answer.questionId, 40), answer))
    const normalized = []
    for (const question of questionnaire.questions || []) {
      const value = normalizeAnswer(question, map.get(question.id))
      if (typeof value === 'string' && value && typeof checkTextSecurity === 'function') {
        await checkTextSecurity(openid, value, { scene: 2, label: '问卷回答内容' })
      }
      normalized.push({ questionId: question.id, title: question.title, type: question.type, value })
    }
    return normalized
  }

  function localQualityJudge(answers) {
    const textAnswers = (answers || []).filter(item => ['short_text', 'long_text'].includes(item.type))
    const textValues = textAnswers.map(item => cleanText(item.value, 1000)).filter(Boolean)
    const reasons = []
    let suspicious = 0

    if (textValues.length > 0) {
      textValues.forEach((text) => {
        if (text.length < 2) {
          suspicious += 1
          if (!reasons.includes('存在过短回答')) reasons.push('存在过短回答')
        }
        if (/^(.)\1{3,}$/.test(text)) {
          suspicious += 2
          if (!reasons.includes('存在字符连续重复')) reasons.push('存在字符连续重复')
        }
        if (/^[a-zA-Z0-9]{1,4}$/.test(text) || /(asdf|qwer|zxcv|1234|666|888)/i.test(text)) {
          suspicious += 2
          if (!reasons.includes('疑似键盘随意乱按字符')) reasons.push('疑似键盘随意乱按字符')
        }
        if (/^(不知道|随便|无|没有|乱填|test|测试|行|好|1|没|pass|null)$/i.test(text.trim())) {
          suspicious += 2
          if (!reasons.includes('回答内容敷衍无实质信息')) reasons.push('回答内容敷衍无实质信息')
        }
      })

      if (textValues.length >= 2) {
        const uniqueTexts = new Set(textValues)
        if (uniqueTexts.size === 1 && textValues[0].length < 15) {
          suspicious += 2
          if (!reasons.includes('多道题目回答内容完全相同')) reasons.push('多道题目回答内容完全相同')
        }
      }
    }

    const score = Math.max(0, 100 - suspicious * 30)
    const verdict = score < 50 ? 'fake' : (score < 80 ? 'suspicious' : 'valid')
    return { verdict, score, reasons, suspiciousQuestions: [] }
  }

  async function createRewardMails(questionnaire, response, user, options = {}) {
    const reward = questionnaire.rewardConfig || {}
    if (!reward.enabled || (!options.force && response.aiQuality && response.aiQuality.verdict === 'fake')) return []
    const time = now()
    const mailIds = []
    const base = {
      openid: user.openid,
      userId: user._id,
      targetType: 'openid_list',
      targetRoles: [response.role],
      sourceType: 'questionnaire',
      sourceId: response._id,
      readAt: null,
      claimedAt: null,
      rewardClaimResult: null,
      createdAt: time,
      updatedAt: time
    }

    async function upsertMail(type, mail) {
      const mailId = deterministicId('questionnaire_reward', response._id, type)
      if (typeof db.runTransaction === 'function') {
        return await db.runTransaction(async (tx) => {
          const existing = await tx.collection('reward_mails').doc(mailId).get().catch(() => ({ data: null }))
          if (existing && existing.data) return mailId
          await tx.collection('reward_mails').doc(mailId).set({ data: { ...mail, idempotencyKey: mailId } })
          return mailId
        })
      }
      const existing = await db.collection('reward_mails').doc(mailId).get().catch(() => ({ data: null }))
      if (!existing || !existing.data) {
        await db.collection('reward_mails').doc(mailId).set({ data: { ...mail, idempotencyKey: mailId } })
      }
      return mailId
    }

    if (Number(reward.points || 0) > 0) {
      const mail = {
        ...base,
        title: '问卷填写积分奖励',
        content: `感谢完成「${questionnaire.title}」，请领取 ${reward.points} 积分奖励。`,
        reward: { type: 'points', points: Number(reward.points || 0) }
      }
      mailIds.push(await upsertMail('points', mail))
    }
    if (reward.couponTemplateId) {
      let couponSnapshot = null
      try {
        const tmplRes = await db.collection('coupon_templates').doc(reward.couponTemplateId).get().catch(() => ({ data: null }))
        if (tmplRes && tmplRes.data) {
          couponSnapshot = {
            name: tmplRes.data.name || '问卷专享券',
            discountType: tmplRes.data.discountType,
            discountValue: tmplRes.data.discountValue,
            minOrderAmount: tmplRes.data.minOrderAmount
          }
        }
      } catch (_) {}
      const mail = {
        ...base,
        title: '问卷填写优惠券奖励',
        content: `感谢完成「${questionnaire.title}」，请领取问卷奖励优惠券。`,
        reward: {
          type: 'coupon',
          couponTemplateId: reward.couponTemplateId,
          couponSnapshot: couponSnapshot || { name: '问卷专享优惠券' }
        }
      }
      mailIds.push(await upsertMail('coupon', mail))
    }
    return mailIds
  }

  async function getQuestionnaire(id) {
    const questionnaireId = cleanText(id, 80)
    if (!questionnaireId) throw new Error('缺少问卷 ID')
    const res = await db.collection('questionnaires').doc(questionnaireId).get().catch(() => ({ data: null }))
    if (!res || !res.data) throw new Error('问卷不存在')
    return res.data
  }

  async function getExistingResponse(questionnaireId, openid) {
    return (await db.collection('questionnaire_responses').where({ questionnaireId, openid }).limit(1).get()).data[0]
  }

  async function listQuestionnaires(where = {}, options = {}) {
    const rows = await readScopedDocuments('questionnaires', where, 'createdAt', 'desc')
    return rows.map(item => formatQuestionnaire(item, options))
  }

  async function submitQuestionnaire(user, data = {}) {
    const questionnaire = await getQuestionnaire(data.id || data.questionnaireId)
    if (questionnaire.status !== 'published') throw new Error('问卷暂不可填写')
    const role = getUserRole(user, data.role)
    if (!Array.isArray(questionnaire.targetRoles) || !questionnaire.targetRoles.includes(role)) throw new Error('当前身份不可填写该问卷')
    const answers = await normalizeAnswers(user.openid, questionnaire, data.answers)
    const aiQuality = localQualityJudge(answers)
    const time = now()
    const responseId = deterministicId('qresp', questionnaire._id, user.openid)
    const response = {
      questionnaireId: questionnaire._id,
      questionnaireTitle: questionnaire.title,
      questionnaireSnapshot: {
        title: questionnaire.title,
        questions: questionnaire.questions || []
      },
      rewardConfigSnapshot: questionnaire.rewardConfig || { enabled: false, points: 0, couponTemplateId: '' },
      openid: user.openid,
      userId: user._id,
      role,
      answers,
      aiQuality,
      rewardStatus: 'pending',
      rewardMailIds: [],
      createdAt: time,
      updatedAt: time
    }

    if (typeof db.runTransaction === 'function') {
      await db.runTransaction(async (tx) => {
        const existing = await tx.collection('questionnaire_responses').doc(responseId).get().catch(() => ({ data: null }))
        if (existing && existing.data) throw new Error('你已提交过该问卷')
        const latestQDoc = await tx.collection('questionnaires').doc(questionnaire._id).get().catch(() => ({ data: null }))
        const latestQ = latestQDoc && latestQDoc.data ? latestQDoc.data : questionnaire
        if (latestQ.status !== 'published') throw new Error('问卷暂不可填写')
        if (!Array.isArray(latestQ.targetRoles) || !latestQ.targetRoles.includes(role)) throw new Error('当前身份不可填写该问卷')
        await tx.collection('questionnaire_responses').doc(responseId).set({ data: response })
        await tx.collection('questionnaires').doc(questionnaire._id).update({
          data: {
            responseCount: incUpdateValue(latestQ.responseCount, 1),
            validResponseCount: incUpdateValue(latestQ.validResponseCount, aiQuality.verdict === 'valid' ? 1 : 0),
            updatedAt: time
          }
        })
      })
    } else {
      const existing = await getExistingResponse(questionnaire._id, user.openid)
      if (existing) throw new Error('你已提交过该问卷')
      await db.collection('questionnaire_responses').doc(responseId).set({ data: response })
      await db.collection('questionnaires').doc(questionnaire._id).update({
        data: {
          responseCount: incUpdateValue(questionnaire.responseCount, 1),
          validResponseCount: incUpdateValue(questionnaire.validResponseCount, aiQuality.verdict === 'valid' ? 1 : 0),
          updatedAt: time
        }
      })
    }

    let rewardStatus = 'skipped'
    let rewardMailIds = []
    try {
      rewardMailIds = await createRewardMails(questionnaire, { ...response, _id: responseId }, user)
      rewardStatus = rewardMailIds.length ? 'sent' : 'skipped'
    } catch (error) {
      rewardStatus = 'failed'
    }
    await db.collection('questionnaire_responses').doc(responseId).update({ data: { rewardStatus, rewardMailIds, updatedAt: now() } })
    return formatResponse({ ...response, _id: responseId, rewardStatus, rewardMailIds })
  }

  return {
    QUESTION_TYPES,
    ROLE_TYPES,
    cleanText,
    normalizeQuestionnairePayload,
    normalizeRewardConfig,
    getUserRole,
    formatQuestionnaire,
    formatResponse,
    getQuestionnaire,
    getExistingResponse,
    listQuestionnaires,
    submitQuestionnaire,
    createRewardMails,
    localQualityJudge
  }
}
