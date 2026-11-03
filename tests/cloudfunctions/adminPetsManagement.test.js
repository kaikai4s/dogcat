const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('admin.listPets returns pets with owner attribution, filters and pagination', async () => {
  const db = createCollectionStore({
    users: [
      {
        _id: 'u_admin',
        openid: 'openid_admin',
        roles: ['admin'],
        status: 'active',
        nickname: '管理员'
      },
      {
        _id: 'u_owner_1',
        openid: 'openid_owner_1',
        roles: ['client'],
        status: 'active',
        nickname: '爱宠张三',
        phone: '13811112222',
        avatarUrl: 'https://avatar.example.com/1.png',
        memberLevelName: '黄金会员',
        inviteCode: 'VIP888',
        inviterOpenid: 'openid_inviter',
        completedOrderCount: 5,
        retroCardCount: 2,
        createdAt: '2026-01-10 10:00:00'
      },
      {
        _id: 'u_owner_2',
        openid: 'openid_owner_2',
        roles: ['client'],
        status: 'active',
        nickname: '李四',
        phone: '13933334444',
        memberLevelName: '普通会员',
        createdAt: '2026-02-15 14:30:00'
      }
    ],
    pets: [
      {
        _id: 'pet_dog_1',
        openid: 'openid_owner_1',
        name: '旺财',
        species: 'dog',
        breed: '柯基',
        gender: 'male',
        sterilized: true,
        weight: 12.5,
        birthday: '2023-05-20',
        exclusiveId: 'P_DOG_001',
        avatarFileId: 'cloud://test/dog1.jpg',
        beautyPhotos: [{ id: 'p1', fileId: 'cloud://test/dog1.jpg' }],
        careTags: ['护食', '需短牵'],
        personality: '活泼好动',
        beautyContestDisqualified: false,
        createdAt: '2026-02-01 12:00:00',
        updatedAt: '2026-02-02 12:00:00'
      },
      {
        _id: 'pet_cat_1',
        openid: 'openid_owner_1',
        name: '咪咪',
        species: 'cat',
        breed: '布偶',
        gender: 'female',
        sterilized: false,
        exclusiveId: 'P_CAT_001',
        avatarFileId: 'cloud://test/cat1.jpg',
        beautyContestDisqualified: true,
        disqualifiedReason: 'AI合成虚假照片',
        disqualifiedAt: '2026-02-05 16:00:00',
        disqualifiedBy: 'openid_admin',
        createdAt: '2026-02-03 10:00:00',
        updatedAt: '2026-02-05 16:00:00'
      },
      {
        _id: 'pet_other_1',
        openid: 'openid_owner_2',
        name: '小飞',
        species: 'other',
        breed: '蜜袋鼯',
        gender: 'male',
        sterilized: false,
        exclusiveId: 'P_FLY_001',
        avatarFileId: 'cloud://test/fly1.jpg',
        beautyContestDisqualified: false,
        createdAt: '2026-02-16 09:00:00',
        updatedAt: '2026-02-16 09:00:00'
      }
    ]
  })

  const adminApi = loadCloudFunction('api', db, 'openid_admin')

  // 1. 全量查询（按创建时间倒序）
  const resAll = await adminApi.main({
    module: 'admin',
    action: 'listPets',
    data: { page: 1, pageSize: 10 }
  })
  assert.equal(resAll.ok, true)
  assert.equal(resAll.data.total, 3)
  assert.equal(resAll.data.list.length, 3)
  // 检查第一条记录（最新创建的蜜袋鼯）
  assert.equal(resAll.data.list[0].exclusiveId, 'P_FLY_001')
  assert.equal(resAll.data.list[0].owner.nickname, '李四')
  assert.equal(resAll.data.list[0].owner.phone, '13933334444')

  // 检查旺财的主人归属和详细信息
  const wangcai = resAll.data.list.find((p) => p.exclusiveId === 'P_DOG_001')
  assert.ok(wangcai)
  assert.equal(wangcai.name, '旺财')
  assert.equal(wangcai.speciesText, '狗狗')
  assert.equal(wangcai.genderText, '弟弟 (公)')
  assert.equal(wangcai.sterilizedText, '已绝育')
  assert.equal(wangcai.weight, 12.5)
  assert.deepEqual(wangcai.careTags, ['护食', '需短牵'])
  assert.equal(wangcai.personality, '活泼好动')
  assert.equal(wangcai.owner.nickname, '爱宠张三')
  assert.equal(wangcai.owner.phone, '13811112222')
  assert.equal(wangcai.owner.memberLevelName, '黄金会员')
  assert.equal(wangcai.beautyContestDisqualified, false)

  // 2. 按物种筛选（只查猫咪）
  const resCat = await adminApi.main({
    module: 'admin',
    action: 'listPets',
    data: { species: 'cat' }
  })
  assert.equal(resCat.ok, true)
  assert.equal(resCat.data.total, 1)
  assert.equal(resCat.data.list[0].name, '咪咪')

  // 3. 按大赛资格筛选（只查已下架大赛）
  const resDisqualified = await adminApi.main({
    module: 'admin',
    action: 'listPets',
    data: { contestStatus: 'disqualified' }
  })
  assert.equal(resDisqualified.ok, true)
  assert.equal(resDisqualified.data.total, 1)
  assert.equal(resDisqualified.data.list[0].exclusiveId, 'P_CAT_001')
  assert.equal(resDisqualified.data.list[0].beautyContestDisqualified, true)
  assert.equal(resDisqualified.data.list[0].disqualifiedReason, 'AI合成虚假照片')

  // 4. 按大赛资格筛选（只查正常参赛）
  const resQualified = await adminApi.main({
    module: 'admin',
    action: 'listPets',
    data: { contestStatus: 'qualified' }
  })
  assert.equal(resQualified.ok, true)
  assert.equal(resQualified.data.total, 2)

  // 5. 关键词搜索：按宠物名 / 品种 / 专属ID
  const resSearchBreed = await adminApi.main({
    module: 'admin',
    action: 'listPets',
    data: { keyword: '柯基' }
  })
  assert.equal(resSearchBreed.ok, true)
  assert.equal(resSearchBreed.data.total, 1)
  assert.equal(resSearchBreed.data.list[0].name, '旺财')

  const resSearchId = await adminApi.main({
    module: 'admin',
    action: 'listPets',
    data: { keyword: 'P_CAT_001' }
  })
  assert.equal(resSearchId.ok, true)
  assert.equal(resSearchId.data.total, 1)
  assert.equal(resSearchId.data.list[0].name, '咪咪')

  // 6. 关键词搜索：按主人手机号 / 昵称
  const resSearchPhone = await adminApi.main({
    module: 'admin',
    action: 'listPets',
    data: { keyword: '13811112222' }
  })
  assert.equal(resSearchPhone.ok, true)
  // 张三有两只宠物（旺财、咪咪）
  assert.equal(resSearchPhone.data.total, 2)

  const resSearchOwnerNick = await adminApi.main({
    module: 'admin',
    action: 'listPets',
    data: { keyword: '李四' }
  })
  assert.equal(resSearchOwnerNick.ok, true)
  assert.equal(resSearchOwnerNick.data.total, 1)
  assert.equal(resSearchOwnerNick.data.list[0].name, '小飞')
})

test('admin can disqualify and reinstate pet beauty contest candidate', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      { _id: 'u_user', openid: 'openid_user', roles: ['client'], status: 'active', nickname: '宠主' }
    ],
    pets: [
      {
        _id: 'pet_test_1',
        openid: 'openid_user',
        name: '皮皮',
        species: 'dog',
        breed: '金毛',
        exclusiveId: 'P_GOLD_01',
        avatarFileId: 'cloud://test/gold.jpg',
        beautyContestDisqualified: false,
        createdAt: '2026-03-01 10:00:00'
      }
    ]
  })

  const adminApi = loadCloudFunction('api', db, 'openid_admin')

  // 1. 管理员下架皮皮的最美大赛资格
  const resDisqualify = await adminApi.main({
    module: 'petBeauty',
    action: 'disqualifyPetBeautyCandidate',
    data: {
      petId: 'pet_test_1',
      reason: '盗用他人网图参赛'
    }
  })
  assert.equal(resDisqualify.ok, true)
  assert.equal(resDisqualify.data.beautyContestDisqualified, true)
  assert.equal(resDisqualify.data.disqualifiedReason, '盗用他人网图参赛')

  // 验证 admin.listPets 查出的状态已更新
  const resList1 = await adminApi.main({
    module: 'admin',
    action: 'listPets',
    data: { keyword: 'P_GOLD_01' }
  })
  assert.equal(resList1.ok, true)
  assert.equal(resList1.data.list[0].beautyContestDisqualified, true)
  assert.equal(resList1.data.list[0].disqualifiedReason, '盗用他人网图参赛')

  // 2. 管理员恢复皮皮的最美大赛资格
  const resReinstate = await adminApi.main({
    module: 'petBeauty',
    action: 'reinstatePetBeautyCandidate',
    data: {
      petId: 'pet_test_1'
    }
  })
  assert.equal(resReinstate.ok, true)
  assert.equal(resReinstate.data.beautyContestDisqualified, false)

  // 验证 admin.listPets 查出的状态恢复正常
  const resList2 = await adminApi.main({
    module: 'admin',
    action: 'listPets',
    data: { keyword: 'P_GOLD_01' }
  })
  assert.equal(resList2.ok, true)
  assert.equal(resList2.data.list[0].beautyContestDisqualified, false)
  assert.equal(resList2.data.list[0].disqualifiedReason, '')
})

test('admin user management returns rich profile details including timestamps and invite info', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      {
        _id: 'u_client_rich',
        openid: 'openid_client_rich',
        roles: ['client'],
        status: 'active',
        nickname: '深度用户',
        phone: '13700008888',
        memberLevelName: '钻石会员',
        points: 500,
        totalPoints: 1200,
        inviteCode: 'INVITE_999',
        inviterOpenid: 'openid_inviter_root',
        completedOrderCount: 18,
        retroCardCount: 5,
        agreementSignedAt: '2026-01-01 08:00:00',
        createdAt: '2026-01-01 08:00:00',
        updatedAt: '2026-03-01 15:30:00'
      }
    ],
    pets: [
      { _id: 'p1', openid: 'openid_client_rich', name: '宠1' },
      { _id: 'p2', openid: 'openid_client_rich', name: '宠2' }
    ]
  })

  const adminApi = loadCloudFunction('api', db, 'openid_admin')

  // 1. 测试 listUsers 返回完整字段
  const resList = await adminApi.main({
    module: 'admin',
    action: 'listUsers',
    data: { keyword: '深度用户' }
  })
  assert.equal(resList.ok, true)
  assert.equal(resList.data.list.length, 1)
  const userSummary = resList.data.list[0]
  assert.equal(userSummary.createdAt, '2026-01-01 08:00:00')
  assert.equal(userSummary.updatedAt, '2026-03-01 15:30:00')
  assert.equal(userSummary.inviteCode, 'INVITE_999')
  assert.equal(userSummary.inviterOpenid, 'openid_inviter_root')
  assert.equal(userSummary.agreementSignedAt, '2026-01-01 08:00:00')
  assert.equal(userSummary.completedOrderCount, 18)
  assert.equal(userSummary.retroCardCount, 5)

  // 2. 测试 getUserDetail 返回完整字段与统计
  const resDetail = await adminApi.main({
    module: 'admin',
    action: 'getUserDetail',
    data: { openid: 'openid_client_rich' }
  })
  assert.equal(resDetail.ok, true)
  assert.equal(resDetail.data.createdAt, '2026-01-01 08:00:00')
  assert.equal(resDetail.data.updatedAt, '2026-03-01 15:30:00')
  assert.equal(resDetail.data.inviteCode, 'INVITE_999')
  assert.equal(resDetail.data.inviterOpenid, 'openid_inviter_root')
  assert.equal(resDetail.data.agreementSignedAt, '2026-01-01 08:00:00')
  assert.equal(resDetail.data.completedOrderCount, 18)
  assert.equal(resDetail.data.retroCardCount, 5)
  assert.equal(resDetail.data.stats.pets, 2)
})

test('admin permissions policy: listPets and beauty disqualify/reinstate work with delegated permissions', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'owner', openid: 'owner', roles: ['admin'], status: 'active' },
      { _id: 'delegate_pets', openid: 'delegate_pets', roles: ['admin'], status: 'active' },
      { _id: 'delegate_users', openid: 'delegate_users', roles: ['admin'], status: 'active' },
      { _id: 'delegate_none', openid: 'delegate_none', roles: ['admin'], status: 'active' },
      { _id: 'u1', openid: 'openid_u1', roles: ['client'], status: 'active', nickname: '客户小王' }
    ],
    admin_access_config: [{ _id: 'policy', enabled: true, ownerOpenid: 'owner' }],
    admin_groups: [
      { _id: 'g_pets', name: '宠物专员组', enabled: true, permissions: ['admin.listPets'] },
      { _id: 'g_users', name: '用户专员组', enabled: true, permissions: ['admin.listUsers'] },
      { _id: 'g_none', name: '空权限组', enabled: true, permissions: [] }
    ],
    admin_memberships: [
      { _id: 'delegate_pets', groupIds: ['g_pets'] },
      { _id: 'delegate_users', groupIds: ['g_users'] },
      { _id: 'delegate_none', groupIds: ['g_none'] }
    ],
    pets: [
      {
        _id: 'pet_perm_1',
        openid: 'openid_u1',
        name: '波比',
        species: 'dog',
        exclusiveId: 'P_PERM_01',
        beautyContestDisqualified: false,
        createdAt: '2026-03-01 10:00:00'
      }
    ]
  })

  const apiPets = loadCloudFunction('api', db, 'delegate_pets')
  const apiUsers = loadCloudFunction('api', db, 'delegate_users')
  const apiNone = loadCloudFunction('api', db, 'delegate_none')

  // 1. delegate_pets: 拥有 admin.listPets，能查宠物并操作最美大赛
  const resPetsList = await apiPets.main({ module: 'admin', action: 'listPets', data: {} })
  assert.equal(resPetsList.ok, true)
  assert.equal(resPetsList.data.total, 1)

  const resPetsDisqualify = await apiPets.main({
    module: 'petBeauty',
    action: 'disqualifyPetBeautyCandidate',
    data: { petId: 'pet_perm_1', reason: '测试下架' }
  })
  assert.equal(resPetsDisqualify.ok, true)

  const resPetsReinstate = await apiPets.main({
    module: 'petBeauty',
    action: 'reinstatePetBeautyCandidate',
    data: { petId: 'pet_perm_1' }
  })
  assert.equal(resPetsReinstate.ok, true)

  // 2. delegate_users: 仅拥有 admin.listUsers，平滑兼容访问 admin.listPets
  const resUsersList = await apiUsers.main({ module: 'admin', action: 'listPets', data: {} })
  assert.equal(resUsersList.ok, true)
  assert.equal(resUsersList.data.total, 1)

  // 3. delegate_none: 无权限，被拒绝
  const resNone = await apiNone.main({ module: 'admin', action: 'listPets', data: {} })
  assert.equal(resNone.code, 'ADMIN_FORBIDDEN')
})
