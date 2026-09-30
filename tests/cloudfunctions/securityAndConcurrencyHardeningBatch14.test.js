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

// ========== auth.updateProfile ==========

test('auth.updateProfile: 非法手机号格式被拒', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_u1', status: 'active', roles: ['client'] }]
  })
  const fn = loadCloudFunction('api', db, 'openid_u1', { security: securityMock })
  const res = await fn.main({ module: 'auth', action: 'updateProfile', data: { nickname: '测试', phone: '123abc' } })
  assert.equal(res.ok, false)
  assert.match(res.error, /手机号格式不正确/)

  const resInvalidSegment = await fn.main({ module: 'auth', action: 'updateProfile', data: { nickname: '测试', phone: '11112345678' } })
  assert.equal(resInvalidSegment.ok, false)
  assert.match(resInvalidSegment.error, /手机号格式不正确/)
})

test('auth.updateProfile: 有效11位手机号可通过', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_u1b', status: 'active', roles: ['client'] }]
  })
  const fn = loadCloudFunction('api', db, 'openid_u1b', { security: securityMock })
  const res = await fn.main({ module: 'auth', action: 'updateProfile', data: { nickname: '测试', phone: '13812345678' } })
  assert.equal(res.ok, true)
})

test('auth.updateProfile: 频率限制生效', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_rate', status: 'active', roles: ['client'] }]
  })
  const fn = loadCloudFunction('api', db, 'openid_rate', { security: securityMock })
  // rate limit is 15/min
  for (let i = 0; i < 15; i++) {
    await fn.main({ module: 'auth', action: 'updateProfile', data: { nickname: `n${i}` } })
  }
  const res = await fn.main({ module: 'auth', action: 'updateProfile', data: { nickname: 'overflow' } })
  assert.equal(res.ok, false)
  assert.match(res.error, /频繁|限制/)
})

// ========== homeSecurity.saveHomeSecurity ==========

test('homeSecurity.saveHomeSecurity: 字段长度超限被拒', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_hs1', status: 'active', roles: ['client'] }],
    orders: [{ _id: 'order_hs1', clientOpenid: 'openid_hs1', status: 'accepted' }]
  })
  const fn = loadCloudFunction('api', db, 'openid_hs1', { security: securityMock })
  const res = await fn.main({
    module: 'homeSecurity',
    action: 'saveHomeSecurity',
    data: { orderId: 'order_hs1', doorLockCode: 'x'.repeat(51) }
  })
  assert.equal(res.ok, false)
  assert.match(res.error, /门锁密码/)
})

test('homeSecurity.saveHomeSecurity: emergencyContactPhone格式验证', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_hs2', status: 'active', roles: ['client'] }],
    orders: [{ _id: 'order_hs2', clientOpenid: 'openid_hs2', status: 'accepted' }]
  })
  const fn = loadCloudFunction('api', db, 'openid_hs2', { security: securityMock })
  const res = await fn.main({
    module: 'homeSecurity',
    action: 'saveHomeSecurity',
    data: { orderId: 'order_hs2', emergencyContactPhone: 'abc12345' }
  })
  assert.equal(res.ok, false)
  assert.match(res.error, /紧急联系电话格式不正确/)
})

// ========== homeSecurity.updateOrderOneTimeCode ==========

test('homeSecurity.updateOrderOneTimeCode: code长度超限被拒', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'openid_otc1', status: 'active', roles: ['client'] },
      { _id: 'u_staff', openid: 'openid_staff_otc', status: 'active', roles: ['staff'] }
    ],
    orders: [{ _id: 'order_otc1', clientOpenid: 'openid_otc1', staffOpenid: 'openid_staff_otc', status: 'in_service' }],
    order_home_security: [{ _id: 'ohs_1', orderId: 'order_otc1', clientOpenid: 'openid_otc1' }]
  })
  const fn = loadCloudFunction('api', db, 'openid_otc1', { security: securityMock })
  const res = await fn.main({
    module: 'homeSecurity',
    action: 'updateOrderOneTimeCode',
    data: { orderId: 'order_otc1', code: 'x'.repeat(51) }
  })
  assert.equal(res.ok, false)
  assert.match(res.error, /一次性密码/)
})

// ========== staff.submitTrainingQuiz: rate limit ==========

test('staff.submitTrainingQuiz: 频率限制生效', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u_staff', openid: 'openid_quiz_rate', status: 'active', roles: ['staff'] }],
    staff_profiles: [{ _id: 'sp_1', openid: 'openid_quiz_rate', auditStatus: 'approved' }],
    system_settings: []
  })
  const fn = loadCloudFunction('api', db, 'openid_quiz_rate', { security: securityMock })
  // 连续提交3次用尽额度
  for (let i = 0; i < 3; i++) {
    await fn.main({ module: 'staff', action: 'submitTrainingQuiz', data: { answers: {} } })
  }
  const res = await fn.main({ module: 'staff', action: 'submitTrainingQuiz', data: { answers: {} } })
  assert.equal(res.ok, false)
  assert.match(res.error, /频繁|限制/)
})

// ========== staff.markTrainingVideoWatched: server-side duration ==========

test('staff.markTrainingVideoWatched: 频率限制生效', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u_staff', openid: 'openid_vid_rate', status: 'active', roles: ['staff'] }],
    staff_profiles: [{ _id: 'sp_1', openid: 'openid_vid_rate', auditStatus: 'approved' }],
    system_settings: []
  })
  const fn = loadCloudFunction('api', db, 'openid_vid_rate', { security: securityMock })
  // 快速调用10次
  for (let i = 0; i < 10; i++) {
    await fn.main({
      module: 'staff',
      action: 'markTrainingVideoWatched',
      data: { videoKey: 'platform_rules', watchedSeconds: 300, duration: 300 }
    })
  }
  const res = await fn.main({
    module: 'staff',
    action: 'markTrainingVideoWatched',
    data: { videoKey: 'platform_rules', watchedSeconds: 300, duration: 300 }
  })
  assert.equal(res.ok, false)
  assert.match(res.error, /频繁|限制/)
})

test('staff.markTrainingVideoWatched: 观看时长不达标被拒', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u_staff', openid: 'openid_vid_dur', status: 'active', roles: ['staff'] }],
    staff_profiles: [{ _id: 'sp_1', openid: 'openid_vid_dur', auditStatus: 'approved' }],
    system_settings: []
  })
  const fn = loadCloudFunction('api', db, 'openid_vid_dur', { security: securityMock })
  // 伪造很短的客户端视频时长，服务端应按配置的“约 5 分钟”校验
  const res = await fn.main({
    module: 'staff',
    action: 'markTrainingVideoWatched',
    data: { videoKey: 'platform_rules', watchedSeconds: 10, duration: 10 }
  })
  assert.equal(res.ok, false)
  assert.match(res.error, /全程完整观看|未达标/)
})

// ========== pet.recognizePetBreed ==========

test('pet.recognizePetBreed: imageBase64过大被拒', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_pet1', status: 'active', roles: ['client'] }],
    system_settings: [{ _id: 'settings', key: 'system_settings', enablePetBreedAi: true }]
  })
  const fn = loadCloudFunction('api', db, 'openid_pet1', { security: securityMock })
  const res = await fn.main({
    module: 'pet',
    action: 'recognizePetBreed',
    data: { imageBase64: 'a'.repeat(2500001) }
  })
  assert.equal(res.ok, false)
  assert.match(res.error, /图片数据过大/)
})

test('pet.recognizePetBreed: 频率限制生效', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_pet_rate', status: 'active', roles: ['client'] }],
    system_settings: [{ _id: 'settings', key: 'system_settings', enablePetBreedAi: false }]
  })
  const fn = loadCloudFunction('api', db, 'openid_pet_rate', { security: securityMock })
  // enablePetBreedAi=false 会先抛 "AI 识别功能已关闭"，但rate limit在更前面
  for (let i = 0; i < 10; i++) {
    await fn.main({ module: 'pet', action: 'recognizePetBreed', data: { imageBase64: 'abc' } })
  }
  const res = await fn.main({ module: 'pet', action: 'recognizePetBreed', data: { imageBase64: 'abc' } })
  assert.equal(res.ok, false)
  assert.match(res.error, /频繁|AI识别请求/)
})

// ========== admin.publishRewardMailByLevels: points cap ==========

test('admin.publishRewardMailByLevels: 积分超过50000被拒', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u_admin', openid: 'openid_admin_pts', status: 'active', roles: ['admin'] }],
    member_levels: [{ _id: 'lv1', name: '银牌会员', minPoints: 0, maxPoints: 999 }]
  })
  const fn = loadCloudFunction('api', db, 'openid_admin_pts', { security: securityMock })
  const res = await fn.main({
    module: 'admin',
    action: 'publishRewardMailByLevels',
    data: { targetLevelIds: ['lv1'], rewardType: 'points', points: 60000, title: '测试', content: '内容' }
  })
  assert.equal(res.ok, false)
  assert.match(res.error, /不能超过 50000/)
})

test('admin.publishRewardMailByLevels: 合理积分可通过', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin_pts2', status: 'active', roles: ['admin'] },
      { _id: 'u_client', openid: 'openid_client_pts', status: 'active', roles: ['client'], memberLevel: 'lv1' }
    ],
    member_levels: [{ _id: 'lv1', name: '银牌会员', minPoints: 0, maxPoints: 999 }],
    reward_mails: []
  })
  const fn = loadCloudFunction('api', db, 'openid_admin_pts2', { security: securityMock })
  const res = await fn.main({
    module: 'admin',
    action: 'publishRewardMailByLevels',
    data: { targetLevelIds: ['lv1'], rewardType: 'points', points: 500, title: '测试', content: '内容' }
  })
  assert.equal(res.ok, true)
  assert.equal(res.data.issued, 1)
})

// ========== adminMall.shipOrder ==========

test('adminMall.shipOrder: 退款申请中不可发货', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u_admin', openid: 'openid_admin_ship', status: 'active', roles: ['admin'] }],
    mall_orders: [{ _id: 'mo1', status: 'pending_ship', refundStatus: 'applied', paymentStatus: 'paid' }]
  })
  const fn = loadCloudFunction('api', db, 'openid_admin_ship', { security: securityMock })
  const res = await fn.main({
    module: 'adminMall',
    action: 'shipOrder',
    data: { orderId: 'mo1', expressCompany: '顺丰', trackingNo: 'SF123456' }
  })
  assert.equal(res.ok, false)
  assert.match(res.error, /退款申请/)
})

test('adminMall.shipOrder: 快递公司名称超限被拒', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u_admin', openid: 'openid_admin_ship2', status: 'active', roles: ['admin'] }],
    mall_orders: [{ _id: 'mo2', status: 'pending_ship', paymentStatus: 'paid' }]
  })
  const fn = loadCloudFunction('api', db, 'openid_admin_ship2', { security: securityMock })
  const res = await fn.main({
    module: 'adminMall',
    action: 'shipOrder',
    data: { orderId: 'mo2', expressCompany: 'x'.repeat(51), trackingNo: 'SF123' }
  })
  assert.equal(res.ok, false)
  assert.match(res.error, /快递公司名称/)
})

test('adminMall.shipOrder: 正常发货成功', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u_admin', openid: 'openid_admin_ship3', status: 'active', roles: ['admin'] }],
    mall_orders: [{ _id: 'mo3', status: 'pending_ship', paymentStatus: 'paid' }],
    admin_logs: []
  })
  const fn = loadCloudFunction('api', db, 'openid_admin_ship3', { security: securityMock })
  const res = await fn.main({
    module: 'adminMall',
    action: 'shipOrder',
    data: { orderId: 'mo3', expressCompany: '顺丰', trackingNo: 'SF123456789' }
  })
  assert.equal(res.ok, true)
  assert.equal(res.data.status, 'shipped')
})

test('adminMall.shipOrder: 快递信息含违规内容被拒', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u_admin', openid: 'openid_admin_ship4', status: 'active', roles: ['admin'] }],
    mall_orders: [{ _id: 'mo4', status: 'pending_ship', paymentStatus: 'paid' }]
  })
  const fn = loadCloudFunction('api', db, 'openid_admin_ship4', { security: securityMock })
  const res = await fn.main({
    module: 'adminMall',
    action: 'shipOrder',
    data: { orderId: 'mo4', expressCompany: '违规敏感词快递', trackingNo: 'SF123' }
  })
  assert.equal(res.ok, false)
  assert.match(res.error, /敏感|不合规|违法违规/)
})

// ========== order.sendOrderSessionMessage: rate limit ==========

test('order.sendOrderSessionMessage: 频率限制生效', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'openid_msg_rate', status: 'active', roles: ['client'] },
      { _id: 'u_staff', openid: 'openid_staff_msg', status: 'active', roles: ['staff'] }
    ],
    orders: [{ _id: 'ord_msg', clientOpenid: 'openid_msg_rate', staffOpenid: 'openid_staff_msg', clientUserId: 'u_client', staffUserId: 'u_staff', status: 'in_service' }],
    order_session_messages: []
  })
  const fn = loadCloudFunction('api', db, 'openid_msg_rate', { security: securityMock })
  // 发送30条消息用完额度
  for (let i = 0; i < 30; i++) {
    await fn.main({ module: 'order', action: 'sendOrderSessionMessage', data: { orderId: 'ord_msg', content: `消息${i}` } })
  }
  const res = await fn.main({ module: 'order', action: 'sendOrderSessionMessage', data: { orderId: 'ord_msg', content: '超出' } })
  assert.equal(res.ok, false)
  assert.match(res.error, /频繁|限制/)
})

// ========== addresses.saveUserAddress: phone format ==========

test('addresses.saveUserAddress: 非法手机号被拒', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_addr1', status: 'active', roles: ['client'] }],
    user_addresses: []
  })
  const fn = loadCloudFunction('api', db, 'openid_addr1', { security: securityMock })
  const res = await fn.main({
    module: 'client',
    action: 'saveAddress',
    data: {
      serviceAddress: '北京市海淀区',
      addressDetail: '某小区1号楼',
      doorplate: '101室',
      contactName: '张三',
      contactPhone: 'abc123'
    }
  })
  assert.equal(res.ok, false)
  assert.match(res.error, /联系电话格式不正确/)
})

test('addresses.saveUserAddress: 有效手机号可通过', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_addr2', status: 'active', roles: ['client'] }],
    user_addresses: []
  })
  const fn = loadCloudFunction('api', db, 'openid_addr2', { security: securityMock })
  const res = await fn.main({
    module: 'client',
    action: 'saveAddress',
    data: {
      serviceAddress: '北京市海淀区',
      addressDetail: '某小区1号楼',
      doorplate: '101室',
      contactName: '张三',
      contactPhone: '13812345678'
    }
  })
  assert.equal(res.ok, true)
})

test('addresses.saveUserAddress: 座机号可通过', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_addr3', status: 'active', roles: ['client'] }],
    user_addresses: []
  })
  const fn = loadCloudFunction('api', db, 'openid_addr3', { security: securityMock })
  const res = await fn.main({
    module: 'client',
    action: 'saveAddress',
    data: {
      serviceAddress: '北京市海淀区',
      addressDetail: '某小区1号楼',
      doorplate: '101室',
      contactName: '张三',
      contactPhone: '010-12345678'
    }
  })
  assert.equal(res.ok, true)
})

test('addresses.saveUserAddress: 空手机号可通过（非必填）', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u1', openid: 'openid_addr4', status: 'active', roles: ['client'] }],
    user_addresses: []
  })
  const fn = loadCloudFunction('api', db, 'openid_addr4', { security: securityMock })
  const res = await fn.main({
    module: 'client',
    action: 'saveAddress',
    data: {
      serviceAddress: '北京市海淀区',
      addressDetail: '某小区1号楼',
      doorplate: '101室',
      contactName: '张三',
      contactPhone: ''
    }
  })
  assert.equal(res.ok, true)
})
