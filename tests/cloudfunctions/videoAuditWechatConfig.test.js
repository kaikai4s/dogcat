const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('admin can configure video audit wechat and staff receives dynamic guide', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'admin_openid', roles: ['admin'], status: 'active' },
      { _id: 'u_staff', openid: 'staff_openid', roles: ['staff'], status: 'active' }
    ],
    admins: [
      { _id: 'a1', openid: 'admin_openid', name: '总管理员', status: 'active', permissions: ['all'] }
    ],
    staff_profiles: [
      {
        _id: 'sp_1',
        openid: 'staff_openid',
        realName: '小王',
        auditStatus: 'approved',
        staffLevel: 'applicant',
        onboardingStatus: 'videos_completed',
        quizPassedAt: '2026-09-20 10:00',
        trainingVideosCompletedAt: '2026-09-20 11:00',
        videoAuditStatus: 'not_started'
      }
    ],
    platform_configs: [],
    admin_operation_logs: []
  })

  // 1. 初始状态：宠托师查看培训状态，获取默认审核微信
  const staffApi = loadCloudFunction('api', db, 'staff_openid')
  const initialRes = await staffApi.main({ action: 'getTrainingStatus', module: 'staff' })
  assert.equal(initialRes.ok, true)
  assert.equal(initialRes.data.videoAuditGuide.wechatId, 'pet-service-admin')
  assert.ok(initialRes.data.videoAuditGuide.remarkTemplate.includes('宠托师审核'))

  // 2. 管理员在后台配置新的审核微信号与指引
  const adminApi = loadCloudFunction('api', db, 'admin_openid')
  const updateRes = await adminApi.main({
    action: 'updateVideoAuditGuide',
    module: 'admin',
    data: {
      guide: {
        wechatId: 'wx_chief_auditor_2026',
        remarkTemplate: '宠物考核 + 姓名 + 手机号',
        description: '请添加主管审核微信并进行视频考核。'
      }
    }
  })

  assert.equal(updateRes.ok, true)
  assert.equal(updateRes.data.success, true)
  assert.equal(updateRes.data.videoAuditGuide.wechatId, 'wx_chief_auditor_2026')
  assert.equal(updateRes.data.videoAuditGuide.remarkTemplate, '宠物考核 + 姓名 + 手机号')

  // 3. 管理员读取系统设置，确认已经持久化保存
  const settingsRes = await adminApi.main({ action: 'getSystemSettings', module: 'admin' })
  assert.equal(settingsRes.ok, true)
  assert.equal(settingsRes.data.staffTraining.videoAuditGuide.wechatId, 'wx_chief_auditor_2026')
  assert.equal(settingsRes.data.staffTraining.videoAuditGuide.remarkTemplate, '宠物考核 + 姓名 + 手机号')
  assert.equal(settingsRes.data.staffTraining.videoAuditGuide.description, '请添加主管审核微信并进行视频考核。')

  // 4. 宠托师再次获取培训状态，应该动态拿到最新的管理员微信号
  const updatedRes = await staffApi.main({ action: 'getTrainingStatus', module: 'staff' })
  assert.equal(updatedRes.ok, true)
  assert.equal(updatedRes.data.videoAuditGuide.wechatId, 'wx_chief_auditor_2026')
  assert.equal(updatedRes.data.videoAuditGuide.remarkTemplate, '宠物考核 + 姓名 + 手机号')
  assert.equal(updatedRes.data.videoAuditGuide.description, '请添加主管审核微信并进行视频考核。')
})

