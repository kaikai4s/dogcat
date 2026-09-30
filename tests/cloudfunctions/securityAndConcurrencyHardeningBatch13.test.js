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

test('adminUsers: user deletion blocked when active mall orders exist, and detachUser includes mall_orders', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin1', openid: 'openid_admin1', roles: ['admin'], status: 'active' },
      { _id: 'u_admin2', openid: 'openid_admin2', roles: ['admin'], status: 'active' },
      { _id: 'u_client_mall', openid: 'openid_client_mall', roles: ['client'], status: 'active' },
      { _id: 'u_client_clean', openid: 'openid_client_clean', roles: ['client'], status: 'active' }
    ],
    orders: [],
    mall_orders: [
      {
        _id: 'mall_order_active',
        clientOpenid: 'openid_client_mall',
        status: 'shipped',
        paymentStatus: 'paid'
      },
      {
        _id: 'mall_order_historical',
        clientOpenid: 'openid_client_clean',
        status: 'completed',
        paymentStatus: 'paid'
      }
    ],
    order_incidents: [],
    withdraw_requests: [],
    staff_profiles: []
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin1', { security: securityMock })

  // 1. 用户有履约中商城订单，拒绝删除
  const deleteActiveRes = await adminFn.main({
    module: 'admin',
    action: 'deleteUser',
    data: { openid: 'openid_client_mall' }
  })
  assert.equal(deleteActiveRes.ok, false)
  assert.match(deleteActiveRes.error, /存在履约中或售后处理中的商城订单/)

  // 2. 用户无活动订单，成功彻底删除且历史商城订单执行脱敏脱钩
  const deleteCleanRes = await adminFn.main({
    module: 'admin',
    action: 'hardDeleteUser',
    data: { openid: 'openid_client_clean' }
  })
  assert.equal(deleteCleanRes.ok, true)

  const updatedMallOrder = await db.collection('mall_orders').doc('mall_order_historical').get()
  assert.equal(updatedMallOrder.data.clientOpenid, '')
  assert.equal(updatedMallOrder.data.deletedClientOpenid, 'openid_client_clean')
})

test('systemNotifications: sendSystemNotification text security and length limits', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' }
    ],
    system_notifications: []
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin', { security: securityMock })

  // 1. 标题超长拦截
  const longTitleRes = await adminFn.main({
    module: 'admin',
    action: 'sendSystemNotification',
    data: {
      title: 'T'.repeat(51),
      content: '正常通知内容'
    }
  })
  assert.equal(longTitleRes.ok, false)
  assert.match(longTitleRes.error, /通知标题不能超过 50 字/)

  // 2. 内容超长拦截
  const longContentRes = await adminFn.main({
    module: 'admin',
    action: 'sendSystemNotification',
    data: {
      title: '正常标题',
      content: 'C'.repeat(1001)
    }
  })
  assert.equal(longContentRes.ok, false)
  assert.match(longContentRes.error, /通知内容不能超过 1000 字/)

  // 3. 敏感词拦截
  const sensitiveRes = await adminFn.main({
    module: 'admin',
    action: 'sendSystemNotification',
    data: {
      title: '包含违规敏感词的通知',
      content: '请全体用户注意'
    }
  })
  assert.equal(sensitiveRes.ok, false)
  assert.match(sensitiveRes.error, /包含敏感或不合规信息/)

  // 4. 正常发送通知
  const normalRes = await adminFn.main({
    module: 'admin',
    action: 'sendSystemNotification',
    data: {
      title: '服务升级通知',
      content: '平台将于今晚进行系统维护升级。',
      target: 'all'
    }
  })
  assert.equal(normalRes.ok, true)
})

test('ai: generatePetVoice rate limiting', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'openid_client_ai', roles: ['client'], status: 'active' }
    ],
    pets: [
      { _id: 'pet_ai_1', openid: 'openid_client_ai', name: '汤圆', species: 'cat' }
    ]
  })

  const clientFn = loadCloudFunction('api', db, 'openid_client_ai', {
    security: securityMock,
    extend: {
      AI: {
        createModel: () => ({
          generateText: async () => ({ text: '今天阳光很好，主人出门安心工作吧！' })
        })
      }
    }
  })

  // 连续调用 10 次正常
  for (let i = 0; i < 10; i++) {
    const res = await clientFn.main({
      module: 'ai',
      action: 'generatePetVoice',
      data: { petId: 'pet_ai_1' }
    })
    assert.equal(res.ok, true)
  }

  // 第 11 次触发频次拦截
  const rateLimitRes = await clientFn.main({
    module: 'ai',
    action: 'generatePetVoice',
    data: { petId: 'pet_ai_1' }
  })
  assert.equal(rateLimitRes.ok, false)
  assert.match(rateLimitRes.error, /过于频繁/)
})

test('feedback: submitFeedback contactInfo limit & rate limiting, replyFeedback hardening', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      { _id: 'u_client', openid: 'openid_client_fb', roles: ['client'], status: 'active' }
    ],
    user_feedback: [
      {
        _id: 'fb_1',
        openid: 'openid_client_fb',
        content: '建议增加猫咪洗护服务',
        status: 'pending'
      }
    ]
  })

  const clientFn = loadCloudFunction('api', db, 'openid_client_fb', { security: securityMock })
  const adminFn = loadCloudFunction('api', db, 'openid_admin', { security: securityMock })

  // 1. 联系方式超长拦截
  const longContactRes = await clientFn.main({
    module: 'system',
    action: 'submitFeedback',
    data: {
      content: '很棒的平台',
      contactInfo: 'C'.repeat(101)
    }
  })
  assert.equal(longContactRes.ok, false)
  assert.match(longContactRes.error, /联系方式不能超过 100 字/)

  // 2. 反馈提交频次拦截
  for (let i = 0; i < 5; i++) {
    await clientFn.main({
      module: 'system',
      action: 'submitFeedback',
      data: { content: `反馈建议${i}` }
    })
  }
  const rateLimitFbRes = await clientFn.main({
    module: 'system',
    action: 'submitFeedback',
    data: { content: '又一条反馈' }
  })
  assert.equal(rateLimitFbRes.ok, false)
  assert.match(rateLimitFbRes.error, /过于频繁/)

  // 3. 管理员回复反馈：不存在的反馈记录
  const notFoundReplyRes = await adminFn.main({
    module: 'admin',
    action: 'replyFeedback',
    data: {
      id: 'fb_not_exist',
      replyContent: '收到建议'
    }
  })
  assert.equal(notFoundReplyRes.ok, false)
  assert.match(notFoundReplyRes.error, /反馈记录不存在/)

  // 4. 管理员回复超长拦截
  const longReplyRes = await adminFn.main({
    module: 'admin',
    action: 'replyFeedback',
    data: {
      id: 'fb_1',
      replyContent: 'R'.repeat(1001)
    }
  })
  assert.equal(longReplyRes.ok, false)
  assert.match(longReplyRes.error, /回复内容不能超过 1000 字/)

  // 5. 管理员回复敏感词拦截
  const sensitiveReplyRes = await adminFn.main({
    module: 'admin',
    action: 'replyFeedback',
    data: {
      id: 'fb_1',
      replyContent: '包含违规敏感词的回复'
    }
  })
  assert.equal(sensitiveReplyRes.ok, false)
  assert.match(sensitiveReplyRes.error, /包含敏感或不合规信息/)
})

test('admin: grantPoints delta bounds, reason length and text security', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      { _id: 'u_user', openid: 'openid_user_pts', roles: ['client'], status: 'active', points: 100 }
    ],
    point_logs: []
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin', { security: securityMock })

  // 1. 积分超出单笔上限（> 50000）
  const tooManyPointsRes = await adminFn.main({
    module: 'admin',
    action: 'grantPoints',
    data: {
      openid: 'openid_user_pts',
      delta: 50001,
      reason: '系统赠送'
    }
  })
  assert.equal(tooManyPointsRes.ok, false)
  assert.match(tooManyPointsRes.error, /单次积分调整幅度不能超过 50000 分/)

  // 2. 积分超出单笔下限（< -50000）
  const tooFewPointsRes = await adminFn.main({
    module: 'admin',
    action: 'grantPoints',
    data: {
      openid: 'openid_user_pts',
      delta: -50001,
      reason: '惩罚扣减'
    }
  })
  assert.equal(tooFewPointsRes.ok, false)
  assert.match(tooFewPointsRes.error, /单次积分调整幅度不能超过 50000 分/)

  // 3. 原因超长拦截
  const longReasonRes = await adminFn.main({
    module: 'admin',
    action: 'grantPoints',
    data: {
      openid: 'openid_user_pts',
      delta: 10,
      reason: 'R'.repeat(201)
    }
  })
  assert.equal(longReasonRes.ok, false)
  assert.match(longReasonRes.error, /操作原因不能超过 200 字/)

  // 4. 原因敏感词拦截
  const sensitiveReasonRes = await adminFn.main({
    module: 'admin',
    action: 'grantPoints',
    data: {
      openid: 'openid_user_pts',
      delta: 10,
      reason: '违规敏感词发放原因'
    }
  })
  assert.equal(sensitiveReasonRes.ok, false)
  assert.match(sensitiveReasonRes.error, /包含敏感或不合规信息/)
})

test('mall: normalizeShippingAddress field length validations', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'openid_client_mall2', roles: ['client'], status: 'active', phone: '13800000000' }
    ],
    mall_products: [
      {
        _id: 'prod_1',
        name: '冻干零食',
        status: 'on_sale',
        stock: 100,
        price: 50,
        skus: [{ skuId: 'default', status: 'on_sale', stock: 100, price: 50 }]
      }
    ],
    mall_orders: []
  })

  const clientFn = loadCloudFunction('api', db, 'openid_client_mall2', { security: securityMock })

  // 1. 收货人超长
  const longReceiverRes = await clientFn.main({
    module: 'mall',
    action: 'createOrder',
    data: {
      productId: 'prod_1',
      skuId: 'default',
      quantity: 1,
      shippingAddress: {
        contactName: 'N'.repeat(31),
        contactPhone: '13800000000',
        serviceAddress: '某某小区',
        addressDetail: '1栋101'
      }
    }
  })
  assert.equal(longReceiverRes.ok, false)
  assert.match(longReceiverRes.error, /收货人姓名不能超过 30 字/)

  // 2. 手机号超长
  const longPhoneRes = await clientFn.main({
    module: 'mall',
    action: 'createOrder',
    data: {
      productId: 'prod_1',
      skuId: 'default',
      quantity: 1,
      shippingAddress: {
        contactName: '张三',
        contactPhone: '1'.repeat(21),
        serviceAddress: '某某小区',
        addressDetail: '1栋101'
      }
    }
  })
  assert.equal(longPhoneRes.ok, false)
  assert.match(longPhoneRes.error, /收货手机号格式不正确/)

  // 3. 详细地址超长
  const longDetailRes = await clientFn.main({
    module: 'mall',
    action: 'createOrder',
    data: {
      productId: 'prod_1',
      skuId: 'default',
      quantity: 1,
      shippingAddress: {
        contactName: '张三',
        contactPhone: '13800000000',
        serviceAddress: '某某小区',
        addressDetail: 'D'.repeat(201)
      }
    }
  })
  assert.equal(longDetailRes.ok, false)
  assert.match(longDetailRes.error, /详细地址不能超过 200 字/)
})

test('incident: createSosIncident, createComplaint, comments and evidence length limits', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_staff', openid: 'openid_staff_inc', roles: ['staff'], status: 'active' },
      { _id: 'u_client', openid: 'openid_client_inc', roles: ['client'], status: 'active' }
    ],
    orders: [
      {
        _id: 'order_inc_1',
        orderNo: 'ORD_INC_1',
        clientOpenid: 'openid_client_inc',
        staffOpenid: 'openid_staff_inc',
        status: 'in_service'
      }
    ],
    order_incidents: [
      {
        _id: 'inc_existing',
        orderId: 'order_inc_1',
        clientOpenid: 'openid_client_inc',
        staffOpenid: 'openid_staff_inc',
        status: 'open'
      }
    ],
    incident_comments: [],
    incident_actions: []
  })

  const staffFn = loadCloudFunction('api', db, 'openid_staff_inc', { security: securityMock })
  const clientFn = loadCloudFunction('api', db, 'openid_client_inc', { security: securityMock })

  // 1. SOS 求助说明超长
  const longSosRes = await staffFn.main({
    module: 'incident',
    action: 'createSosIncident',
    data: {
      orderId: 'order_inc_1',
      description: 'S'.repeat(501)
    }
  })
  assert.equal(longSosRes.ok, false)
  assert.match(longSosRes.error, /SOS求助说明不能超过 500 字/)

  // 2. 投诉说明超长
  const longComplaintRes = await clientFn.main({
    module: 'incident',
    action: 'createComplaint',
    data: {
      orderId: 'order_inc_1',
      title: '服务投诉',
      description: 'C'.repeat(1001)
    }
  })
  assert.equal(longComplaintRes.ok, false)
  assert.match(longComplaintRes.error, /投诉说明不能超过 1000 字/)

  // 3. 留言内容超长
  const longCommentRes = await clientFn.main({
    module: 'incident',
    action: 'appendIncidentComment',
    data: {
      incidentId: 'inc_existing',
      content: 'M'.repeat(501)
    }
  })
  assert.equal(longCommentRes.ok, false)
  assert.match(longCommentRes.error, /留言内容不能超过 500 字/)

  // 4. 补充证据备注超长
  const longEvidenceRes = await clientFn.main({
    module: 'incident',
    action: 'uploadIncidentEvidence',
    data: {
      incidentId: 'inc_existing',
      remark: 'R'.repeat(201)
    }
  })
  assert.equal(longEvidenceRes.ok, false)
  assert.match(longEvidenceRes.error, /证据备注不能超过 200 字/)
})
