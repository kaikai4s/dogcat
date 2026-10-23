const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('UGC text security: checkTextSecurity blocks risky text and allows safe text', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active' }]
  })

  // 模拟微信安全审核 API：检测到违规词抛出 87014
  const securityMock = {
    async msgSecCheck({ content }) {
      if (content.includes('违禁词') || content.includes('敏感内容')) {
        const error = new Error('risky content')
        error.errCode = 87014
        throw error
      }
      return { errCode: 0, result: { suggest: 'pass', label: 100 } }
    },
    async imgSecCheck({ media }) {
      if (media && media.value && media.value.toString().includes('bad-image')) {
        const error = new Error('risky image')
        error.errCode = 87014
        throw error
      }
      return { errCode: 0, result: { suggest: 'pass', label: 100 } }
    }
  }

  const fn = loadCloudFunction('api', db, 'openid_client', {
    security: securityMock,
    downloadFile: async ({ fileID }) => ({
      fileContent: fileID.includes('bad') ? Buffer.from('bad-image-buffer') : Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
    })
  })

  // 1. 直接通过系统 action 测试文本安全检测
  const safeTextResult = await fn.main({
    module: 'system',
    action: 'checkTextSecurity',
    data: { content: '小狗很活泼可爱，服务很满意' }
  })
  assert.equal(safeTextResult.ok, true)
  assert.equal(safeTextResult.data.pass, true)

  const riskyTextResult = await fn.main({
    module: 'system',
    action: 'checkTextSecurity',
    data: { content: '这里包含敏感内容测试' }
  })
  assert.equal(riskyTextResult.ok, false)
  assert.match(riskyTextResult.message, /包含敏感或不合规信息/)

  // 2. 直接通过系统 action 测试图片安全检测
  const safeImgResult = await fn.main({
    module: 'system',
    action: 'checkImageSecurity',
    data: { fileId: 'cloud://dog_photo.jpg' }
  })
  assert.equal(safeImgResult.ok, true)

  const riskyImgResult = await fn.main({
    module: 'system',
    action: 'checkImageSecurity',
    data: { fileId: 'cloud://bad_photo.jpg' }
  })
  assert.equal(riskyImgResult.ok, false)
  assert.match(riskyImgResult.message, /包含违规敏感内容/)
})

test('UGC review security: createReview checks content and tags against WeChat security', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', roles: ['client'], status: 'active' }],
    staff_profiles: [{ _id: 'sp1', openid: 'openid_staff', auditStatus: 'approved' }],
    orders: [{ _id: 'o_completed', clientOpenid: 'openid_client', staffOpenid: 'openid_staff', staffProfileId: 'sp1', status: 'completed' }]
  })

  const securityMock = {
    async msgSecCheck({ content }) {
      if (content.includes('违禁词')) {
        const error = new Error('risky content')
        error.errCode = 87014
        throw error
      }
      return { errCode: 0, result: { suggest: 'pass', label: 100 } }
    }
  }

  const clientFn = loadCloudFunction('api', db, 'openid_client', { security: securityMock })

  // 违规评价内容被拦截
  const riskyReview = await clientFn.main({
    module: 'order',
    action: 'createReview',
    data: { orderId: 'o_completed', rating: 5, content: '服务含有违禁词内容' }
  })
  assert.equal(riskyReview.ok, false)
  assert.match(riskyReview.message, /评价内容包含敏感或不合规信息/)

  // 合规评价内容正常保存
  const safeReview = await clientFn.main({
    module: 'order',
    action: 'createReview',
    data: { orderId: 'o_completed', rating: 5, tags: ['非常准时', '专业细致'], content: '宠托师非常尽责，小猫很喜欢！' }
  })
  assert.equal(safeReview.ok, true)
  assert.equal(safeReview.data.rating, 5)
  assert.equal(safeReview.data.content, '宠托师非常尽责，小猫很喜欢！')
})

test('UGC feedback & profile & pet: user feedback, nickname and pet details audited', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_client', nickname: '正常用户', roles: ['client'], status: 'active' }],
    pets: []
  })

  const securityMock = {
    async msgSecCheck({ content }) {
      if (content.includes('广告垃圾信息') || content.includes('违禁昵称') || content.includes('违规宠物名')) {
        return { errCode: 0, result: { suggest: 'risky', label: 20001 } }
      }
      return { errCode: 0, result: { suggest: 'pass', label: 100 } }
    }
  }

  const fn = loadCloudFunction('api', db, 'openid_client', { security: securityMock })

  // 1. 用户反馈拦截
  const riskyFeedback = await fn.main({
    module: 'system',
    action: 'submitFeedback',
    data: { content: '加微信看最新广告垃圾信息' }
  })
  assert.equal(riskyFeedback.ok, false)
  assert.match(riskyFeedback.message, /反馈内容包含敏感或不合规信息/)

  // 2. 用户修改昵称拦截
  const riskyProfile = await fn.main({
    module: 'auth',
    action: 'updateProfile',
    data: { nickname: '违禁昵称测试' }
  })
  assert.equal(riskyProfile.ok, false)
  assert.match(riskyProfile.message, /用户昵称包含敏感或不合规信息/)

  // 3. 宠物资料拦截
  const riskyPet = await fn.main({
    module: 'pet',
    action: 'createPet',
    data: { name: '违规宠物名', avatarFileId: 'cloud://pet.jpg', species: 'dog', breed: '金毛' }
  })
  assert.equal(riskyPet.ok, false)
  assert.match(riskyPet.message, /宠物资料包含敏感或不合规信息/)

  // 4. 合规宠物资料创建成功
  const safePet = await fn.main({
    module: 'pet',
    action: 'createPet',
    data: { name: '布丁', avatarFileId: 'cloud://pet.jpg', species: 'cat', breed: '英短蓝猫' }
  })
  assert.equal(safePet.ok, true)
  assert.equal(safePet.data.name, '布丁')
})

const createSecurity = require('../../cloudfunctions/api/services/contentSecurity')
const safeText = value => String(value || '')
function securityService(security, extra = {}) {
  return createSecurity({ safeText, cloud: { openapi: { security }, downloadFile: async () => ({ fileContent: Buffer.from('image') }), ...extra } })
}

test('text security fails closed for missing services, timeouts, bad codes and review verdicts', async () => {
  for (const security of [undefined, {},
    { msgSecCheck: async () => { throw new Error('network timeout') } },
    { msgSecCheck: async () => ({ errCode: 40001 }) },
    { msgSecCheck: async () => ({ errCode: 0 }) },
    { msgSecCheck: async () => ({ result: { suggest: 'review' } }) }
  ]) await assert.rejects(securityService(security).checkTextSecurity('user', '待发布昵称'), /暂未通过安全检测/)
})

test('image publication requires a synchronous verdict and never treats an async task as approval', async () => {
  let submissions = 0
  const service = securityService({ mediaCheckAsync: async () => { submissions++; return { traceId: 'pending' } } })
  await assert.rejects(service.checkImageSecurity('user', 'cloud://picture.png'), /暂未通过安全检测/)
  assert.equal(submissions, 0)
  for (const result of [null, {}, { errCode: 40001 }, { result: { suggest: 'review' } }]) {
    await assert.rejects(securityService({ imgSecCheck: async () => result }).checkImageSecurity('user', 'cloud://picture.png'), /暂未通过安全检测/)
  }
  await assert.rejects(securityService({ imgSecCheck: async () => ({ errCode: 0 }) }, { downloadFile: async () => { throw new Error('download failed') } }).checkImageSecurity('user', 'cloud://picture.png'), /暂未通过安全检测/)
})

test('detection outages cannot update an existing public profile', async () => {
  const db = createCollectionStore({ users: [{ _id: 'u1', openid: 'user', nickname: '原昵称', avatarUrl: '', roles: ['client'], status: 'active' }] })
  const fn = loadCloudFunction('api', db, 'user', { security: { msgSecCheck: async () => { throw new Error('timeout') } } })
  const result = await fn.main({ module: 'auth', action: 'updateProfile', data: { nickname: '新昵称' } })
  assert.equal(result.ok, false)
  assert.equal(db.state.users[0].nickname, '原昵称')
})

test('synchronous image safety detects PNG content type and accepts legacy errCode zero', async () => {
  let type
  const service = securityService({ imgSecCheck: async ({ media }) => { type = media.contentType; return { errCode: 0 } } },
    { downloadFile: async () => ({ fileContent: Buffer.from([137, 80, 78, 71]) }) })
  assert.equal((await service.checkImageSecurity('user', 'cloud://picture.png')).pass, true)
  assert.equal(type, 'image/png')
})

test('explicit login records the current agreement version using server time', async () => {
  const db = createCollectionStore({ users: [] })
  const fn = loadCloudFunction('api', db, 'user')
  const result = await fn.main({ module: 'auth', action: 'login', data: { agreementVersion: '2026-10-23', acceptedAt: 'client-time' } })
  assert.equal(result.ok, true)
  assert.equal(db.state.users[0].loginAgreementVersion, '2026-10-23')
  assert.ok(db.state.users[0].loginAgreementAcceptedAt)
  assert.notEqual(db.state.users[0].loginAgreementAcceptedAt, 'client-time')
})

test('oversized images receive an actionable error before calling the content API', async () => {
  let calls = 0
  const service = securityService({ imgSecCheck: async () => { calls++; return { errCode: 0 } } },
    { downloadFile: async () => ({ fileContent: Buffer.alloc(1024 * 1024 + 1) }) })
  await assert.rejects(service.checkImageSecurity('user', 'cloud://too-large.jpg'), /压缩后重新上传/)
  assert.equal(calls, 0)
})
