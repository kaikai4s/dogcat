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

test('admin: auditWithdrawRequest remark length and content security checks', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      { _id: 'u_staff', openid: 'openid_staff', roles: ['staff'], status: 'active' }
    ],
    staff_earnings: [
      {
        _id: 'e_1',
        orderId: 'order_1',
        staffOpenid: 'openid_staff',
        amount: 80,
        status: 'withdrawing',
        withdrawRequestId: 'wr_1'
      }
    ],
    withdraw_requests: [
      {
        _id: 'wr_1',
        staffOpenid: 'openid_staff',
        amount: 80,
        status: 'pending',
        earningIds: ['e_1'],
        accountName: '张三',
        accountNo: 'wx123',
        createdAt: '2026-09-30 10:00:00'
      }
    ],
    finance_logs: [],
    admin_operation_logs: []
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin', { security: securityMock })

  // 1. 审核备注包含敏感词被拦截
  const badRemarkRes = await adminFn.main({
    module: 'admin',
    action: 'auditWithdrawRequest',
    data: {
      id: 'wr_1',
      approved: true,
      auditRemark: '通过违规敏感词提现'
    }
  })
  assert.equal(badRemarkRes.ok, false)
  assert.match(badRemarkRes.error, /敏感|不合规|违规/)

  // 2. 审核备注超长拦截
  const longRemarkRes = await adminFn.main({
    module: 'admin',
    action: 'auditWithdrawRequest',
    data: {
      id: 'wr_1',
      approved: true,
      auditRemark: 'x'.repeat(501)
    }
  })
  assert.equal(longRemarkRes.ok, false)
  assert.match(longRemarkRes.error, /不能超过 500 字/)

  // 3. 正常审核通过
  const goodAuditRes = await adminFn.main({
    module: 'admin',
    action: 'auditWithdrawRequest',
    data: {
      id: 'wr_1',
      approved: true,
      auditRemark: '核验银行流水正常，通过申请'
    }
  })
  assert.equal(goodAuditRes.ok, true)
  assert.equal(goodAuditRes.data.status, 'approved')
  assert.equal(db.state.withdraw_requests[0].status, 'approved')
})

test('admin: markWithdrawPaid payRemark and paymentProofImage security checks', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      { _id: 'u_staff', openid: 'openid_staff', roles: ['staff'], status: 'active' }
    ],
    staff_earnings: [
      {
        _id: 'e_2',
        orderId: 'order_2',
        staffOpenid: 'openid_staff',
        amount: 80,
        status: 'withdrawing',
        withdrawRequestId: 'wr_2'
      }
    ],
    withdraw_requests: [
      {
        _id: 'wr_2',
        staffOpenid: 'openid_staff',
        amount: 80,
        status: 'approved',
        earningIds: ['e_2'],
        accountName: '李四',
        accountNo: 'wx456',
        createdAt: '2026-09-30 10:00:00'
      }
    ],
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

  // 1. 打款备注包含敏感词被拦截
  const badRemarkRes = await adminFn.main({
    module: 'admin',
    action: 'markWithdrawPaid',
    data: {
      id: 'wr_2',
      paymentConfirmed: true,
      paymentReference: 'receipt-2',
      payRemark: '已通过微信私下打款违规敏感词联系'
    }
  })
  assert.equal(badRemarkRes.ok, false)
  assert.match(badRemarkRes.error, /敏感|不合规|违规/)

  // 2. 打款凭证图片违规被拦截
  const badImageRes = await adminFn.main({
    module: 'admin',
    action: 'markWithdrawPaid',
    data: {
      id: 'wr_2',
      paymentConfirmed: true,
      paymentReference: 'receipt-2',
      payRemark: '转账成功',
      paymentProofImage: 'cloud://proof/bad_receipt.png'
    }
  })
  assert.equal(badImageRes.ok, false)
  assert.match(badImageRes.error, /敏感|不合规|违规/)

  // 3. 正常凭证与打款备注顺利打款完成
  const goodPayRes = await adminFn.main({
    module: 'admin',
    action: 'markWithdrawPaid',
    data: {
      id: 'wr_2',
      paymentConfirmed: true,
      paymentReference: 'receipt-2',
      payRemark: '银行网银转账完成，流水号TX2026093001',
      paymentProofImage: 'cloud://proof/good_receipt.png'
    }
  })
  assert.equal(goodPayRes.ok, true)
  assert.equal(goodPayRes.data.status, 'paid')
  assert.equal(db.state.withdraw_requests[0].status, 'paid')
})

test('admin: saveCouponTemplate text security check', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' }
    ],
    coupon_templates: [],
    system_settings: [],
    admin_operation_logs: []
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin', { security: securityMock })

  // 1. 优惠券名称或文案包含敏感词拦截
  const badCouponRes = await adminFn.main({
    module: 'admin',
    action: 'saveCouponTemplate',
    data: {
      name: '违规敏感词促销券',
      discountAmount: 20,
      minOrderAmount: 80,
      validDays: 30,
      enabled: true
    }
  })
  assert.equal(badCouponRes.ok, false)
  assert.match(badCouponRes.error, /敏感|不合规|违规/)

  // 2. 正常优惠券模板保存成功
  const goodCouponRes = await adminFn.main({
    module: 'admin',
    action: 'saveCouponTemplate',
    data: {
      name: '国庆特惠大礼券',
      description: '全场通用，满80立减20',
      displayTag: '国庆特惠',
      claimNotice: '每位宠主限领一张',
      useNotice: '不可与其他优惠叠加',
      discountAmount: 20,
      minOrderAmount: 80,
      validDays: 30,
      enabled: true
    }
  })
  assert.equal(goodCouponRes.ok, true)
  assert.equal(goodCouponRes.data.name, '国庆特惠大礼券')
  assert.equal(db.state.coupon_templates.length, 1)
})

test('admin: saveMemberLevel text security check', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' }
    ],
    member_levels: [],
    admin_operation_logs: []
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin', { security: securityMock })

  // 1. 会员等级名称或权益包含敏感词拦截
  const badLevelRes = await adminFn.main({
    module: 'admin',
    action: 'saveMemberLevel',
    data: {
      name: '违规敏感词至尊卡',
      badgeTag: 'VIP-BAD',
      minPoints: 500,
      benefits: ['违规敏感词权益']
    }
  })
  assert.equal(badLevelRes.ok, false)
  assert.match(badLevelRes.error, /敏感|不合规|违规/)

  // 2. 正常会员等级保存成功
  const goodLevelRes = await adminFn.main({
    module: 'admin',
    action: 'saveMemberLevel',
    data: {
      name: '至尊黑金卡',
      badgeTag: 'VIP-BLACK',
      nameColor: '#333333',
      minPoints: 1000,
      pointMultiplier: 3,
      description: '最高尊享体验会员',
      benefits: ['专属管家一对一', '节假日优先派单']
    }
  })
  assert.equal(goodLevelRes.ok, true)
  assert.equal(goodLevelRes.data.name, '至尊黑金卡')
  assert.equal(db.state.member_levels.length, 1)
})

test('admin: savePetTitle text security check', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' }
    ],
    pet_titles: [],
    admin_operation_logs: []
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin', { security: securityMock })

  // 1. 宠物头衔名称或描述包含敏感词拦截
  const badTitleRes = await adminFn.main({
    module: 'admin',
    action: 'savePetTitle',
    data: {
      name: '违规敏感词小恶霸',
      description: '破坏力极强的拆家汪'
    }
  })
  assert.equal(badTitleRes.ok, false)
  assert.match(badTitleRes.error, /敏感|不合规|违规/)

  // 2. 正常头衔保存成功
  const goodTitleRes = await adminFn.main({
    module: 'admin',
    action: 'savePetTitle',
    data: {
      name: '拆家小能手',
      description: '精力充沛，每天快乐奔跑的元气汪',
      icon: '🐕',
      badgeStyle: 'gold',
      duplicatePoints: 20,
      enabled: true
    }
  })
  assert.equal(goodTitleRes.ok, true)
  assert.equal(goodTitleRes.data.name, '拆家小能手')
  assert.equal(db.state.pet_titles.length, 1)
})
