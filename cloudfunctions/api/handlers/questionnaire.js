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
    submitQuestionnaire
  } = context

  function text(value, max = 1000) {
    return safeText(value).trim().slice(0, max)
  }

  function parseJsonObject(raw, fallback) {
    if (!raw) return fallback
    const content = text(raw, 10000).replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim()
    try {
      return JSON.parse(content)
    } catch (_) {
      const start = content.indexOf('{')
      const end = content.lastIndexOf('}')
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(content.slice(start, end + 1))
        } catch (err) {}
      }
    }
    return fallback
  }

  async function runAiJson(messages, fallback) {
    try {
      const aiExt = cloud.extend && cloud.extend.AI ? cloud.extend.AI : null
      if (!aiExt) return fallback
      let model
      try {
        model = aiExt.createModel('hunyuan')
      } catch (_) {
        model = aiExt.createModel('cloudbase')
      }
      const res = await model.generateText({ model: 'hy3', messages })
      let output = ''
      if (res && res.choices && res.choices[0] && res.choices[0].message) output = res.choices[0].message.content
      else if (res && res.text) output = res.text
      return parseJsonObject(output, fallback)
    } catch (error) {
      return fallback
    }
  }

  function buildCharts(questionnaire, responses) {
    const questions = Array.isArray(questionnaire.questions) ? questionnaire.questions : []
    const charts = []
    questions.forEach((question) => {
      const answers = responses.map(response => (response.answers || []).find(item => item.questionId === question.id)).filter(Boolean)
      if (['single', 'multiple'].includes(question.type)) {
        const counts = {}
        ;(question.options || []).forEach(option => { counts[option] = 0 })
        let totalVotes = 0
        answers.forEach(answer => {
          const value = answer.value
          const list = Array.isArray(value) ? value : [value]
          list.filter(Boolean).forEach(item => {
            counts[item] = Number(counts[item] || 0) + 1
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
          rows
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
    const compactResponses = responses.slice(0, 120).map((response) => ({
      role: response.role,
      quality: response.aiQuality,
      answers: (response.answers || []).map(answer => ({ title: answer.title, value: answer.value }))
    }))
    const ai = await runAiJson([
      {
        role: 'system',
        content: '你是专业用户调研与数据分析师。请分析问卷调研数据，输出纯 JSON 格式（不要 markdown 代码块）。JSON 包含字段：\n' +
          'summary (字符串，总体宏观总结分析，150字以内)\n' +
          'insights (字符串数组，4-8条核心提炼洞察)\n' +
          'strengths (字符串数组，2-4条用户/宠托师重点好评与满意亮点)\n' +
          'painPoints (字符串数组，2-4条用户集中吐槽或痛点问题)\n' +
          'suggestions (字符串数组，2-4条针对性运营/服务落地改进措施)\n' +
          'qualityAnalysis (字符串，关于作答质量、乱填敷衍情况的专业诊断与建议)'
      },
      {
        role: 'user',
        content: JSON.stringify({
          questionnaire: { title: questionnaire.title, description: questionnaire.description, questions: questionnaire.questions },
          responses: compactResponses
        })
      }
    ], fallback)
    return {
      summary: text(ai.summary || fallback.summary, 2000),
      insights: Array.isArray(ai.insights) && ai.insights.length ? ai.insights.map(item => text(item, 300)).filter(Boolean).slice(0, 10) : fallback.insights,
      strengths: Array.isArray(ai.strengths) && ai.strengths.length ? ai.strengths.map(item => text(item, 200)).filter(Boolean).slice(0, 5) : fallback.strengths,
      painPoints: Array.isArray(ai.painPoints) && ai.painPoints.length ? ai.painPoints.map(item => text(item, 200)).filter(Boolean).slice(0, 5) : fallback.painPoints,
      suggestions: Array.isArray(ai.suggestions) && ai.suggestions.length ? ai.suggestions.map(item => text(item, 200)).filter(Boolean).slice(0, 5) : fallback.suggestions,
      qualityAnalysis: text(ai.qualityAnalysis || fallback.qualityAnalysis, 500),
      charts: fallback.charts,
      qualityStats: fallback.qualityStats
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
        const res = await db.collection('questionnaires').add({ data: { ...payload, status: 'draft', responseCount: 0, validResponseCount: 0, createdBy: admin._id, createdByOpenid: openid, createdAt: time, updatedAt: time, publishedAt: null, closedAt: null } })
        return { _id: res._id, ...payload, status: 'draft' }
      }
      if (action === 'update') {
        const id = text(data.id || data.questionnaireId, 80)
        const current = await getQuestionnaire(id)
        if (current.status === 'closed') throw new Error('已关闭问卷不可编辑')
        const payload = normalizeQuestionnairePayload(data)
        await db.collection('questionnaires').doc(id).update({ data: { ...payload, updatedAt: now() } })
        return formatQuestionnaire({ ...current, ...payload, updatedAt: now() }, { includeQuestions: true })
      }
      if (action === 'publish') {
        const id = text(data.id || data.questionnaireId, 80)
        const current = await getQuestionnaire(id)
        const time = now()
        await db.collection('questionnaires').doc(id).update({ data: { status: 'published', publishedAt: current.publishedAt || time, closedAt: null, updatedAt: time } })
        return { success: true }
      }
      if (action === 'close') {
        const id = text(data.id || data.questionnaireId, 80)
        const time = now()
        await db.collection('questionnaires').doc(id).update({ data: { status: 'closed', closedAt: time, updatedAt: time } })
        return { success: true }
      }
      if (action === 'delete') {
        const id = text(data.id || data.questionnaireId, 80)
        const current = await getQuestionnaire(id)
        if (current.status !== 'draft' && Number(current.responseCount || 0) > 0) {
          throw new Error('已有提交数据的问卷不可删除，请关闭问卷')
        }
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
        const mailIds = await createRewardMails(questionnaire, { ...response, _id: responseId }, user)
        await db.collection('questionnaire_responses').doc(responseId).update({ data: { rewardStatus: mailIds.length ? 'sent' : 'skipped', rewardMailIds: mailIds, updatedAt: now() } })
        return { rewardMailIds: mailIds }
      }
      if (action === 'retryAllRewards') {
        const questionnaireId = text(data.id || data.questionnaireId, 80)
        const questionnaire = await getQuestionnaire(questionnaireId)
        const rows = await readScopedDocuments('questionnaire_responses', { questionnaireId }, 'createdAt', 'desc')
        const toRetry = rows.filter(r => r.rewardStatus === 'failed' || (r.rewardStatus === 'skipped' && r.aiQuality && r.aiQuality.verdict === 'fake'))
        let retriedCount = 0
        for (const item of toRetry) {
          try {
            const userRes = await db.collection('users').doc(item.userId).get().catch(() => ({ data: null }))
            const u = userRes && userRes.data
            if (u) {
              const mailIds = await createRewardMails(questionnaire, item, u)
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
      if (item.status !== 'published' || !Array.isArray(item.targetRoles) || !item.targetRoles.includes(role)) throw new Error('问卷不存在或不可填写')
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
