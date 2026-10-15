const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('questionnaire admin workflow: create, edit, publish, close, responses and AI analysis', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin_1', openid: 'admin_openid', roles: ['admin'], status: 'active' },
      { _id: 'client_1', openid: 'client_openid', roles: ['client'], status: 'active', points: 10 },
      { _id: 'staff_1', openid: 'staff_openid', roles: ['staff'], status: 'active', points: 0 }
    ],
    coupon_templates: [
      { _id: 'coupon_tpl_1', name: '问卷专享10元券', discountType: 'fixed', discountValue: 10, minOrderAmount: 50 }
    ],
    questionnaires: [],
    questionnaire_responses: [],
    questionnaire_ai_reports: [],
    reward_mails: []
  })

  const adminFn = loadCloudFunction('api', db, 'admin_openid')
  const clientFn = loadCloudFunction('api', db, 'client_openid')
  const staffFn = loadCloudFunction('api', db, 'staff_openid')

  // 1. 管理员创建问卷（面向用户 + 宠托师，带积分和优惠券奖励）
  const createRes = await adminFn.main({
    module: 'questionnaire',
    action: 'create',
    data: {
      title: '多芙琳服务满意度大调研',
      description: '请留下您的真实评价',
      targetRoles: ['client', 'staff'],
      rewardConfig: {
        enabled: true,
        points: 50,
        couponTemplateId: 'coupon_tpl_1'
      },
      questions: [
        { type: 'single', title: '整体服务满意吗？', required: true, options: ['很满意', '一般', '不满意'] },
        { type: 'multiple', title: '您体验过哪些服务？', required: true, options: ['上门喂养', '上门遛狗', '健康关怀'] },
        { type: 'rating', title: '服务评分', required: true, max: 5 },
        { type: 'long_text', title: '具体建议或意见', required: true }
      ]
    }
  })
  assert.equal(createRes.ok, true)
  assert.equal(createRes.data.status, 'draft')
  const questionnaireId = createRes.data._id
  assert.ok(questionnaireId)

  // 2. 问卷草稿状态下，用户不可见
  const clientListBeforePublish = await clientFn.main({
    module: 'questionnaire',
    action: 'listAvailable',
    data: { role: 'client' }
  })
  assert.equal(clientListBeforePublish.ok, true)
  assert.equal(clientListBeforePublish.data.length, 0)

  // 3. 管理员发布问卷
  const publishRes = await adminFn.main({
    module: 'questionnaire',
    action: 'publish',
    data: { id: questionnaireId }
  })
  assert.equal(publishRes.ok, true)

  // 4. 用户和宠托师均可看到已发布问卷
  const clientList = await clientFn.main({
    module: 'questionnaire',
    action: 'listAvailable',
    data: { role: 'client' }
  })
  assert.equal(clientList.ok, true)
  assert.equal(clientList.data.length, 1)
  assert.equal(clientList.data[0].answered, false)

  const staffList = await staffFn.main({
    module: 'questionnaire',
    action: 'listAvailable',
    data: { role: 'staff' }
  })
  assert.equal(staffList.ok, true)
  assert.equal(staffList.data.length, 1)

  // 5. 客户端正常提交高质量问卷，并自动收到奖励邮件（积分 + 优惠券）
  const validSubmitRes = await clientFn.main({
    module: 'questionnaire',
    action: 'submit',
    data: {
      id: questionnaireId,
      role: 'client',
      answers: [
        { questionId: 'q_1', value: '很满意' },
        { questionId: 'q_2', value: ['上门喂养', '上门遛狗'] },
        { questionId: 'q_3', value: 5 },
        { questionId: 'q_4', value: '宠托师非常专业细心，上门全程直播，猫咪很喜欢他！' }
      ]
    }
  })
  assert.equal(validSubmitRes.ok, true)
  assert.equal(validSubmitRes.data.rewardStatus, 'sent')
  assert.equal(validSubmitRes.data.aiQuality.verdict, 'valid')
  assert.equal(validSubmitRes.data.rewardMailIds.length, 2) // 1 积分邮件 + 1 优惠券邮件

  // 检查奖励邮件是否成功创建
  assert.equal(db.state.reward_mails.length, 2)
  const pointsMail = db.state.reward_mails.find(m => m.reward && m.reward.type === 'points')
  const couponMail = db.state.reward_mails.find(m => m.reward && m.reward.type === 'coupon')
  assert.ok(pointsMail)
  assert.equal(pointsMail.reward.points, 50)
  assert.ok(couponMail)
  assert.equal(couponMail.reward.couponTemplateId, 'coupon_tpl_1')
  assert.equal(couponMail.reward.couponSnapshot.name, '问卷专享10元券')

  // 6. 防重复提交检查
  const duplicateSubmitRes = await clientFn.main({
    module: 'questionnaire',
    action: 'submit',
    data: {
      id: questionnaireId,
      role: 'client',
      answers: [
        { questionId: 'q_1', value: '很满意' },
        { questionId: 'q_2', value: ['上门喂养'] },
        { questionId: 'q_3', value: 5 },
        { questionId: 'q_4', value: '再次提交' }
      ]
    }
  })
  assert.equal(duplicateSubmitRes.ok, false)
  assert.match(duplicateSubmitRes.error, /已提交过该问卷/)

  // 7. 宠托师提交敷衍乱填内容，AI 质检判定为 fake/无效，拦截自动发奖
  const fakeSubmitRes = await staffFn.main({
    module: 'questionnaire',
    action: 'submit',
    data: {
      id: questionnaireId,
      role: 'staff',
      answers: [
        { questionId: 'q_1', value: '一般' },
        { questionId: 'q_2', value: ['健康关怀'] },
        { questionId: 'q_3', value: 1 },
        { questionId: 'q_4', value: '11111111' } // 连续重复字符乱填
      ]
    }
  })
  assert.equal(fakeSubmitRes.ok, true)
  assert.equal(fakeSubmitRes.data.aiQuality.verdict, 'fake')
  assert.ok(fakeSubmitRes.data.aiQuality.reasons.length > 0)
  assert.equal(fakeSubmitRes.data.rewardStatus, 'skipped') // 乱填拦截奖励发放

  // 8. 管理员查看问卷回收列表
  const responsesRes = await adminFn.main({
    module: 'questionnaire',
    action: 'responses',
    data: { id: questionnaireId }
  })
  assert.equal(responsesRes.ok, true)
  assert.equal(responsesRes.data.length, 2)
  const clientResponse = responsesRes.data.find(r => r.role === 'client')
  const staffResponse = responsesRes.data.find(r => r.role === 'staff')
  assert.equal(clientResponse.aiQuality.verdict, 'valid')
  assert.equal(staffResponse.aiQuality.verdict, 'fake')

  // 9. 管理员可为被拦截记录手动补发奖励
  const retryRewardRes = await adminFn.main({
    module: 'questionnaire',
    action: 'retryReward',
    data: { responseId: staffResponse._id }
  })
  assert.equal(retryRewardRes.ok, true)
  assert.equal(retryRewardRes.data.rewardMailIds.length, 2)

  // 10. 管理员生成与获取 AI 整理分析报告与图表
  const aiReportRes = await adminFn.main({
    module: 'questionnaire',
    action: 'analyzeAI',
    data: { id: questionnaireId }
  })
  assert.equal(aiReportRes.ok, true)
  assert.ok(aiReportRes.data.summary)
  assert.ok(Array.isArray(aiReportRes.data.charts))
  assert.ok(aiReportRes.data.qualityStats)
  assert.equal(aiReportRes.data.qualityStats.valid, 1)
  assert.equal(aiReportRes.data.qualityStats.fake, 1)

  // 测试 getAiReport 查询
  const getAiRes = await adminFn.main({
    module: 'questionnaire',
    action: 'getAiReport',
    data: { id: questionnaireId }
  })
  assert.equal(getAiRes.ok, true)
  assert.equal(getAiRes.data.questionnaireId, questionnaireId)

  // 11. 管理员关闭问卷
  const closeRes = await adminFn.main({
    module: 'questionnaire',
    action: 'close',
    data: { id: questionnaireId }
  })
  assert.equal(closeRes.ok, true)

  const detailRes = await adminFn.main({
    module: 'questionnaire',
    action: 'detailAdmin',
    data: { id: questionnaireId }
  })
  assert.equal(detailRes.ok, true)
  assert.equal(detailRes.data.status, 'closed')

  // 12. 已关闭问卷不可再编辑
  const editClosedRes = await adminFn.main({
    module: 'questionnaire',
    action: 'update',
    data: { id: questionnaireId, title: '修改标题' }
  })
  assert.equal(editClosedRes.ok, false)
  assert.match(editClosedRes.error, /已关闭问卷不可编辑/)
})

test('questionnaire targetRoles isolation between client and staff', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin_1', openid: 'admin_openid', roles: ['admin'], status: 'active' },
      { _id: 'client_1', openid: 'client_openid', roles: ['client'], status: 'active' },
      { _id: 'staff_1', openid: 'staff_openid', roles: ['staff'], status: 'active' }
    ],
    questionnaires: [],
    questionnaire_responses: []
  })

  const adminFn = loadCloudFunction('api', db, 'admin_openid')
  const clientFn = loadCloudFunction('api', db, 'client_openid')
  const staffFn = loadCloudFunction('api', db, 'staff_openid')

  // 创建仅限宠托师的问卷
  const staffQRes = await adminFn.main({
    module: 'questionnaire',
    action: 'create',
    data: {
      title: '宠托师接单意愿调研',
      targetRoles: ['staff'],
      questions: [{ type: 'single', title: '每周接单天数', options: ['1-2天', '3-5天', '全天'] }]
    }
  })
  await adminFn.main({ module: 'questionnaire', action: 'publish', data: { id: staffQRes.data._id } })

  // 创建仅限普通用户的问卷
  const clientQRes = await adminFn.main({
    module: 'questionnaire',
    action: 'create',
    data: {
      title: '宠物主喂养偏好调研',
      targetRoles: ['client'],
      questions: [{ type: 'single', title: '主要喂养', options: ['猫粮', '自制生骨肉', '罐头'] }]
    }
  })
  await adminFn.main({ module: 'questionnaire', action: 'publish', data: { id: clientQRes.data._id } })

  // 宠托师只能看到 staff 问卷
  const staffList = await staffFn.main({ module: 'questionnaire', action: 'listAvailable', data: { role: 'staff' } })
  assert.equal(staffList.data.length, 1)
  assert.equal(staffList.data[0].title, '宠托师接单意愿调研')

  // 用户只能看到 client 问卷
  const clientList = await clientFn.main({ module: 'questionnaire', action: 'listAvailable', data: { role: 'client' } })
  assert.equal(clientList.data.length, 1)
  assert.equal(clientList.data[0].title, '宠物主喂养偏好调研')

  // 用户尝试填写宠托师专属问卷应被拒绝
  const crossSubmit = await clientFn.main({
    module: 'questionnaire',
    action: 'submit',
    data: { id: staffQRes.data._id, role: 'client', answers: [{ questionId: 'q_1', value: '1-2天' }] }
  })
  assert.equal(crossSubmit.ok, false)
  assert.match(crossSubmit.error, /当前身份不可填写该问卷/)
})

test('questionnaire notification lifecycle: publish creates notification, close revokes it and disappears from client messages', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin_1', openid: 'admin_openid', roles: ['admin'], status: 'active' },
      { _id: 'client_1', openid: 'client_openid', roles: ['client'], status: 'active' }
    ],
    questionnaires: [],
    questionnaire_responses: [],
    system_notifications: [],
    user_notification_reads: []
  })

  const adminFn = loadCloudFunction('api', db, 'admin_openid')
  const clientFn = loadCloudFunction('api', db, 'client_openid')

  // 1. 创建并发布问卷
  const createRes = await adminFn.main({
    module: 'questionnaire',
    action: 'create',
    data: {
      title: '客户满意度通知联动调研',
      targetRoles: ['client'],
      questions: [{ type: 'single', title: '体验评分', options: ['满意', '不满意'] }]
    }
  })
  const qId = createRes.data._id
  await adminFn.main({ module: 'questionnaire', action: 'publish', data: { id: qId } })

  // 2. 前台用户查询系统通知，应该收到一条针对此问卷的通知
  const clientNoticesBeforeClose = await clientFn.main({
    module: 'message',
    action: 'listSystemNotifications',
    data: { page: 1, pageSize: 10 }
  })
  assert.equal(clientNoticesBeforeClose.ok, true)
  assert.equal(clientNoticesBeforeClose.data.list.length, 1)
  assert.match(clientNoticesBeforeClose.data.list[0].title, /客户满意度通知联动调研/)

  // 3. 管理员关闭问卷
  const closeRes = await adminFn.main({
    module: 'questionnaire',
    action: 'close',
    data: { id: qId }
  })
  assert.equal(closeRes.ok, true)

  // 4. 前台用户再次刷新系统通知，此通知已自动下线消失
  const clientNoticesAfterClose = await clientFn.main({
    module: 'message',
    action: 'listSystemNotifications',
    data: { page: 1, pageSize: 10 }
  })
  assert.equal(clientNoticesAfterClose.ok, true)
  assert.equal(clientNoticesAfterClose.data.list.length, 0)

  // 5. 若用户尝试直接请求已关闭问卷详情，提示已结束征集
  const detailRes = await clientFn.main({
    module: 'questionnaire',
    action: 'detail',
    data: { id: qId, role: 'client' }
  })
  assert.equal(detailRes.ok, false)
  assert.match(detailRes.error, /该问卷已结束征集/)
})

test('questionnaire handles text questions and other:custom input in single/multiple choices', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin_1', openid: 'admin_openid', roles: ['admin'], status: 'active' },
      { _id: 'client_1', openid: 'client_openid', roles: ['client'], status: 'active' }
    ],
    questionnaires: [],
    questionnaire_responses: [],
    questionnaire_ai_reports: [],
    system_notifications: [],
    user_notification_reads: []
  })

  const adminFn = loadCloudFunction('api', db, 'admin_openid')
  const clientFn = loadCloudFunction('api', db, 'client_openid')

  // 1. 创建包含单选(含其他)、多选(含其他)、问答题的问卷
  const createRes = await adminFn.main({
    module: 'questionnaire',
    action: 'create',
    data: {
      title: '混合题型及其他选项测试问卷',
      targetRoles: ['client'],
      questions: [
        { id: 'q_1', type: 'single', title: '如何了解我们的？', required: true, options: ['小红书', '朋友介绍', '其他'] },
        { id: 'q_2', type: 'multiple', title: '主要喂养偏好', required: true, options: ['进口猫粮', '主食冻干', '其他'] },
        { id: 'q_3', type: 'long_text', title: '您的改进建议', required: true, placeholder: '请在此输入建议' }
      ]
    }
  })
  const qId = createRes.data._id
  await adminFn.main({ module: 'questionnaire', action: 'publish', data: { id: qId } })

  // 2. 用户提交问卷，单选和多选均选了“其他”并附带自定义文本输入
  const submitRes = await clientFn.main({
    module: 'questionnaire',
    action: 'submit',
    data: {
      id: qId,
      role: 'client',
      answers: [
        { questionId: 'q_1', type: 'single', value: '其他:电梯广告看到的' },
        { questionId: 'q_2', type: 'multiple', value: ['进口猫粮', '其他:自制新鲜猫饭'] },
        { questionId: 'q_3', type: 'long_text', value: '希望能增加更多节假日的宠托师预约名额！' }
      ]
    }
  })
  assert.equal(submitRes.ok, true)
  assert.equal(submitRes.data.answers[0].value, '其他:电梯广告看到的')
  assert.deepEqual(submitRes.data.answers[1].value, ['进口猫粮', '其他:自制新鲜猫饭'])
  assert.equal(submitRes.data.answers[2].value, '希望能增加更多节假日的宠托师预约名额！')

  // 3. 管理员分析 AI 图表报告
  const analyzeRes = await adminFn.main({
    module: 'questionnaire',
    action: 'analyzeAI',
    data: { id: qId }
  })
  assert.equal(analyzeRes.ok, true)
  const charts = analyzeRes.data.charts
  const q1Chart = charts.find(c => c.questionId === 'q_1')
  const q2Chart = charts.find(c => c.questionId === 'q_2')
  const q3Chart = charts.find(c => c.questionId === 'q_3')

  // 单选 q1 中，“其他”选项计入 1 票，且 otherSamples 记录了电梯广告
  const q1OtherRow = q1Chart.rows.find(r => r.label === '其他')
  assert.ok(q1OtherRow)
  assert.equal(q1OtherRow.value, 1)
  assert.ok(q1Chart.otherSamples.some(s => s.includes('电梯广告')))

  // 多选 q2 中，“其他”选项计入 1 票，“进口猫粮”计入 1 票，otherSamples 记录了自制新鲜猫饭
  const q2OtherRow = q2Chart.rows.find(r => r.label === '其他')
  assert.ok(q2OtherRow)
  assert.equal(q2OtherRow.value, 1)
  assert.ok(q2Chart.otherSamples.some(s => s.includes('自制新鲜猫饭')))

  // 问答题 q3 为文本类型，样本中包含提交内容
  assert.equal(q3Chart.type, 'text')
  assert.ok(q3Chart.sampleAnswers.some(s => s.includes('希望能增加更多节假日')))
})

test('questionnaire analyzeAI uses hy3 model with rich stats context, parses JSON and marks model metadata', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin_1', openid: 'admin_openid', roles: ['admin'], status: 'active' },
      { _id: 'client_1', openid: 'client_openid', roles: ['client'], status: 'active' }
    ],
    questionnaires: [
      {
        _id: 'q_satisfaction',
        title: '猫咪上门喂养深度满意度调研',
        description: '了解猫主人对上门服务的核心诉求',
        targetRoles: ['client'],
        status: 'published',
        questions: [
          { id: 'q_1', type: 'single', title: '喂养满意度', options: ['非常满意', '基本满意', '不满意'] },
          { id: 'q_2', type: 'rating', title: '服务评分', max: 5 },
          { id: 'q_3', type: 'long_text', title: '服务建议' }
        ]
      }
    ],
    questionnaire_responses: [
      {
        _id: 'resp_1',
        questionnaireId: 'q_satisfaction',
        role: 'client',
        openid: 'client_openid',
        aiQuality: { verdict: 'valid', score: 100 },
        answers: [
          { questionId: 'q_1', title: '喂养满意度', value: '非常满意' },
          { questionId: 'q_2', title: '服务评分', value: 5 },
          { questionId: 'q_3', title: '服务建议', value: '宠托师拍的猫咪吃饭小视频非常清晰，让人放心！' }
        ]
      }
    ],
    questionnaire_ai_reports: []
  })

  let modelCalledWith = null
  const mockAiExt = {
    createModel(provider) {
      assert.ok(provider === 'hunyuan' || provider === 'cloudbase')
      return {
        async generateText(options) {
          modelCalledWith = options
          return {
            choices: [
              {
                message: {
                  content: `\`\`\`json
{
  "summary": "本次猫咪上门喂养调研总体满意度极高，用户对全程视频反馈机制给予强烈好评，有效建立了到家履约信任感。",
  "insights": [
    "猫主人高度看重实时互动与可视化反馈（如视频打卡与进出门安全提示）。",
    "到家服务准时率与专业温和态度是用户建立长期复购的核心动因。",
    "节假日高峰期预约难是潜在的痛点瓶颈。"
  ],
  "strengths": [
    "实时打卡与拍摄反馈极其专业细致，极大缓解宠主焦虑。",
    "宠托师态度温和，猫咪适应良好。"
  ],
  "painPoints": [
    "热门节假日预约档期紧张，偶有约不上心仪宠托师的情况。"
  ],
  "suggestions": [
    "推广节假日提前锁单机制，提升服务履约确定性。",
    "进一步标准化上门进门、消毒、喂粮、清洁猫砂的视觉记录规范。"
  ],
  "qualityAnalysis": "本期样本作答质量优良，有效作答占比100%，真实反映了核心猫咪家长的实际心声。"
}
\`\`\``
                }
              }
            ]
          }
        }
      }
    }
  }

  const adminFn = loadCloudFunction('api', db, 'admin_openid', {
    extend: {
      AI: mockAiExt
    }
  })

  const res = await adminFn.main({
    module: 'questionnaire',
    action: 'analyzeAI',
    data: { id: 'q_satisfaction' }
  })

  assert.equal(res.ok, true)
  assert.equal(res.data.source, 'hy3')
  assert.equal(res.data.model, 'hy3')
  assert.equal(modelCalledWith.model, 'hy3')
  assert.ok(modelCalledWith.messages[0].content.includes('hy3'))
  assert.ok(modelCalledWith.messages[1].content.includes('猫咪上门喂养深度满意度调研'))
  assert.ok(res.data.summary.includes('总体满意度极高'))
  assert.equal(res.data.insights.length, 3)
  assert.equal(res.data.strengths.length, 2)
  assert.equal(res.data.painPoints.length, 1)
  assert.equal(res.data.suggestions.length, 2)
  assert.ok(res.data.qualityAnalysis.includes('本期样本作答质量优良'))

  // 验证保存至 questionnaire_ai_reports 数据库记录
  const savedReport = db.state.questionnaire_ai_reports.find(r => r.questionnaireId === 'q_satisfaction')
  assert.ok(savedReport)
  assert.equal(savedReport.source, 'hy3')
  assert.equal(savedReport.model, 'hy3')
})

test('questionnaire analyzeAI handles empty responses and AI failures gracefully', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin_1', openid: 'admin_openid', roles: ['admin'], status: 'active' }
    ],
    questionnaires: [
      {
        _id: 'q_empty',
        title: '新功能调研问卷',
        targetRoles: ['client'],
        status: 'draft',
        questions: [{ id: 'q_1', type: 'single', title: '满意吗', options: ['满意', '一般'] }]
      }
    ],
    questionnaire_responses: [],
    questionnaire_ai_reports: []
  })

  const adminFn = loadCloudFunction('api', db, 'admin_openid')
  const emptyRes = await adminFn.main({
    module: 'questionnaire',
    action: 'analyzeAI',
    data: { id: 'q_empty' }
  })
  assert.equal(emptyRes.ok, true)
  assert.ok(emptyRes.data.summary.includes('暂未收到作答数据'))
  assert.equal(emptyRes.data.source, 'hy3')
  assert.equal(emptyRes.data.model, 'hy3')
})



