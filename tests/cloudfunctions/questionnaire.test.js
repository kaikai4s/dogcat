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

