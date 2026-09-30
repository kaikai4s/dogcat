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
  imgSecCheck: async ({ media }) => {
    if (media && String(media.value || '').includes('bad_image_data')) {
      const err = new Error('图片包含违法违规信息')
      err.errCode = 87014
      throw err
    }
    return { errCode: 0, errMsg: 'ok' }
  }
}

test('admin: listAdmins uses readAll to avoid 100-limit truncation, and revokeAdmin protects single active admin', async () => {
  // 构造超过 100 个用户，验证 listAdmins 能突破默认 100 限制
  const users = [
    { _id: 'u_admin_1', openid: 'openid_admin_1', roles: ['admin'], status: 'active', nickname: '管理员一' },
    { _id: 'u_admin_2', openid: 'openid_admin_2', roles: ['admin'], status: 'active', nickname: '管理员二' }
  ]
  // 填充 102 个普通用户，使得总用户数达到 104
  for (let i = 1; i <= 102; i++) {
    users.push({
      _id: `u_client_${i}`,
      openid: `openid_client_${i}`,
      roles: ['client'],
      status: 'active',
      nickname: `用户${i}`
    })
  }
  // 在列表末尾再加一个管理员
  users.push({
    _id: 'u_admin_3',
    openid: 'openid_admin_3',
    roles: ['admin'],
    status: 'active',
    nickname: '末尾管理员'
  })

  const db = createCollectionStore({
    users,
    admin_logs: []
  })

  const admin1Fn = loadCloudFunction('api', db, 'openid_admin_1')

  // 1. listAdmins 验证：必须包含全部 3 名管理员（包含位于 100 条之后的 u_admin_3）
  const listRes = await admin1Fn.main({
    module: 'admin',
    action: 'listAdmins',
    data: {}
  })
  assert.equal(listRes.ok, true)
  assert.equal(listRes.data.length, 3)
  const openids = listRes.data.map((u) => u.openid)
  assert.ok(openids.includes('openid_admin_1'))
  assert.ok(openids.includes('openid_admin_2'))
  assert.ok(openids.includes('openid_admin_3'))

  // 2. revokeAdmin 保护：不能移除自己
  const revokeSelfRes = await admin1Fn.main({
    module: 'admin',
    action: 'revokeAdmin',
    data: { openid: 'openid_admin_1' }
  })
  assert.equal(revokeSelfRes.ok, false)
  assert.match(revokeSelfRes.error, /不能移除自己的管理员权限/)

  // 3. revokeAdmin 针对不存在的目标用户报错
  const notFoundRes = await admin1Fn.main({
    module: 'admin',
    action: 'revokeAdmin',
    data: { openid: 'non_existent_admin' }
  })
  assert.equal(notFoundRes.ok, false)
  assert.match(notFoundRes.error, /目标用户不存在/)

  // 4. revokeAdmin 正常移除 admin_2
  const revokeAdmin2 = await admin1Fn.main({
    module: 'admin',
    action: 'revokeAdmin',
    data: { openid: 'openid_admin_2' }
  })
  assert.equal(revokeAdmin2.ok, true)

  // 5. revokeAdmin 正常移除 admin_3
  const revokeAdmin3 = await admin1Fn.main({
    module: 'admin',
    action: 'revokeAdmin',
    data: { openid: 'openid_admin_3' }
  })
  assert.equal(revokeAdmin3.ok, true)

  // 6. 此时全局仅剩 admin_1 一名管理员，再次调用 revokeAdmin 必须被“至少保留一个管理员”保护拦截
  const lastAdminProtectRes = await admin1Fn.main({
    module: 'admin',
    action: 'revokeAdmin',
    data: { openid: 'any_other_user' }
  })
  assert.equal(lastAdminProtectRes.ok, false)
  assert.match(lastAdminProtectRes.error, /至少保留一个管理员/)
})

test('admin: grantPoints idempotency with clientRequestId prevents duplicate adjustments', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active', nickname: '管理员' },
      { _id: 'u_target', openid: 'openid_target', roles: ['client'], status: 'active', points: 100, totalPoints: 100 }
    ],
    point_logs: [],
    admin_logs: []
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 1. 第一次发放积分（增加 50 分，携带 clientRequestId）
  const res1 = await adminFn.main({
    module: 'admin',
    action: 'grantPoints',
    data: {
      openid: 'openid_target',
      delta: 50,
      reason: '优质反馈奖励',
      clientRequestId: 'req_grant_points_001'
    }
  })
  assert.equal(res1.ok, true)
  assert.equal(res1.data.delta, 50)
  assert.equal(res1.data.balance, 150)

  // 验证用户积分变为 150
  const targetUserAfterFirst = db.state.users.find((u) => u.openid === 'openid_target')
  assert.equal(targetUserAfterFirst.points, 150)

  // 2. 网络重试或重复提交相同的 clientRequestId
  const res2 = await adminFn.main({
    module: 'admin',
    action: 'grantPoints',
    data: {
      openid: 'openid_target',
      delta: 50,
      reason: '优质反馈奖励',
      clientRequestId: 'req_grant_points_001'
    }
  })
  assert.equal(res2.ok, true)
  assert.equal(res2.data.balance, 150)

  // 验证用户积分仍为 150，未重复增加
  const targetUserAfterSecond = db.state.users.find((u) => u.openid === 'openid_target')
  assert.equal(targetUserAfterSecond.points, 150)

  // 验证流水记录仅有 1 条
  const logs = db.state.point_logs.filter((l) => l.openid === 'openid_target')
  assert.equal(logs.length, 1)
})

test('petTitles: deterministic docId prevents duplicate inventory and enables atomic duplicate compensation', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      { _id: 'u_user', openid: 'openid_user', roles: ['client'], status: 'active', points: 10 }
    ],
    pet_titles: [
      {
        _id: 'title_speedy',
        name: '飞毛腿汪',
        icon: '🐾',
        duplicatePoints: 40,
        enabled: true
      }
    ],
    reward_mails: [],
    user_pet_titles: [],
    pet_title_grants: [],
    point_logs: []
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin')
  const userFn = loadCloudFunction('api', db, 'openid_user')

  // 1. 管理员给用户发放奖励邮件 1
  await adminFn.main({
    module: 'admin',
    action: 'publishPetTitleMail',
    data: {
      titleId: 'title_speedy',
      targetType: 'openid_list',
      openids: 'openid_user',
      title: '头衔邮件1'
    }
  })

  // 2. 用户领取第一封邮件，获得头衔
  const mailsRes1 = await userFn.main({ module: 'rewardMail', action: 'listMyMails' })
  const mail1 = mailsRes1.data[0]
  const claim1 = await userFn.main({ module: 'rewardMail', action: 'claimReward', data: { id: mail1._id } })
  assert.equal(claim1.ok, true)
  assert.equal(claim1.data.rewardClaimResult.petTitleOutcome, 'owned')
  assert.ok(claim1.data.rewardClaimResult.petTitleInventoryId.startsWith('upt_'))

  // 3. 验证 user_pet_titles 集合中只有 1 条背包记录，且 _id 为确定性 ID
  const inventoryList = db.state.user_pet_titles.filter((i) => i.openid === 'openid_user')
  assert.equal(inventoryList.length, 1)
  assert.ok(inventoryList[0]._id.startsWith('upt_'))

  // 4. 重复点击领取同一封邮件（相同 sourceKey 幂等验证）
  const duplicateClaim1 = await userFn.main({ module: 'rewardMail', action: 'claimReward', data: { id: mail1._id } })
  assert.equal(duplicateClaim1.ok, true)
  assert.ok(duplicateClaim1.data.claimedAt)

  // 5. 管理员给用户发放第二封包含同一头衔的奖励邮件
  await adminFn.main({
    module: 'admin',
    action: 'publishPetTitleMail',
    data: {
      titleId: 'title_speedy',
      targetType: 'openid_list',
      openids: 'openid_user',
      title: '头衔邮件2'
    }
  })
  const mailsRes2 = await userFn.main({ module: 'rewardMail', action: 'listMyMails' })
  const mail2 = mailsRes2.data.find((m) => m._id !== mail1._id)
  assert.ok(mail2)

  // 6. 用户领取第二封邮件，触发重复补偿
  const claim2 = await userFn.main({ module: 'rewardMail', action: 'claimReward', data: { id: mail2._id } })
  assert.equal(claim2.ok, true)
  assert.equal(claim2.data.rewardClaimResult.petTitleOutcome, 'compensated')
  assert.equal(claim2.data.rewardClaimResult.pointsDelta, 40)

  // 背包记录依然只有 1 条
  const inventoryListAfter = db.state.user_pet_titles.filter((i) => i.openid === 'openid_user')
  assert.equal(inventoryListAfter.length, 1)

  // 积分增加 40
  const user = db.state.users.find((u) => u.openid === 'openid_user')
  assert.equal(user.points, 50)
})

test('petTitles: concurrent auth.me auto-grants guarantee single inventory record without duplication', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client_vip', openid: 'openid_client_vip', role: 'client', status: 'active', memberLevel: 'level_diamond', points: 300, totalPoints: 3000 }
    ],
    member_levels: [
      { _id: 'level_diamond', name: '钻石会员', minPoints: 2000, enabled: true }
    ],
    pet_titles: [
      {
        _id: 'title_vip_dog',
        name: '遛狗战神',
        icon: '⚡',
        duplicatePoints: 60,
        autoGrantLevelIds: ['level_diamond'],
        enabled: true
      }
    ],
    user_pet_titles: [],
    pet_title_grants: [],
    point_logs: []
  })

  const clientFn = loadCloudFunction('api', db, 'openid_client_vip')

  // 模拟并发两个请求同时调用 auth.me
  const [res1, res2] = await Promise.all([
    clientFn.main({ module: 'auth', action: 'me' }),
    clientFn.main({ module: 'auth', action: 'me' })
  ])

  assert.equal(res1.ok, true)
  assert.equal(res2.ok, true)

  // 验证 user_pet_titles 中严格只有 1 条记录
  const inventory = db.state.user_pet_titles.filter((i) => i.openid === 'openid_client_vip')
  assert.equal(inventory.length, 1)
  assert.equal(inventory[0].titleId, 'title_vip_dog')
  assert.ok(inventory[0]._id.startsWith('upt_'))
})

test('system: submitFeedback enforces content security on content, contactInfo, and mediaFileIds', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_user', openid: 'openid_user', roles: ['client'], status: 'active', nickname: '小猫咪' }
    ],
    user_feedback: []
  })

  const userFn = loadCloudFunction('api', db, 'openid_user', {
    security: securityMock,
    downloadFile: async ({ fileID }) => {
      if (fileID.includes('bad')) {
        return { fileContent: Buffer.from('bad_image_data') }
      }
      return { fileContent: Buffer.from('good_image_data') }
    }
  })

  // 1. 反馈内容包含敏感词被拦截
  const resBadContent = await userFn.main({
    module: 'system',
    action: 'submitFeedback',
    data: {
      content: '这个功能包含违规敏感词信息',
      contactInfo: '13800000000'
    }
  })
  assert.equal(resBadContent.ok, false)
  assert.match(resBadContent.error, /敏感|不合规|违规/)

  // 2. 联系方式包含敏感词被拦截
  const resBadContact = await userFn.main({
    module: 'system',
    action: 'submitFeedback',
    data: {
      content: '建议增加猫咪体重变化曲线图表',
      contactInfo: '加微信违规敏感词兼职'
    }
  })
  assert.equal(resBadContact.ok, false)
  assert.match(resBadContact.error, /敏感|不合规|违规/)

  // 3. 上传的附件图片包含违规数据被拦截
  const resBadImage = await userFn.main({
    module: 'system',
    action: 'submitFeedback',
    data: {
      content: '建议增加猫咪体重变化曲线图表',
      contactInfo: '13800000000',
      mediaFileIds: ['cloud://test/good.png', 'cloud://test/bad_pic.png']
    }
  })
  assert.equal(resBadImage.ok, false)
  assert.match(resBadImage.error, /敏感|不合规|违规/)

  // 4. 正常图文反馈顺利通过
  const resGood = await userFn.main({
    module: 'system',
    action: 'submitFeedback',
    data: {
      content: '服务非常专业，宠物很喜欢！希望增加定期复测提醒。',
      contactInfo: '13800000000',
      category: 'feature_request',
      mediaFileIds: ['cloud://test/good1.png', 'cloud://test/good2.png']
    }
  })
  assert.equal(resGood.ok, true)
  assert.ok(resGood.data._id)

  // 验证入库数据
  const saved = db.state.user_feedback.find((f) => f._id === resGood.data._id)
  assert.ok(saved)
  assert.equal(saved.content, '服务非常专业，宠物很喜欢！希望增加定期复测提醒。')
  assert.equal(saved.contactInfo, '13800000000')
  assert.equal(saved.category, 'feature_request')
  assert.equal(saved.mediaFileIds.length, 2)
  assert.equal(saved.status, 'pending')
})
