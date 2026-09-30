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

test('ai: aiPetAssistant question length and rate limiting checks', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active' }
    ],
    pets: []
  })

  const clientFn = loadCloudFunction('api', db, 'openid_client', {
    security: securityMock,
    extend: {
      AI: {
        createModel: () => ({
          generateText: async () => ({
            choices: [{ message: { content: '建议带宠物定期体检，保证充足饮水。' } }]
          })
        })
      }
    }
  })

  // 1. 问题超长拦截
  const longQuestionRes = await clientFn.main({
    module: 'ai',
    action: 'aiPetAssistant',
    data: { question: 'Q'.repeat(301) }
  })
  assert.equal(longQuestionRes.ok, false)
  assert.match(longQuestionRes.error, /不能超过 300 字/)

  // 2. 正常咨询成功
  const goodRes = await clientFn.main({
    module: 'ai',
    action: 'aiPetAssistant',
    data: { question: '猫咪一天需要喝多少水？' }
  })
  assert.equal(goodRes.ok, true)
  assert.match(goodRes.data.answer, /建议带宠物定期体检/)

  // 3. 高频请求触发限流（连续发送 10 次以上）
  let rateLimitHit = false
  for (let i = 0; i < 11; i++) {
    const res = await clientFn.main({
      module: 'ai',
      action: 'aiPetAssistant',
      data: { question: `第${i}次咨询猫咪饮食注意事项` }
    })
    if (!res.ok && res.error.includes('过于频繁')) {
      rateLimitHit = true
      break
    }
  }
  assert.equal(rateLimitHit, true)
})

test('coupon: issueCouponToTargetUser enforces in-transaction user limit', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client_1', openid: 'openid_client_1', roles: ['client'], status: 'active' },
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' }
    ],
    coupon_templates: [
      {
        _id: 'tpl_limit_1',
        name: '新人专享10元券',
        discountAmount: 10,
        minOrderAmount: 50,
        perUserLimit: 1,
        totalIssueLimit: 100,
        issuedCount: 0,
        enabled: true,
        validDays: 7
      }
    ],
    user_coupons: [],
    admin_operation_logs: []
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 1. 第一次发券成功
  const firstRes = await adminFn.main({
    module: 'admin',
    action: 'issueCouponToUser',
    data: { templateId: 'tpl_limit_1', openid: 'openid_client_1' }
  })
  assert.equal(firstRes.ok, true)

  // 2. 第二次尝试发券，被事务内用户限额拦截
  const secondRes = await adminFn.main({
    module: 'admin',
    action: 'issueCouponToUser',
    data: { templateId: 'tpl_limit_1', openid: 'openid_client_1' }
  })
  assert.equal(secondRes.ok, false)
  assert.match(secondRes.error, /该用户已达到领取上限/)
})

test('membership: bindInviteRelation atomic increment for inviter retroCardCount', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_inviter', openid: 'openid_inviter', inviteCode: 'INVITE888', retroCardCount: 0, roles: ['client'], status: 'active' },
      { _id: 'u_new_1', openid: 'openid_new_1', roles: ['client'], status: 'active' },
      { _id: 'u_new_2', openid: 'openid_new_2', roles: ['client'], status: 'active' }
    ],
    user_invites: [],
    retro_card_logs: []
  })

  const user1Fn = loadCloudFunction('api', db, 'openid_new_1')
  const user2Fn = loadCloudFunction('api', db, 'openid_new_2')

  // 两个被邀请人同时绑定
  const [res1, res2] = await Promise.all([
    user1Fn.main({ module: 'auth', action: 'login', data: { inviteCode: 'INVITE888' } }),
    user2Fn.main({ module: 'auth', action: 'login', data: { inviteCode: 'INVITE888' } })
  ])

  assert.equal(res1.ok, true)
  assert.equal(res2.ok, true)

  // 验证邀请人补签卡原子累加为 2，无并发更新丢失
  const inviter = db.state.users.find((u) => u._id === 'u_inviter')
  assert.equal(inviter.retroCardCount, 2)
  assert.equal(db.state.retro_card_logs.length, 2)
})

test('admin: deposit forfeit and supply reimbursement security checks', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      { _id: 'u_staff', openid: 'openid_staff', roles: ['staff'], status: 'active' }
    ],
    staff_profiles: [
      {
        _id: 'sp_staff',
        openid: 'openid_staff',
        staffLevel: 'certified',
        auditStatus: 'approved'
      }
    ],
    staff_deposits: [
      {
        _id: 'dep_1',
        staffOpenid: 'openid_staff',
        staffUserId: 'u_staff',
        staffProfileId: 'sp_staff',
        amount: 500,
        paidAmount: 500,
        availableRefundAmount: 500,
        forfeitedAmount: 0,
        status: 'paid',
        refundStatus: 'none'
      }
    ],
    staff_supply_reimbursements: [
      {
        _id: 'sup_1',
        staffOpenid: 'openid_staff',
        staffUserId: 'u_staff',
        staffProfileId: 'sp_staff',
        amount: 80,
        status: 'pending'
      }
    ],
    staff_deposit_events: [],
    finance_logs: [],
    admin_operation_logs: []
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin', {
    security: securityMock,
    downloadFile: async ({ fileID }) => {
      if (fileID.includes('bad')) {
        return { fileContent: Buffer.from('bad_image_data') }
      }
      return { fileContent: Buffer.from('good_image_data') }
    }
  })

  // 1. 保证金没收原因包含敏感词拦截
  const badForfeitReasonRes = await adminFn.main({
    module: 'admin',
    action: 'forfeitStaffDeposit',
    data: {
      id: 'dep_1',
      amount: 100,
      clientRequestId: 'forfeit_1',
      reason: '由于违规敏感词行为没收保证金'
    }
  })
  assert.equal(badForfeitReasonRes.ok, false)
  assert.match(badForfeitReasonRes.error, /敏感|不合规|违规/)

  // 2. 保证金没收凭证图片违规拦截
  const badForfeitImageRes = await adminFn.main({
    module: 'admin',
    action: 'forfeitStaffDeposit',
    data: {
      id: 'dep_1',
      amount: 100,
      clientRequestId: 'forfeit_1',
      reason: '服务严重超时未履约',
      evidenceImages: ['cloud://proof/bad_evidence.png']
    }
  })
  assert.equal(badForfeitImageRes.ok, false)
  assert.match(badForfeitImageRes.error, /敏感|不合规|违规/)

  // 3. 用品报销驳回说明敏感词拦截
  const badReimburseRes = await adminFn.main({
    module: 'admin',
    action: 'auditSupplyReimbursement',
    data: {
      id: 'sup_1',
      approved: false,
      reason: '发票不合格包含违规敏感词发票'
    }
  })
  assert.equal(badReimburseRes.ok, false)
  assert.match(badReimburseRes.error, /敏感|不合规|违规/)
})

test('order: cancelOrder reason length and security, and mall applyRefund length check', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active' }
    ],
    orders: [
      {
        _id: 'ord_cancel_1',
        orderNo: 'ORDCANCEL001',
        clientOpenid: 'openid_client',
        status: 'pending_pay',
        paymentStatus: 'unpaid',
        payAmount: 100
      }
    ],
    mall_orders: [
      {
        _id: 'mo_cancel_1',
        clientOpenid: 'openid_client',
        status: 'pending_ship',
        paymentStatus: 'paid',
        payAmount: 88
      }
    ]
  })

  const clientFn = loadCloudFunction('api', db, 'openid_client', { security: securityMock })

  // 1. 订单取消原因敏感词拦截
  const badCancelReasonRes = await clientFn.main({
    module: 'order',
    action: 'cancelOrder',
    data: {
      orderId: 'ord_cancel_1',
      reason: '不想要了违规敏感词兼职联系'
    }
  })
  assert.equal(badCancelReasonRes.ok, false)
  assert.match(badCancelReasonRes.error, /敏感|不合规|违规/)

  // 2. 订单取消原因超长拦截
  const longCancelReasonRes = await clientFn.main({
    module: 'order',
    action: 'cancelOrder',
    data: {
      orderId: 'ord_cancel_1',
      reason: 'C'.repeat(201)
    }
  })
  assert.equal(longCancelReasonRes.ok, false)
  assert.match(longCancelReasonRes.error, /不能超过 200 字/)

  // 3. 商城售后原因超长拦截
  const longMallRefundRes = await clientFn.main({
    module: 'mall',
    action: 'applyRefund',
    data: {
      id: 'mo_cancel_1',
      reason: 'M'.repeat(501)
    }
  })
  assert.equal(longMallRefundRes.ok, false)
  assert.match(longMallRefundRes.error, /不能超过 500 字/)
})

test('homeSecurity: recordKeyReturned prevents overwrite on repeated submissions', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_staff', openid: 'openid_staff', roles: ['staff'], status: 'active' }
    ],
    orders: [
      {
        _id: 'ord_key_1',
        staffOpenid: 'openid_staff',
        status: 'in_service',
        orderHomeSecurity: {
          type: 'key',
          key: {
            keyLocation: '门口地毯下'
          }
        }
      }
    ],
    order_home_security: []
  })

  const staffFn = loadCloudFunction('api', db, 'openid_staff', { security: securityMock })

  // 1. 第一次登记归还钥匙成功
  const firstReturnRes = await staffFn.main({
    module: 'homeSecurity',
    action: 'recordKeyReturned',
    data: {
      orderId: 'ord_key_1',
      imageFileIds: ['cloud://keys/photo1.png'],
      returnNote: '已将钥匙归还原位'
    }
  })
  assert.equal(firstReturnRes.ok, true)

  // 2. 相同凭证重复提交幂等成功
  const idempotentRes = await staffFn.main({
    module: 'homeSecurity',
    action: 'recordKeyReturned',
    data: {
      orderId: 'ord_key_1',
      imageFileIds: ['cloud://keys/photo1.png'],
      returnNote: '已将钥匙归还原位'
    }
  })
  assert.equal(idempotentRes.ok, true)

  // 3. 传入不同凭证企图覆盖已归还记录被拦截
  const overwriteRes = await staffFn.main({
    module: 'homeSecurity',
    action: 'recordKeyReturned',
    data: {
      orderId: 'ord_key_1',
      imageFileIds: ['cloud://keys/new_different_photo.png'],
      returnNote: '修改放回位置'
    }
  })
  assert.equal(overwriteRes.ok, false)
  assert.match(overwriteRes.error, /不可重复覆盖归还记录/)
})
