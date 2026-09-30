const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

const securityMock = {
  msgSecCheck: async ({ content }) => {
    if (content && content.includes('违规敏感词')) {
      const err = new Error('内容包含违法违规信息')
      err.errCode = 87014
      throw err
    }
    return { errCode: 0, errMsg: 'ok' }
  },
  imgSecCheck: async () => ({ errCode: 0, errMsg: 'ok' })
}

test('staff: submitVideoAuditRequest prevents duplicate submissions while pending or approved', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_staff', openid: 'openid_staff', roles: ['client'], status: 'active', nickname: '实习考核员' }
    ],
    staff_profiles: [
      {
        _id: 'sp_staff',
        openid: 'openid_staff',
        auditStatus: 'approved',
        quizPassedAt: '2026-10-01 10:00:00',
        trainingVideosCompletedAt: '2026-10-01 11:00:00',
        trainingVideoProgress: {
          platform_rules: { watched: true },
          home_service: { watched: true },
          pet_safety: { watched: true }
        },
        videoAuditStatus: 'not_started'
      }
    ],
    platform_configs: [
      {
        key: 'system_settings',
        value: {
          staffTraining: {
            quizQuestions: [],
            videos: []
          }
        }
      }
    ]
  })

  const staffFn = loadCloudFunction('api', db, 'openid_staff', { security: securityMock })

  // 1. 首次提交视频审核，成功
  const submitRes1 = await staffFn.main({
    module: 'staff',
    action: 'submitVideoAuditRequest'
  })
  assert.equal(submitRes1.ok, true)
  assert.equal(submitRes1.data.videoAuditStatus, 'pending')

  // 2. 待审核状态下重复提交，被拦截
  const duplicateRes = await staffFn.main({
    module: 'staff',
    action: 'submitVideoAuditRequest'
  })
  assert.equal(duplicateRes.ok, false)
  assert.match(duplicateRes.error, /视频审核正在处理中，请勿重复提交/)

  // 3. 模拟审核通过
  db.state.staff_profiles[0].videoAuditStatus = 'approved'

  // 4. 已通过后再次提交，被拦截
  const approvedRes = await staffFn.main({
    module: 'staff',
    action: 'submitVideoAuditRequest'
  })
  assert.equal(approvedRes.ok, false)
  assert.match(approvedRes.error, /视频审核已通过，无需重复提交/)
})

test('staff: submitPromotionApplication enforces remark text security, length limit and concurrency safety', async () => {
  const completedOrders = [
    { _id: 'ord_1', staffOpenid: 'openid_staff', status: 'completed' },
    { _id: 'ord_2', staffOpenid: 'openid_staff', status: 'completed' },
    { _id: 'ord_3', staffOpenid: 'openid_staff', status: 'completed' }
  ]

  const db = createCollectionStore({
    users: [
      { _id: 'u_staff', openid: 'openid_staff', roles: ['client', 'staff'], status: 'active' }
    ],
    staff_profiles: [
      {
        _id: 'sp_staff',
        openid: 'openid_staff',
        staffLevel: 'intern',
        auditStatus: 'approved',
        videoAuditStatus: 'approved',
        promotionStatus: 'none'
      }
    ],
    orders: completedOrders,
    staff_promotion_applications: []
  })

  const staffFn = loadCloudFunction('api', db, 'openid_staff', { security: securityMock })

  // 1. 备注包含敏感词被拦截
  const badRemarkRes = await staffFn.main({
    module: 'staff',
    action: 'submitPromotionApplication',
    data: { remark: '表现优异违规敏感词私聊' }
  })
  assert.equal(badRemarkRes.ok, false)
  assert.match(badRemarkRes.error, /敏感|不合规|违规/)

  // 2. 备注超长被拦截
  const longRemarkRes = await staffFn.main({
    module: 'staff',
    action: 'submitPromotionApplication',
    data: { remark: 'A'.repeat(501) }
  })
  assert.equal(longRemarkRes.ok, false)
  assert.match(longRemarkRes.error, /不能超过 500 字/)

  // 3. 并发模拟：两个并发请求同时调用 submitPromotionApplication
  const [resA, resB] = await Promise.all([
    staffFn.main({ module: 'staff', action: 'submitPromotionApplication', data: { remark: '已圆满完成3单实习服务，申请转正' } }),
    staffFn.main({ module: 'staff', action: 'submitPromotionApplication', data: { remark: '已圆满完成3单实习服务，申请转正' } })
  ])

  // 严格保证一个成功一个失败被拦截
  const successes = [resA, resB].filter((r) => r.ok)
  const failures = [resA, resB].filter((r) => !r.ok)
  assert.equal(successes.length, 1)
  assert.equal(failures.length, 1)
  assert.match(failures[0].error, /已有待审核晋升申请/)

  // 数据库中严格只有 1 条申请单
  assert.equal(db.state.staff_promotion_applications.length, 1)
  assert.equal(db.state.staff_profiles[0].promotionStatus, 'pending')
})

test('admin: auditPromotionApplication protects pending state and audits remark', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      { _id: 'u_staff', openid: 'openid_staff', roles: ['client', 'staff'], status: 'active' }
    ],
    staff_profiles: [
      {
        _id: 'sp_staff',
        openid: 'openid_staff',
        staffLevel: 'intern',
        promotionStatus: 'pending'
      }
    ],
    staff_promotion_applications: [
      {
        _id: 'app_1',
        staffProfileId: 'sp_staff',
        staffOpenid: 'openid_staff',
        status: 'pending',
        staffRemark: '申请转正'
      }
    ],
    admin_operation_logs: []
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin', { security: securityMock })

  // 1. 管理员审核备注包含敏感词被拦截
  const badRemarkRes = await adminFn.main({
    module: 'admin',
    action: 'auditPromotionApplication',
    data: {
      applicationId: 'app_1',
      status: 'rejected',
      remark: '审核不通过违规敏感词拒绝'
    }
  })
  assert.equal(badRemarkRes.ok, false)
  assert.match(badRemarkRes.error, /敏感|不合规|违规/)

  // 2. 正常审核通过
  const approveRes = await adminFn.main({
    module: 'admin',
    action: 'auditPromotionApplication',
    data: {
      applicationId: 'app_1',
      status: 'approved',
      remark: '服务评价优良，准予转正'
    }
  })
  assert.equal(approveRes.ok, true)
  assert.equal(approveRes.data.status, 'approved')

  // 验证档案状态转为 certified
  const profile = db.state.staff_profiles.find((p) => p._id === 'sp_staff')
  assert.equal(profile.staffLevel, 'certified')
  assert.equal(profile.promotionStatus, 'approved')

  // 3. 对已审核完成的申请单重复审核，被状态守卫拦截
  const duplicateAuditRes = await adminFn.main({
    module: 'admin',
    action: 'auditPromotionApplication',
    data: {
      applicationId: 'app_1',
      status: 'rejected',
      remark: '误操作改拒'
    }
  })
  assert.equal(duplicateAuditRes.ok, false)
  assert.match(duplicateAuditRes.error, /已完成审核，无法重复处理/)

  // 验证状态未被覆盖纂改
  assert.equal(profile.staffLevel, 'certified')
})

test('admin: auditTrainingVideo enforces pending state check and remark security', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      { _id: 'u_staff', openid: 'openid_staff', roles: ['client'], status: 'active' }
    ],
    staff_profiles: [
      {
        _id: 'sp_staff',
        openid: 'openid_staff',
        auditStatus: 'approved',
        videoAuditStatus: 'not_started'
      }
    ],
    admin_operation_logs: []
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin', { security: securityMock })

  // 1. 尝试审核非 pending 状态的视频申请，被拦截
  const notPendingRes = await adminFn.main({
    module: 'admin',
    action: 'auditTrainingVideo',
    data: {
      staffProfileId: 'sp_staff',
      status: 'approved',
      remark: '培训考核通过'
    }
  })
  assert.equal(notPendingRes.ok, false)
  assert.match(notPendingRes.error, /未处于视频待审核状态/)

  // 2. 将状态设置为 pending
  db.state.staff_profiles[0].videoAuditStatus = 'pending'

  // 3. 审核备注超长拦截
  const longRemarkRes = await adminFn.main({
    module: 'admin',
    action: 'auditTrainingVideo',
    data: {
      staffProfileId: 'sp_staff',
      status: 'approved',
      remark: 'X'.repeat(501)
    }
  })
  assert.equal(longRemarkRes.ok, false)
  assert.match(longRemarkRes.error, /不能超过 500 字/)

  // 4. 审核备注包含敏感词拦截
  const badRemarkRes = await adminFn.main({
    module: 'admin',
    action: 'auditTrainingVideo',
    data: {
      staffProfileId: 'sp_staff',
      status: 'approved',
      remark: '违规敏感词考核备注'
    }
  })
  assert.equal(badRemarkRes.ok, false)
  assert.match(badRemarkRes.error, /敏感|不合规|违规/)

  // 5. 正常审核通过
  const goodAuditRes = await adminFn.main({
    module: 'admin',
    action: 'auditTrainingVideo',
    data: {
      staffProfileId: 'sp_staff',
      status: 'approved',
      remark: '视频考核动作规范，准予进入实习阶段'
    }
  })
  assert.equal(goodAuditRes.ok, true)
  assert.equal(goodAuditRes.data.status, 'approved')

  // 验证用户角色已获得 staff，档案升级为 intern
  const staffUser = db.state.users.find((u) => u.openid === 'openid_staff')
  assert.ok(staffUser.roles.includes('staff'))
  const staffProfile = db.state.staff_profiles.find((p) => p._id === 'sp_staff')
  assert.equal(staffProfile.staffLevel, 'intern')
  assert.equal(staffProfile.videoAuditStatus, 'approved')
})
