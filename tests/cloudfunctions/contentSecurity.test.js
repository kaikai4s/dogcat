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
