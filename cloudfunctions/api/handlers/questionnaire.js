module.exports = function createHandler(context) {
  const {
    cloud,
    createRewardMails,
    db,
    formatQuestionnaire,
    formatResponse,
    getQuestionnaire,
    getUser,
    getUserRole,
    localQualityJudge,
    normalizeQuestionnairePayload,
    now,
    readScopedDocuments,
    requireAdmin,
    safeText,
    sendSystemNotification,
    submitQuestionnaire
  } = context

  function text(value, max = 1000) {
    return safeText(value).trim().slice(0, max)
  }

  function parseJsonObject(raw, fallback) {
    if (!raw) return fallback
    if (typeof raw === 'object' && !Array.isArray(raw)) return raw
    const str = typeof raw === 'string' ? raw : String(raw)
    let content = str.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
    if (codeBlockMatch && codeBlockMatch[1]) {
      content = codeBlockMatch[1].trim()
    }
    try {
      return JSON.parse(content)
    } catch (_) {}
    const start = content.indexOf('{')
    const end = content.lastIndexOf('}')
    if (start >= 0 && end > start) {
      const sub = content.slice(start, end + 1)
      try {
        return JSON.parse(sub)
      } catch (_) {
        try {
          const fixed = sub.replace(/,\s*([}\]])/g, '$1')
          return JSON.parse(fixed)
        } catch (err) {}
      }
    }
    return fallback
  }

  async function runAiJson(messages, fallback) {
    try {
      const aiExt = (cloud && cloud.extend && cloud.extend.AI) ? cloud.extend.AI : ((cloud && cloud.ai) || null)
      if (!aiExt) return { data: fallback, success: false, source: 'fallback', model: null }
      let model
      try {
        model = aiExt.createModel('hunyuan')
      } catch (_) {
        try {
          model = aiExt.createModel('cloudbase')
        } catch (modelErr) {
          console.warn('[questionnaire] createModel failed:', modelErr && modelErr.message)
          return { data: fallback, success: false, source: 'fallback', model: null }
        }
      }
      if (!model || typeof model.generateText !== 'function') {
        return { data: fallback, success: false, source: 'fallback', model: null }
      }
      const res = await model.generateText({ model: 'hy3', messages })
      let output = ''
      if (res && res.choices && res.choices[0] && res.choices[0].message) output = res.choices[0].message.content
      else if (res && res.text) output = res.text
      else if (res && typeof res === 'string') output = res
      else if (res && res.Response && res.Response.Choices && res.Response.Choices[0] && res.Response.Choices[0].Message) {
        output = res.Response.Choices[0].Message.Content
      }
      const parsed = parseJsonObject(output, null)
      if (parsed && typeof parsed === 'object') {
        return { data: parsed, success: true, source: 'hy3', model: 'hy3' }
      }
      console.warn('[questionnaire] Failed to parse JSON from hy3 output:', output)
      return { data: fallback, success: false, source: 'fallback', model: 'hy3' }
    } catch (error) {
      console.warn('[questionnaire] hy3 model call encountered error:', error && (error.message || error))
      return { data: fallback, success: false, source: 'fallback', model: null }
    }
  }

  function buildCharts(questionnaire, responses) {
    const questions = Array.isArray(questionnaire.questions) ? questionnaire.questions : []
    const charts = []
    questions.forEach((question) => {
      const answers = responses.map(response => (response.answers || []).find(item => item.questionId === question.id)).filter(Boolean)
      if (['single', 'multiple'].includes(question.type)) {
        const counts = {}
        const otherSamples = []
        ;(question.options || []).forEach(option => { counts[option] = 0 })
        let totalVotes = 0
        answers.forEach(answer => {
          const value = answer.value
          const list = Array.isArray(value) ? value : [value]
          list.filter(Boolean).forEach(item => {
            const rawStr = String(item).trim()
            let matchedOption = rawStr
            const colonIndex = rawStr.indexOf(':')
            if (colonIndex > 0) {
              const prefix = rawStr.slice(0, colonIndex).trim()
              const detailContent = rawStr.slice(colonIndex + 1).trim()
              if (question.options && question.options.includes(prefix)) {
                matchedOption = prefix
              }
              if (detailContent) {
                otherSamples.push(`${matchedOption}: ${detailContent}`)
              }
            }
            counts[matchedOption] = Number(counts[matchedOption] || 0) + 1
            totalVotes++
          })
        })
        const labels = Object.keys(counts)
        const values = Object.values(counts)
        const rows = labels.map((label, idx) => ({
          label,
          value: values[idx],
          percentage: totalVotes > 0 ? Math.round(values[idx] / totalVotes * 100) : 0
        }))
        charts.push({
          type: question.type === 'single' ? 'pie' : 'bar',
          typeName: question.type === 'single' ? '单选统计' : '多选统计',
          title: question.title,
          questionId: question.id,
          totalVotes,
          labels,
          values,
          rows,
          otherSamples: otherSamples.slice(0, 30)
        })
      } else if (question.type === 'rating') {
        const max = Number(question.max || 5)
        const counts = Array.from({ length: max }, (_, index) => ({ label: `${index + 1}分`, value: 0 }))
        let total = 0
        let count = 0
        answers.forEach(answer => {
          const score = Math.round(Number(answer.value || 0))
          if (score >= 1 && score <= max) {
            counts[score - 1].value += 1
            total += score
            count += 1
          }
        })
        const labels = counts.map(item => item.label)
        const values = counts.map(item => item.value)
        const rows = counts.map(item => ({
          label: item.label,
          value: item.value,
          percentage: count > 0 ? Math.round(item.value / count * 100) : 0
        }))
        charts.push({
          type: 'rating',
          typeName: '评分统计',
          title: question.title,
          questionId: question.id,
          maxScore: max,
          count,
          average: count ? Number((total / count).toFixed(1)) : 0,
          labels,
          values,
          rows
        })
      } else {
        const values = answers.map(answer => text(answer.value, 120)).filter(Boolean).slice(0, 30)
        charts.push({
          type: 'text',
          typeName: '文本内容摘录',
          title: question.title,
          questionId: question.id,
          sampleCount: values.length,
          sampleAnswers: values,
          labels: values.slice(0, 10),
          values: values.slice(0, 10).map(() => 1)
        })
      }
    })

    const qualityCounts = { valid: 0, suspicious: 0, fake: 0 }
    responses.forEach(response => {
      const verdict = response.aiQuality && response.aiQuality.verdict ? response.aiQuality.verdict : 'valid'
      qualityCounts[verdict] = Number(qualityCounts[verdict] || 0) + 1
    })
    const totalResp = responses.length
    const validRate = totalResp > 0 ? Math.round(qualityCounts.valid / totalResp * 100) : 100
    charts.push({
      type: 'quality',
      typeName: '回答质量与防乱填',
      title: '作答质量分布',
      validRate,
      labels: ['有效回答', '疑似敷衍', '无效乱填'],
      values: [qualityCounts.valid, qualityCounts.suspicious, qualityCounts.fake],
      rows: [
        { label: '有效回答', value: qualityCounts.valid, percentage: totalResp ? Math.round(qualityCounts.valid / totalResp * 100) : 100 },
        { label: '疑似敷衍', value: qualityCounts.suspicious, percentage: totalResp ? Math.round(qualityCounts.suspicious / totalResp * 100) : 0 },
        { label: '无效乱填', value: qualityCounts.fake, percentage: totalResp ? Math.round(qualityCounts.fake / totalResp * 100) : 0 }
      ]
    })
    return charts
  }

  function buildFallbackReport(questionnaire, responses) {
    const charts = buildCharts(questionnaire, responses)
    const qualityChart = charts.find(item => item.type === 'quality')
    const total = responses.length
    const valid = qualityChart ? qualityChart.values[0] : total
    const validRate = total > 0 ? Math.round(valid / total * 100) : 100
    return {
      summary: `本次问卷「${questionnaire.title}」共回收 ${total} 份回答，有效率达 ${validRate}%。`,
      insights: [
        '已按单选、多选、评分及文本题目生成多维统计图表。',
        '系统内置智能质量检测，对疑似敷衍和无效乱填回答进行了自动标注与拦截。'
      ],
      strengths: ['用户积极参与，整体反馈意愿较高。'],
      painPoints: ['部分反馈提及具体服务细节仍有提升空间。'],
      suggestions: ['建议结合高频建议项优化服务流程与响应时效。'],
      qualityAnalysis: `共检测 ${total} 份作答，其中有效回答 ${valid} 份，异常或敷衍作答已隔离。`,
      charts,
      qualityStats: qualityChart ? { valid: qualityChart.values[0], suspicious: qualityChart.values[1], fake: qualityChart.values[2], validRate } : { valid: total, suspicious: 0, fake: 0, validRate: 100 }
    }
  }

  async function generateAiReport(questionnaire, responses) {
    const fallback = buildFallbackReport(questionnaire, responses)
    if (!responses || responses.length === 0) {
      return {
        ...fallback,
        summary: `问卷「${questionnaire.title}」暂未收到作答数据。`,
        insights: ['问卷处于草稿或刚发布阶段，待用户与宠托师作答回收后，将由腾讯混元 hy3 大模型自动生成深度全景分析与图表洞察。'],
        strengths: ['问卷设计与奖励机制已配置就绪。'],
        painPoints: ['暂无作答反馈。'],
        suggestions: ['可通过服务完成通知或系统消息向目标群体推送问卷，加速调研样本回收。'],
        qualityAnalysis: '目前作答样本为0，待提交后将实时启动智能防乱填与作答质量深度核查。',
        source: 'hy3',
        model: 'hy3',
        generatedAt: now()
      }
    }

    const compactResponses = responses.slice(0, 100).map((response) => ({
      role: response.role,
      quality: response.aiQuality ? (response.aiQuality.verdict || 'valid') : 'valid',
      answers: (response.answers || []).map(answer => ({ title: answer.title, value: answer.value }))
    }))

    const statsContext = {
      questionnaire: {
        title: questionnaire.title,
        description: questionnaire.description,
        targetRoles: questionnaire.targetRoles,
        totalResponses: responses.length,
        validResponses: fallback.qualityStats.valid,
        suspiciousResponses: fallback.qualityStats.suspicious,
        fakeResponses: fallback.qualityStats.fake,
        validRate: `${fallback.qualityStats.validRate}%`
      },
      questionSummaries: fallback.charts.filter(c => c.type !== 'quality').map(c => {
        if (c.type === 'rating') {
          return {
            title: c.title,
            type: '评分题',
            averageScore: `${c.average}/${c.maxScore || 5}`,
            voterCount: c.count
          }
        }
        if (c.type === 'text') {
          return {
            title: c.title,
            type: '开放问答题',
            sampleAnswers: (c.sampleAnswers || []).slice(0, 15)
          }
        }
        return {
          title: c.title,
          type: c.typeName || '选择题',
          distributions: (c.rows || []).map(r => `${r.label}: ${r.value}票(${r.percentage}%)`),
          otherInputs: c.otherSamples && c.otherSamples.length ? c.otherSamples.slice(0, 10) : undefined
        }
      }),
      sampleSubmissions: compactResponses.slice(0, 40)
    }

    const systemPrompt = [
      '你是 Dovelin 多芙琳宠物上门服务平台 的资深用户调研总监与数据分析专家。',
      '请依据提供的问卷调研真实统计数据与用户作答样本，使用腾讯混元 hy3 大模型进行深度全景分析与商业洞察提炼。',
      '输出必须为纯合法的 JSON 字符串（绝不能包含 markdown 代码块或其他非 JSON 文本），包含以下字段：',
      '- summary: 总体宏观分析总结，语言精炼专业，包含核心满意度评价、作答参与度及关键业务定性，120-250字。',
      '- insights: 字符串数组，4-8条核心提炼洞察，结合猫狗宠主需求、上门喂养/遛狗/护理体验深度提炼。',
      '- strengths: 字符串数组，2-4条用户/宠托师重点好评与平台满意亮点。',
      '- painPoints: 字符串数组，2-4条用户集中反馈的痛点、担忧或待改善问题。',
      '- suggestions: 字符串数组，2-4条切实可落地的运营策略、服务流程优化或激励改进建议。',
      '- qualityAnalysis: 字符串，结合作答真实度、乱填拦截率与样本分布作出的专业质检诊断与调研可信度评估，80-180字。'
    ].join('\n')

    const userPrompt = `调研数据如下，请基于腾讯混元 hy3 模型输出专业的分析 JSON：\n${JSON.stringify(statsContext)}`

    const aiRes = await runAiJson([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], fallback)

    const ai = aiRes.data || fallback
    const isAiSuccess = Boolean(aiRes.success)

    return {
      summary: text(ai.summary || fallback.summary, 2000),
      insights: Array.isArray(ai.insights) && ai.insights.length ? ai.insights.map(item => text(item, 300)).filter(Boolean).slice(0, 10) : fallback.insights,
      strengths: Array.isArray(ai.strengths) && ai.strengths.length ? ai.strengths.map(item => text(item, 200)).filter(Boolean).slice(0, 5) : fallback.strengths,
      painPoints: Array.isArray(ai.painPoints) && ai.painPoints.length ? ai.painPoints.map(item => text(item, 200)).filter(Boolean).slice(0, 5) : fallback.painPoints,
      suggestions: Array.isArray(ai.suggestions) && ai.suggestions.length ? ai.suggestions.map(item => text(item, 200)).filter(Boolean).slice(0, 5) : fallback.suggestions,
      qualityAnalysis: text(ai.qualityAnalysis || fallback.qualityAnalysis, 500),
      charts: fallback.charts,
      qualityStats: fallback.qualityStats,
      source: isAiSuccess ? 'hy3' : 'fallback',
      model: isAiSuccess ? 'hy3' : null,
      generatedAt: now()
    }
  }

  async function notifyPublish(questionnaireDoc, admin) {
    if (!questionnaireDoc || questionnaireDoc.notificationSent) return
    const id = questionnaireDoc._id
    const targetRoles = Array.isArray(questionnaireDoc.targetRoles) ? questionnaireDoc.targetRoles : ['client']
    const target = targetRoles.includes('client') && targetRoles.includes('staff')
      ? 'all'
      : (targetRoles.includes('staff') ? 'staff' : 'client')
    const reward = questionnaireDoc.rewardConfig || {}
    let rewardTip = ''
    if (reward.enabled) {
      const parts = []
      if (reward.points > 0) parts.push(`+${reward.points}积分`)
      if (reward.couponSnapshot && reward.couponSnapshot.name) parts.push(reward.couponSnapshot.name)
      else if (reward.couponTemplateId) parts.push('专属优惠券')
      rewardTip = parts.length ? `（参与领${parts.join('、')}）` : ''
    }
    const targetUrl = target === 'staff'
      ? `/pages/staff/questionnaires/detail/index?id=${id}`
      : `/pages/client/questionnaires/detail/index?id=${id}`
    if (typeof sendSystemNotification === 'function') {
      try {
        const noticeRes = await sendSystemNotification({
          title: `【调研邀请】${text(questionnaireDoc.title, 40)}`,
          content: `${text(questionnaireDoc.description || '诚邀您参与本次体验调研', 200)}。${rewardTip}请点击本通知或前往问卷中心作答～`,
          target,
          type: 'activity',
          level: 'normal',
          targetUrl
        }, admin)
        const notificationId = (noticeRes && (noticeRes._id || (noticeRes.data && noticeRes.data._id))) || ''
        await db.collection('questionnaires').doc(id).update({
          data: {
            notificationSent: true,
            notificationId
          }
        }).catch(() => {})
      } catch (err) {
        console.error('[questionnaire] notify publish error', err)
      }
    }
  }

  async function revokeQuestionnaireNotification(questionnaireId, questionnaireDoc, admin) {
    if (!questionnaireId) return
    const id = String(questionnaireId)
    const notificationId = questionnaireDoc && questionnaireDoc.notificationId
    const time = now()
    if (notificationId) {
      await db.collection('system_notifications').doc(notificationId).update({
        data: { status: 'revoked', revokedAt: time, updatedAt: time }
      }).catch(() => {})
    }
    try {
      const activeNotices = await readScopedDocuments('system_notifications', { status: 'active' }).catch(() => [])
      for (const notice of activeNotices) {
        if (notice.targetUrl && (notice.targetUrl.includes(`id=${id}`) || notice.targetUrl.includes(id))) {
          await db.collection('system_notifications').doc(notice._id).update({
            data: { status: 'revoked', revokedAt: time, updatedAt: time }
          }).catch(() => {})
        }
      }
    } catch (err) {
      console.error('[questionnaire] revoke notices error', err)
    }
  }

  async function listAvailableForUser(user, data = {}) {
    const role = getUserRole(user, data.role)
    const rows = await readScopedDocuments('questionnaires', { status: 'published' }, 'publishedAt', 'desc')
    const responseRows = await readScopedDocuments('questionnaire_responses', { openid: user.openid }, 'createdAt', 'desc')
    const responseMap = new Map(responseRows.map(item => [item.questionnaireId, item]))
    return rows
      .filter(item => Array.isArray(item.targetRoles) && item.targetRoles.includes(role))
      .map(item => {
        const resp = responseMap.get(item._id)
        return {
          ...formatQuestionnaire(item),
          answered: !!resp,
          myResponseId: resp ? resp._id : null,
          answeredAt: resp ? resp.createdAt : null
        }
      })
  }

  return async function questionnaire(openid, action, data = {}) {
    if (['create', 'update', 'publish', 'close', 'delete', 'clone', 'listAdmin', 'detailAdmin', 'responses', 'analyzeAI', 'getAiReport', 'retryReward', 'retryAllRewards'].includes(action)) {
      const admin = await requireAdmin(openid)
      if (action === 'create') {
        const payload = normalizeQuestionnairePayload(data)
        const time = now()
        const publishImmediately = data.publishImmediately === true || data.status === 'published'
        if (publishImmediately) await context.authorizeAdmin(admin, 'questionnaire.publish')
        const initialStatus = publishImmediately ? 'published' : 'draft'
        const res = await db.collection('questionnaires').add({
          data: {
            ...payload,
            status: initialStatus,
            responseCount: 0,
            validResponseCount: 0,
            createdBy: admin._id,
            createdByOpenid: openid,
            createdAt: time,
            updatedAt: time,
            publishedAt: publishImmediately ? time : null,
            closedAt: null,
            notificationSent: false
          }
        })
        const createdDoc = { _id: res._id, ...payload, status: initialStatus }
        if (publishImmediately) {
          await notifyPublish(createdDoc, admin)
        }
        return createdDoc
      }
      if (action === 'update') {
        const id = text(data.id || data.questionnaireId, 80)
        const current = await getQuestionnaire(id)
        if (current.status === 'closed') throw new Error('已关闭问卷不可编辑')
        const payload = normalizeQuestionnairePayload(data)
        const time = now()
        const publishImmediately = data.publishImmediately === true || data.status === 'published'
        if (publishImmediately) await context.authorizeAdmin(admin, 'questionnaire.publish')
        const nextStatus = publishImmediately ? 'published' : current.status
        const publishedAt = publishImmediately ? (current.publishedAt || time) : current.publishedAt
        await db.collection('questionnaires').doc(id).update({
          data: {
            ...payload,
            status: nextStatus,
            publishedAt,
            updatedAt: time
          }
        })
        const updatedDoc = { ...current, ...payload, status: nextStatus, updatedAt: time }
        if (publishImmediately && current.status !== 'published') {
          await notifyPublish({ _id: id, ...updatedDoc }, admin)
        }
        return formatQuestionnaire(updatedDoc, { includeQuestions: true })
      }
      if (action === 'publish') {
        const id = text(data.id || data.questionnaireId, 80)
        const current = await getQuestionnaire(id)
        const time = now()
        await db.collection('questionnaires').doc(id).update({ data: { status: 'published', publishedAt: current.publishedAt || time, closedAt: null, updatedAt: time } })
        await notifyPublish({ _id: id, ...current }, admin)
        return { success: true }
      }
      if (action === 'close') {
        const id = text(data.id || data.questionnaireId, 80)
        const current = await getQuestionnaire(id)
        const time = now()
        await db.collection('questionnaires').doc(id).update({ data: { status: 'closed', closedAt: time, updatedAt: time } })
        await revokeQuestionnaireNotification(id, current, admin)
        return { success: true }
      }
      if (action === 'delete') {
        const id = text(data.id || data.questionnaireId, 80)
        const current = await getQuestionnaire(id)
        if (current.status !== 'draft' && Number(current.responseCount || 0) > 0) {
          throw new Error('已有提交数据的问卷不可删除，请关闭问卷')
        }
        await revokeQuestionnaireNotification(id, current, admin)
        await db.collection('questionnaires').doc(id).remove()
        return { success: true }
      }
      if (action === 'clone') {
        const id = text(data.id || data.questionnaireId, 80)
        const current = await getQuestionnaire(id)
        const time = now()
        const newPayload = {
          title: `${current.title || '问卷'} (副本)`,
          description: current.description || '',
          targetRoles: current.targetRoles || ['client'],
          rewardConfig: current.rewardConfig || { enabled: false, points: 0, couponTemplateId: '' },
          questions: current.questions || []
        }
        const res = await db.collection('questionnaires').add({
          data: {
            ...newPayload,
            status: 'draft',
            responseCount: 0,
            validResponseCount: 0,
            createdBy: admin._id,
            createdByOpenid: openid,
            createdAt: time,
            updatedAt: time,
            publishedAt: null,
            closedAt: null
          }
        })
        return { _id: res._id, ...newPayload, status: 'draft' }
      }
      if (action === 'listAdmin') {
        return await readScopedDocuments('questionnaires', {}, 'createdAt', 'desc').then(rows => rows.map(item => formatQuestionnaire(item)))
      }
      if (action === 'detailAdmin') {
        return formatQuestionnaire(await getQuestionnaire(data.id || data.questionnaireId), { includeQuestions: true })
      }
      if (action === 'responses') {
        const questionnaireId = text(data.id || data.questionnaireId, 80)
        const rows = await readScopedDocuments('questionnaire_responses', { questionnaireId }, 'createdAt', 'desc')
        return rows.map(formatResponse)
      }
      if (action === 'analyzeAI') {
        const questionnaire = await getQuestionnaire(data.id || data.questionnaireId)
        const responses = await readScopedDocuments('questionnaire_responses', { questionnaireId: questionnaire._id }, 'createdAt', 'asc')
        const report = await generateAiReport(questionnaire, responses)
        const time = now()
        const record = { questionnaireId: questionnaire._id, title: questionnaire.title, ...report, createdAt: time, updatedAt: time }
        const existing = (await db.collection('questionnaire_ai_reports').where({ questionnaireId: questionnaire._id }).limit(1).get()).data[0]
        if (existing) {
          await db.collection('questionnaire_ai_reports').doc(existing._id).update({ data: { ...report, updatedAt: time } })
          return { _id: existing._id, ...record }
        }
        const res = await db.collection('questionnaire_ai_reports').add({ data: record })
        return { _id: res._id, ...record }
      }
      if (action === 'getAiReport') {
        const questionnaireId = text(data.id || data.questionnaireId, 80)
        const report = (await db.collection('questionnaire_ai_reports').where({ questionnaireId }).limit(1).get()).data[0]
        return report || null
      }
      if (action === 'retryReward') {
        const responseId = text(data.responseId, 80)
        const responseRes = await db.collection('questionnaire_responses').doc(responseId).get().catch(() => ({ data: null }))
        const response = responseRes && responseRes.data
        if (!response) throw new Error('提交记录不存在')
        const questionnaire = await getQuestionnaire(response.questionnaireId)
        const userRes = await db.collection('users').doc(response.userId).get().catch(() => ({ data: null }))
        const user = userRes && userRes.data
        if (!user) throw new Error('用户不存在')
        const mailIds = await createRewardMails(questionnaire, { ...response, _id: responseId }, { ...user, openid: response.openid }, { force: true })
        await db.collection('questionnaire_responses').doc(responseId).update({ data: { rewardStatus: mailIds.length ? 'sent' : 'skipped', rewardMailIds: mailIds, updatedAt: now() } })
        return { rewardMailIds: mailIds }
      }
      if (action === 'retryAllRewards') {
        const questionnaireId = text(data.id || data.questionnaireId, 80)
        const questionnaire = await getQuestionnaire(questionnaireId)
        const rows = await readScopedDocuments('questionnaire_responses', { questionnaireId }, 'createdAt', 'desc')
        const toRetry = rows.filter(r => ['pending', 'failed'].includes(r.rewardStatus) && (!r.aiQuality || r.aiQuality.verdict !== 'fake'))
        let retriedCount = 0
        for (const item of toRetry) {
          try {
            const userRes = await db.collection('users').doc(item.userId).get().catch(() => ({ data: null }))
            const u = userRes && userRes.data
            if (u) {
              const mailIds = await createRewardMails(questionnaire, item, { ...u, openid: item.openid })
              await db.collection('questionnaire_responses').doc(item._id).update({
                data: { rewardStatus: mailIds.length ? 'sent' : 'skipped', rewardMailIds: mailIds, updatedAt: now() }
              })
              retriedCount++
            }
          } catch (_) {}
        }
        return { total: toRetry.length, retriedCount }
      }
    }

    const user = await getUser(openid)
    if (action === 'listAvailable') return listAvailableForUser(user, data)
    if (action === 'detail') {
      const item = await getQuestionnaire(data.id || data.questionnaireId)
      const role = getUserRole(user, data.role)
      if (item.status !== 'published' || !Array.isArray(item.targetRoles) || !item.targetRoles.includes(role)) {
        throw new Error(item.status === 'closed' ? '该问卷已结束征集，感谢关注！' : '问卷不存在或不可填写')
      }
      const existing = (await db.collection('questionnaire_responses').where({ questionnaireId: item._id, openid }).limit(1).get()).data[0]
      return { ...formatQuestionnaire(item, { includeQuestions: true }), answered: !!existing }
    }
    if (action === 'submit') return submitQuestionnaire(user, data)
    if (action === 'myResponses') {
      const rows = await readScopedDocuments('questionnaire_responses', { openid }, 'createdAt', 'desc')
      return rows.map(formatResponse)
    }

    throw new Error('未知 questionnaire 操作')
  }
}
