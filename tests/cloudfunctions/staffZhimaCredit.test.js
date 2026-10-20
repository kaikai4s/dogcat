const test = require('node:test')
const assert = require('node:assert/strict')
const createSettingsService = require('../../cloudfunctions/api/services/settings')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('staffZhima: normalizeStaffZhimaConfig 字段规范化与边界处理', () => {
  const service = createSettingsService({
    db: {},
    defaultHomeModules: {},
    normalizeStaffDepositConfig: (v) => v || {},
    normalizeStaffSuppliesConfig: (v) => v || {},
    normalizeStaffTrainingConfig: (v) => v || {},
    now: () => '2026-10-20 12:00:00',
    safeNumber: (v) => Number(v) || 0,
    safeText: (v) => String(v || '')
  })

  // 1. 空配置默认值
  const def = service.normalizeStaffZhimaConfig()
  assert.equal(def.enabled, false)
  assert.equal(def.minScore, 650)
  assert.match(def.rulesText, /芝麻信用分/)
  assert.equal(def.scoreTemplateUrl, '')
  assert.equal(def.profileTemplateUrl, '')

  // 2. 自定义有效值
  const custom = service.normalizeStaffZhimaConfig({
    enabled: true,
    minScore: 700,
    rulesText: '严格审核信用记录',
    scoreTemplateUrl: 'cloud://template-score',
    profileTemplateUrl: 'cloud://template-profile'
  })
  assert.equal(custom.enabled, true)
  assert.equal(custom.minScore, 700)
  assert.equal(custom.rulesText, '严格审核信用记录')
  assert.equal(custom.scoreTemplateUrl, 'cloud://template-score')
  assert.equal(custom.profileTemplateUrl, 'cloud://template-profile')

  // 3. 超出范围（<350 或 >950）回退默认 650
  assert.equal(service.normalizeStaffZhimaConfig({ minScore: 200 }).minScore, 650)
  assert.equal(service.normalizeStaffZhimaConfig({ minScore: 1000 }).minScore, 650)
  assert.equal(service.normalizeStaffZhimaConfig({ minScore: 'abc' }).minScore, 650)
  assert.equal(service.normalizeStaffZhimaConfig({ minScore: 666.8 }).minScore, 667)
})

test('staffZhima: getStaffCertificationConfig 接口能正确下发配置', async () => {
  const db = createCollectionStore({
    platform_configs: [
      {
        _id: 'cfg_1',
        key: 'system_settings',
        value: {
          staffZhima: {
            enabled: true,
            minScore: 680,
            rulesText: '准入信用分门槛680',
            scoreTemplateUrl: 'cloud://score_tpl',
            profileTemplateUrl: 'cloud://profile_tpl'
          }
        }
      }
    ],
    users: [{ _id: 'u1', openid: 'openid_applicant', roles: ['client'] }]
  })
  const fn = loadCloudFunction('api', db, 'openid_applicant')

  const res = await fn.main({
    module: 'staff',
    action: 'getStaffCertificationConfig',
    data: {}
  })

  assert.equal(res.ok, true, res.message)
  assert.equal(res.data.zhima.enabled, true)
  assert.equal(res.data.zhima.minScore, 680)
  assert.equal(res.data.zhima.rulesText, '准入信用分门槛680')
  assert.equal(res.data.zhima.scoreTemplateUrl, 'cloud://score_tpl')
  assert.equal(res.data.zhima.profileTemplateUrl, 'cloud://profile_tpl')
})

test('staffZhima: submitStaffProfile 门槛拦截与达标提交核验流程', async () => {
  const db = createCollectionStore({
    platform_configs: [
      {
        _id: 'cfg_1',
        key: 'system_settings',
        value: {
          staffZhima: {
            enabled: true,
            minScore: 650,
            rulesText: '必须达到650分',
            scoreTemplateUrl: 'cloud://score_template',
            profileTemplateUrl: 'cloud://profile_template'
          }
        }
      }
    ],
    users: [{ _id: 'u_applicant', openid: 'openid_applicant', roles: ['client'], status: 'active', phone: '13800138000' }],
    staff_profiles: [],
    staff_identity_verifications: []
  })
  const fn = loadCloudFunction('api', db, 'openid_applicant')

  const baseApplication = {
    realName: '李四',
    gender: 'female',
    idCardNumber: '110101199003072383',
    phone: '13800138000',
    serviceCity: '上海市',
    serviceAddress: '徐家汇中心',
    serviceLatitude: 31.19,
    serviceLongitude: 121.43,
    idCardFrontFileId: 'cloud://card-front',
    idCardBackFileId: 'cloud://card-back',
    facePhotoFileId: 'cloud://face'
  }

  // 1. 未填写芝麻信用分数值拦截
  const resNoScore = await fn.main({
    module: 'staff',
    action: 'submitStaffProfile',
    data: { ...baseApplication }
  })
  assert.equal(resNoScore.ok, false)
  assert.match(resNoScore.message, /请输入有效的支付宝芝麻信用分/)

  // 2. 芝麻信用分低于准入门槛（如 600 < 650）被拦截
  const resLowScore = await fn.main({
    module: 'staff',
    action: 'submitStaffProfile',
    data: {
      ...baseApplication,
      zhimaScore: 600,
      zhimaScoreFileId: 'cloud://zhima-score',
      alipayProfileFileId: 'cloud://alipay-profile'
    }
  })
  assert.equal(resLowScore.ok, false)
  assert.match(resLowScore.message, /支付宝芝麻信用分未达到平台准入要求（最低需要 650 分）/)

  // 3. 芝麻分达标（680），但未上传芝麻分截图拦截
  const resNoScoreImg = await fn.main({
    module: 'staff',
    action: 'submitStaffProfile',
    data: {
      ...baseApplication,
      zhimaScore: 680,
      alipayProfileFileId: 'cloud://alipay-profile'
    }
  })
  assert.equal(resNoScoreImg.ok, false)
  assert.match(resNoScoreImg.message, /请上传支付宝芝麻信用分截图/)

  // 4. 芝麻分达标（680），上传了芝麻分截图，但未上传支付宝主页截图拦截
  const resNoProfileImg = await fn.main({
    module: 'staff',
    action: 'submitStaffProfile',
    data: {
      ...baseApplication,
      zhimaScore: 680,
      zhimaScoreFileId: 'cloud://zhima-score'
    }
  })
  assert.equal(resNoProfileImg.ok, false)
  assert.match(resNoProfileImg.message, /请上传支付宝个人主页截图/)

  // 5. 完整达标提交（680分 + 芝麻分截图 + 主页截图）成功落库
  const resSuccess = await fn.main({
    module: 'staff',
    action: 'submitStaffProfile',
    data: {
      ...baseApplication,
      zhimaScore: 680,
      zhimaScoreFileId: 'cloud://zhima-score',
      alipayProfileFileId: 'cloud://alipay-profile'
    }
  })
  assert.equal(resSuccess.ok, true, resSuccess.message)

  // 检查 staff_profiles 表落库
  const savedProfile = db.state.staff_profiles[0]
  assert.equal(savedProfile.zhimaScore, 680)
  assert.equal(savedProfile.zhimaScoreFileId, 'cloud://zhima-score')
  assert.equal(savedProfile.alipayProfileFileId, 'cloud://alipay-profile')
  assert.equal(savedProfile.zhimaCredit.score, 680)
  assert.equal(savedProfile.zhimaCredit.minScoreSnapshot, 650)
  assert.equal(savedProfile.zhimaCredit.scoreFileId, 'cloud://zhima-score')
  assert.equal(savedProfile.zhimaCredit.profileFileId, 'cloud://alipay-profile')

  // 检查 staff_identity_verifications 表落库
  const savedIdentity = db.state.staff_identity_verifications[0]
  assert.equal(savedIdentity.zhimaScore, 680)
  assert.equal(savedIdentity.zhimaScoreFileId, 'cloud://zhima-score')
  assert.equal(savedIdentity.alipayProfileFileId, 'cloud://alipay-profile')
  assert.equal(savedIdentity.zhimaCredit.score, 680)

  // 6. 管理员审核能够读取到该资料
  const adminFn = loadCloudFunction('api', db, 'openid_admin')
  db.state.users.push({ _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' })
  const auditRes = await adminFn.main({
    module: 'admin',
    action: 'listStaffAudits',
    data: { staffProfileId: savedProfile._id }
  })
  assert.equal(auditRes.ok, true, auditRes.message)
  const auditedItem = auditRes.data[0]
  assert.equal(auditedItem.zhimaScore, 680)
  assert.equal(auditedItem.zhimaScoreFileId, 'cloud://zhima-score')
  assert.equal(auditedItem.alipayProfileFileId, 'cloud://alipay-profile')
})

test('staffZhima: 管理后台保存芝麻信用准入配置与模板', async () => {
  const db = createCollectionStore({
    platform_configs: [],
    users: [{ _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' }]
  })
  const fn = loadCloudFunction('api', db, 'openid_admin')

  // 1. 非法分数拦截
  const resInvalid = await fn.main({
    module: 'admin',
    action: 'saveSystemSettings',
    data: {
      staffZhima: {
        enabled: true,
        minScore: 1200
      }
    }
  })
  assert.equal(resInvalid.ok, false)
  assert.match(resInvalid.message, /最低准入信用分必须在 350 至 950 之间/)

  // 2. 正常保存配置与模板
  const resSave = await fn.main({
    module: 'admin',
    action: 'saveSystemSettings',
    data: {
      staffZhima: {
        enabled: true,
        minScore: 660,
        rulesText: '准入需要达到660分',
        scoreTemplateUrl: 'cloud://tmpl/score.png',
        profileTemplateUrl: 'cloud://tmpl/profile.png'
      }
    }
  })
  assert.equal(resSave.ok, true, resSave.message)

  // 3. 读取验证
  const resGet = await fn.main({
    module: 'admin',
    action: 'getSystemSettings',
    data: {}
  })
  assert.equal(resGet.ok, true, resGet.message)
  assert.equal(resGet.data.staffZhima.enabled, true)
  assert.equal(resGet.data.staffZhima.minScore, 660)
  assert.equal(resGet.data.staffZhima.rulesText, '准入需要达到660分')
  assert.equal(resGet.data.staffZhima.scoreTemplateUrl, 'cloud://tmpl/score.png')
  assert.equal(resGet.data.staffZhima.profileTemplateUrl, 'cloud://tmpl/profile.png')
})
