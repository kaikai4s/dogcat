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

test('auth.bindPhone: prevents phone hijacking, protects admin whitelist, and supports code auth', async () => {
  const previousSecret = process.env.INIT_ADMIN_SECRET
  const previousPhones = process.env.INIT_ADMIN_PHONES
  process.env.INIT_ADMIN_SECRET = 'super-init-secret'
  process.env.INIT_ADMIN_PHONES = '13900000001,13900000002'

  try {
    const db = createCollectionStore({
      users: [
        { _id: 'u_alice', openid: 'openid_alice', phone: '13811112222', roles: ['client'], status: 'active' },
        { _id: 'u_bob', openid: 'openid_bob', phone: '13833334444', roles: ['client'], status: 'active' },
        { _id: 'u_attacker', openid: 'openid_attacker', phone: '', roles: ['client'], status: 'active' }
      ]
    })
    const attackerFn = loadCloudFunction('api', db, 'openid_attacker')

    // 1. 试图绑定已被其他活跃账号占用的手机号 -> 拦截
    const resDuplicate = await attackerFn.main({
      module: 'auth',
      action: 'bindPhone',
      data: { phone: '13811112222' }
    })
    assert.equal(resDuplicate.ok, false)
    assert.match(resDuplicate.error, /该手机号码已被其他账号绑定/)

    // 2. 试图伪造绑定系统初始化管理员白名单中的手机号 -> 拦截
    const resHijackAdmin = await attackerFn.main({
      module: 'auth',
      action: 'bindPhone',
      data: { phone: '13900000001' }
    })
    assert.equal(resHijackAdmin.ok, false)
    assert.match(resHijackAdmin.error, /该手机号受系统安全保护/)

    // 3. 携带正确 secret 允许绑定白名单手机号
    const resAdminWithSecret = await attackerFn.main({
      module: 'auth',
      action: 'bindPhone',
      data: { phone: '13900000001', secret: 'super-init-secret' }
    })
    assert.equal(resAdminWithSecret.ok, true)
    assert.equal(resAdminWithSecret.data.phone, '13900000001')

    // 4. 支持微信开放能力 mock code 绑定
    const userNormalFn = loadCloudFunction('api', db, 'openid_bob')
    const resCodeBind = await userNormalFn.main({
      module: 'auth',
      action: 'bindPhone',
      data: { code: 'mock_code_123' }
    })
    assert.equal(resCodeBind.ok, true)
    assert.equal(resCodeBind.data.phone, '13800138000')
  } finally {
    process.env.INIT_ADMIN_SECRET = previousSecret
    process.env.INIT_ADMIN_PHONES = previousPhones
  }
})

test('initData: setupDatabase enforces admin or init secret permission', async () => {
  const previousSecret = process.env.INIT_ADMIN_SECRET
  process.env.INIT_ADMIN_SECRET = 'db-setup-secret'

  try {
    // 场景 A: 存在 active 管理员时，普通用户不可随意触发 setupDatabase
    const dbWithAdmin = createCollectionStore({
      users: [
        { _id: 'admin_1', openid: 'openid_admin', roles: ['admin'], activeRole: 'admin', status: 'active' },
        { _id: 'client_1', openid: 'openid_client', roles: ['client'], activeRole: 'client', status: 'active' }
      ]
    })
    const clientFn = loadCloudFunction('api', dbWithAdmin, 'openid_client')
    const resUnauthorized = await clientFn.main({
      module: 'initData',
      action: 'setupDatabase',
      data: {}
    })
    assert.equal(resUnauthorized.ok, false)
    assert.match(resUnauthorized.error, /仅管理员可操作|非管理员不可操作|权限/)

    // 管理员可正常操作
    const adminFn = loadCloudFunction('api', dbWithAdmin, 'openid_admin')
    const resAdmin = await adminFn.main({
      module: 'initData',
      action: 'setupDatabase',
      data: {}
    })
    assert.equal(resAdmin.ok, true)
    assert.equal(resAdmin.data.success, true)

    // 场景 B: 冷启动且配置了 INIT_ADMIN_SECRET 时，未携带 secret 无法调用
    const emptyDb = createCollectionStore({ users: [] })
    const anonFn = loadCloudFunction('api', emptyDb, 'openid_anon')
    const resNoSecret = await anonFn.main({
      module: 'initData',
      action: 'setupDatabase',
      data: {}
    })
    assert.equal(resNoSecret.ok, false)
    assert.match(resNoSecret.error, /初始化密钥不正确/)

    // 携带正确 secret 即可冷启动初始化
    const resWithSecret = await anonFn.main({
      module: 'initData',
      action: 'setupDatabase',
      data: { secret: 'db-setup-secret', adminOpenid: 'openid_anon' }
    })
    assert.equal(resWithSecret.ok, true)
    assert.equal(resWithSecret.data.success, true)
  } finally {
    process.env.INIT_ADMIN_SECRET = previousSecret
  }
})

test('membership: bindInviteRelation concurrency idempotent and prevents multi-reward', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_inviter', openid: 'openid_inviter', roles: ['client'], status: 'active', retroCardCount: 0, inviteCode: 'INVITE_CODE_1' },
      { _id: 'u_newcomer', openid: 'openid_newcomer', roles: ['client'], status: 'active', retroCardCount: 0, inviteCode: '' }
    ],
    user_invites: [],
    retro_card_logs: []
  })
  const newcomerFn = loadCloudFunction('api', db, 'openid_newcomer')

  // 模拟并发调用 3 次相同邀请绑定
  const results = await Promise.all([
    newcomerFn.main({ module: 'auth', action: 'login', data: { inviteCode: 'INVITE_CODE_1' } }),
    newcomerFn.main({ module: 'auth', action: 'login', data: { inviteCode: 'INVITE_CODE_1' } }),
    newcomerFn.main({ module: 'auth', action: 'login', data: { inviteCode: 'INVITE_CODE_1' } })
  ])

  for (const r of results) {
    assert.equal(r.ok, true)
    assert.equal(r.data.inviterOpenid, 'openid_inviter')
  }

  // 严格确保数据库中只有 1 条邀请绑定记录
  assert.equal(db.state.user_invites.length, 1)
  assert.equal(db.state.user_invites[0].invitedOpenid, 'openid_newcomer')
  assert.equal(db.state.user_invites[0].inviterOpenid, 'openid_inviter')

  // 邀请人的补签卡只奖励了 1 张，绝不超发
  const inviter = db.state.users.find(u => u.openid === 'openid_inviter')
  assert.equal(inviter.retroCardCount, 1)
  assert.equal(db.state.retro_card_logs.length, 1)
})

test('staff: publicServiceAddress and deposit refund reason enforce content security', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_staff', openid: 'openid_staff', roles: ['staff'], activeRole: 'staff', status: 'active' }
    ],
    staff_profiles: [
      {
        _id: 'sp_1',
        openid: 'openid_staff',
        realName: '李测试',
        serviceCity: '上海',
        serviceAreas: '浦东',
        serviceAddress: '浦东新区陆家嘴1号',
        publicServiceAddress: '陆家嘴地铁站附近',
        serviceLatitude: 31.23,
        serviceLongitude: 121.50,
        serviceRadiusKm: 5,
        auditStatus: 'approved',
        staffLevel: 'certified'
      }
    ],
    staff_deposits: [
      {
        _id: 'dep_1',
        staffOpenid: 'openid_staff',
        staffUserId: 'u_staff',
        staffProfileId: 'sp_1',
        amount: 500,
        paidAmount: 500,
        availableRefundAmount: 500,
        forfeitedAmount: 0,
        refundedAmount: 0,
        status: 'paid',
        createdAt: '2026-09-01T00:00:00.000Z'
      }
    ]
  })

  const staffFn = loadCloudFunction('api', db, 'openid_staff', {
    security: securityMock
  })

  // 1. updateStaffProfileConfig 修改公开地址包含违规词被拦截
  const resBadPublicAddr = await staffFn.main({
    module: 'staff',
    action: 'updateStaffProfileConfig',
    data: {
      publicServiceAddress: '联系加V信违规敏感词私聊'
    }
  })
  assert.equal(resBadPublicAddr.ok, false)
  assert.match(resBadPublicAddr.error, /敏感|不合规|违规/)

  // 2. requestDepositRefund 申请退款原因包含违规词被拦截
  const resBadReason = await staffFn.main({
    module: 'staff',
    action: 'requestDepositRefund',
    data: {
      reason: '不干了，发布违规敏感词投诉广告'
    }
  })
  assert.equal(resBadReason.ok, false)
  assert.match(resBadReason.error, /敏感|不合规|违规/)

  // 3. 正常退款原因通过
  const resGoodReason = await staffFn.main({
    module: 'staff',
    action: 'requestDepositRefund',
    data: {
      reason: '因工作调动搬家至其他城市，自愿退出宠托师认证'
    }
  })
  assert.equal(resGoodReason.ok, true)
})
