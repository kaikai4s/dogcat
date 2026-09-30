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

test('addresses: user address count limit (max 20) and field length validations', async () => {
  const addresses = []
  for (let i = 1; i <= 20; i++) {
    addresses.push({
      _id: `addr_${i}`,
      openid: 'openid_client_addr',
      label: `地址${i}`,
      serviceAddress: `服务小区${i}`,
      addressDetail: `${i}号楼`,
      doorplate: `${i}01室`,
      isDefault: i === 1
    })
  }

  const db = createCollectionStore({
    users: [
      { _id: 'u_client_addr', openid: 'openid_client_addr', roles: ['client'], status: 'active' }
    ],
    user_addresses: addresses
  })

  const clientFn = loadCloudFunction('api', db, 'openid_client_addr', { security: securityMock })

  // 1. 超出 20 个地址上限时拦截添加
  const addExceededRes = await clientFn.main({
    module: 'client',
    action: 'saveAddress',
    data: {
      label: '新地址21',
      serviceAddress: '某某小区21',
      addressDetail: '21栋',
      doorplate: '2101'
    }
  })
  assert.equal(addExceededRes.ok, false)
  assert.match(addExceededRes.error, /最多保存 20 个服务地址/)

  // 2. 修改现有地址不受上限限制
  const updateExistingRes = await clientFn.main({
    module: 'client',
    action: 'saveAddress',
    data: {
      id: 'addr_1',
      label: '修改地址1',
      serviceAddress: '新服务小区1',
      addressDetail: '1栋',
      doorplate: '101'
    }
  })
  assert.equal(updateExistingRes.ok, true)

  // 3. 字段超长拦截测试
  const longLabelRes = await clientFn.main({
    module: 'client',
    action: 'saveAddress',
    data: {
      id: 'addr_1',
      label: 'A'.repeat(21),
      serviceAddress: '正常小区',
      addressDetail: '1栋',
      doorplate: '101'
    }
  })
  assert.equal(longLabelRes.ok, false)
  assert.match(longLabelRes.error, /地址标签不能超过 20 字/)

  const longContactNameRes = await clientFn.main({
    module: 'client',
    action: 'saveAddress',
    data: {
      id: 'addr_1',
      contactName: 'N'.repeat(31),
      serviceAddress: '正常小区',
      addressDetail: '1栋',
      doorplate: '101'
    }
  })
  assert.equal(longContactNameRes.ok, false)
  assert.match(longContactNameRes.error, /联系人姓名不能超过 30 字/)

  const longPhoneRes = await clientFn.main({
    module: 'client',
    action: 'saveAddress',
    data: {
      id: 'addr_1',
      contactPhone: '1'.repeat(21),
      serviceAddress: '正常小区',
      addressDetail: '1栋',
      doorplate: '101'
    }
  })
  assert.equal(longPhoneRes.ok, false)
  assert.match(longPhoneRes.error, /联系电话格式不正确/)

  const longDoorplateRes = await clientFn.main({
    module: 'client',
    action: 'saveAddress',
    data: {
      id: 'addr_1',
      serviceAddress: '正常小区',
      addressDetail: '1栋',
      doorplate: 'D'.repeat(101)
    }
  })
  assert.equal(longDoorplateRes.ok, false)
  assert.match(longDoorplateRes.error, /门牌号或入户说明不能超过 100 字/)

  const longAddressDetailRes = await clientFn.main({
    module: 'client',
    action: 'saveAddress',
    data: {
      id: 'addr_1',
      serviceAddress: '正常小区',
      addressDetail: 'A'.repeat(201),
      doorplate: '101'
    }
  })
  assert.equal(longAddressDetailRes.ok, false)
  assert.match(longAddressDetailRes.error, /详细地址不能超过 200 字/)
})

test('payment: createRefund reason length and text security validation', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active' }
    ],
    orders: [
      {
        _id: 'order_refund_test',
        clientOpenid: 'openid_client',
        payAmount: 100,
        status: 'in_service',
        paymentStatus: 'paid'
      }
    ],
    payments: [
      {
        _id: 'pay_1',
        orderId: 'order_refund_test',
        openid: 'openid_client',
        amount: 100,
        status: 'paid'
      }
    ],
    refunds: []
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin', { security: securityMock })

  // 1. 退款原因超长拦截
  const longReasonRes = await adminFn.main({
    module: 'payment',
    action: 'createRefund',
    data: {
      orderId: 'order_refund_test',
      refundAmount: 50,
      reason: 'R'.repeat(201)
    }
  })
  assert.equal(longReasonRes.ok, false)
  assert.match(longReasonRes.error, /退款原因不能超过 200 字/)

  // 2. 退款原因违规敏感词拦截
  const sensitiveReasonRes = await adminFn.main({
    module: 'payment',
    action: 'createRefund',
    data: {
      orderId: 'order_refund_test',
      refundAmount: 50,
      reason: '包含违规敏感词的退款原因'
    }
  })
  assert.equal(sensitiveReasonRes.ok, false)
  assert.match(sensitiveReasonRes.error, /包含敏感或不合规信息/)

  // 3. 正常退款成功
  const normalRefundRes = await adminFn.main({
    module: 'payment',
    action: 'createRefund',
    data: {
      orderId: 'order_refund_test',
      refundAmount: 50,
      reason: '协商一致退款'
    }
  })
  assert.equal(normalRefundRes.ok, true)
})

test('admin: reward mails publish text security and length limits', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      { _id: 'u_client_1', openid: 'openid_c1', roles: ['client'], status: 'active', memberLevel: 'lv_gold' }
    ],
    member_levels: [
      { _id: 'lv_gold', name: '黄金会员', level: 2, enabled: true }
    ],
    pet_titles: [
      { _id: 'title_1', name: '治愈小可爱', enabled: true, duplicatePoints: 100 }
    ],
    reward_mails: []
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin', { security: securityMock })

  // 1. publishRewardMailByLevels 标题超长
  const longTitleRes = await adminFn.main({
    module: 'admin',
    action: 'publishRewardMailByLevels',
    data: {
      targetLevelIds: ['lv_gold'],
      rewardType: 'points',
      points: 10,
      title: 'T'.repeat(51)
    }
  })
  assert.equal(longTitleRes.ok, false)
  assert.match(longTitleRes.error, /邮件标题不能超过 50 字/)

  // 2. publishRewardMailByLevels 内容超长
  const longContentRes = await adminFn.main({
    module: 'admin',
    action: 'publishRewardMailByLevels',
    data: {
      targetLevelIds: ['lv_gold'],
      rewardType: 'points',
      points: 10,
      content: 'C'.repeat(501)
    }
  })
  assert.equal(longContentRes.ok, false)
  assert.match(longContentRes.error, /邮件内容不能超过 500 字/)

  // 3. publishRewardMailByLevels 违规敏感词拦截
  const sensitiveMailRes = await adminFn.main({
    module: 'admin',
    action: 'publishRewardMailByLevels',
    data: {
      targetLevelIds: ['lv_gold'],
      rewardType: 'points',
      points: 10,
      title: '违规敏感词奖励通知'
    }
  })
  assert.equal(sensitiveMailRes.ok, false)
  assert.match(sensitiveMailRes.error, /包含敏感或不合规信息/)

  // 4. publishRetroCardMail 数量上限拦截 ( > 100 )
  const tooManyCardsRes = await adminFn.main({
    module: 'admin',
    action: 'publishRetroCardMail',
    data: {
      targetType: 'all_active',
      count: 101
    }
  })
  assert.equal(tooManyCardsRes.ok, false)
  assert.match(tooManyCardsRes.error, /单次群发补签卡数量不能超过 100 张/)

  // 5. publishPetTitleMail 内容敏感词与超长拦截
  const longPetTitleMailRes = await adminFn.main({
    module: 'admin',
    action: 'publishPetTitleMail',
    data: {
      titleId: 'title_1',
      targetType: 'all_active',
      content: 'P'.repeat(501)
    }
  })
  assert.equal(longPetTitleMailRes.ok, false)
  assert.match(longPetTitleMailRes.error, /邮件内容不能超过 500 字/)
})

test('checkin: createCheckin remark length limit and sanitization', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_staff', openid: 'openid_staff', roles: ['staff'], status: 'active' }
    ],
    orders: [
      {
        _id: 'order_checkin_test',
        staffUserId: 'u_staff',
        staffOpenid: 'openid_staff',
        status: 'in_service',
        serviceLatitude: 31.22,
        serviceLongitude: 121.48
      }
    ],
    checkin_logs: []
  })

  const staffFn = loadCloudFunction('api', db, 'openid_staff', { security: securityMock })

  // 1. 打卡备注超长拦截
  const longRemarkRes = await staffFn.main({
    module: 'checkin',
    action: 'createCheckin',
    data: {
      orderId: 'order_checkin_test',
      eventType: 'feed',
      mediaFileId: 'cloud://test/photo.jpg',
      latitude: 31.22,
      longitude: 121.48,
      remark: 'R'.repeat(201)
    }
  })
  assert.equal(longRemarkRes.ok, false)
  assert.match(longRemarkRes.error, /打卡备注不能超过 200 字/)

  // 2. 正常备注成功落库
  const normalCheckinRes = await staffFn.main({
    module: 'checkin',
    action: 'createCheckin',
    data: {
      orderId: 'order_checkin_test',
      eventType: 'feed',
      mediaFileId: 'cloud://test/photo.jpg',
      latitude: 31.22,
      longitude: 121.48,
      remark: ' 宠物胃口很好，吃光了粮食   '
    }
  })
  assert.equal(normalCheckinRes.ok, true)
  const saved = await db.collection('checkin_logs').doc(normalCheckinRes.data._id).get()
  assert.equal(saved.data.remark, '宠物胃口很好，吃光了粮食')
})

test('multi-entry length limits: reviews, session messages, auth profile, supply reimbursement, pets', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_c', openid: 'openid_c', roles: ['client'], status: 'active', nickname: '原昵称', phone: '13800000000' },
      { _id: 'u_s', openid: 'openid_s', roles: ['staff'], status: 'active' }
    ],
    staff_profiles: [
      { _id: 'sp_1', openid: 'openid_s', auditStatus: 'approved', staffLevel: 'certified' }
    ],
    orders: [
      {
        _id: 'order_eval_test',
        clientOpenid: 'openid_c',
        clientUserId: 'u_c',
        staffOpenid: 'openid_s',
        status: 'completed',
        reviewedAt: null
      },
      {
        _id: 'order_msg_test',
        clientOpenid: 'openid_c',
        clientUserId: 'u_c',
        staffOpenid: 'openid_s',
        status: 'in_service'
      }
    ],
    pets: [
      { _id: 'pet_1', openid: 'openid_c', name: '咪咪', avatarFileId: 'avatar.jpg', deletedAt: null }
    ],
    service_reviews: [],
    staff_supply_reimbursements: []
  })

  const clientFn = loadCloudFunction('api', db, 'openid_c', { security: securityMock })
  const staffFn = loadCloudFunction('api', db, 'openid_s', { security: securityMock })

  // 1. createReview 评价内容超长拦截
  const longReviewRes = await clientFn.main({
    module: 'order',
    action: 'createReview',
    data: {
      orderId: 'order_eval_test',
      rating: 5,
      content: 'E'.repeat(501)
    }
  })
  assert.equal(longReviewRes.ok, false)
  assert.match(longReviewRes.error, /评价内容不能超过 500 字/)

  // 2. sendOrderSessionMessage 会话内容超长拦截
  const longMsgRes = await clientFn.main({
    module: 'order',
    action: 'sendOrderSessionMessage',
    data: {
      orderId: 'order_msg_test',
      content: 'M'.repeat(501)
    }
  })
  assert.equal(longMsgRes.ok, false)
  assert.match(longMsgRes.error, /会话内容不能超过 500 字/)

  // 3. auth updateProfile 昵称超长与手机号格式拦截
  const longNicknameRes = await clientFn.main({
    module: 'auth',
    action: 'updateProfile',
    data: {
      nickname: 'N'.repeat(31)
    }
  })
  assert.equal(longNicknameRes.ok, false)
  assert.match(longNicknameRes.error, /昵称不能超过 30 字/)

  const longProfilePhoneRes = await clientFn.main({
    module: 'auth',
    action: 'updateProfile',
    data: {
      nickname: '新昵称',
      phone: '1'.repeat(21)
    }
  })
  assert.equal(longProfilePhoneRes.ok, false)
  assert.match(longProfilePhoneRes.error, /手机号格式不正确/)

  // 4. staff submitSupplyReimbursement 截图数量 > 9 与备注超长拦截
  const tooManyImagesRes = await staffFn.main({
    module: 'staff',
    action: 'submitSupplyReimbursement',
    data: {
      mediaFileIds: Array.from({ length: 10 }, (_, i) => `proof_${i}.jpg`),
      amount: 100,
      remark: '报销'
    }
  })
  assert.equal(tooManyImagesRes.ok, false)
  assert.match(tooManyImagesRes.error, /凭证截图最多上传 9 张/)

  const longReimburseRemarkRes = await staffFn.main({
    module: 'staff',
    action: 'submitSupplyReimbursement',
    data: {
      mediaFileIds: ['proof_1.jpg'],
      amount: 100,
      remark: 'B'.repeat(501)
    }
  })
  assert.equal(longReimburseRemarkRes.ok, false)
  assert.match(longReimburseRemarkRes.error, /报销备注不能超过 500 字/)

  // 5. pet createPet / updatePet 宠物名称超长拦截
  const longPetNameRes = await clientFn.main({
    module: 'pet',
    action: 'createPet',
    data: {
      name: 'P'.repeat(31),
      avatarFileId: 'avatar.jpg'
    }
  })
  assert.equal(longPetNameRes.ok, false)
  assert.match(longPetNameRes.error, /宠物名称不能超过 30 字/)

  const longUpdatePetNameRes = await clientFn.main({
    module: 'pet',
    action: 'updatePet',
    data: {
      id: 'pet_1',
      name: 'P'.repeat(31),
      avatarFileId: 'avatar.jpg'
    }
  })
  assert.equal(longUpdatePetNameRes.ok, false)
  assert.match(longUpdatePetNameRes.error, /宠物名称不能超过 30 字/)
})
