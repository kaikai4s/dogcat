const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

function setupIdempotencyDb(extra = {}) {
  return createCollectionStore({
    users: [
      {
        _id: 'u_admin',
        openid: 'openid_admin',
        roles: ['admin'],
        status: 'active'
      },
      {
        _id: 'u_client_1',
        openid: 'openid_client_1',
        nickname: '客户1',
        roles: ['client'],
        memberLevel: 'lvl_gold',
        status: 'active'
      },
      {
        _id: 'u_client_2',
        openid: 'openid_client_2',
        nickname: '客户2',
        roles: ['client'],
        memberLevel: 'lvl_gold',
        status: 'active'
      }
    ],
    member_levels: [
      { _id: 'lvl_gold', name: '黄金会员', minPoints: 100 }
    ],
    coupon_templates: [
      {
        _id: 'tmpl_mail_50',
        name: '邮件奖励50元券',
        type: 'fixed',
        usageScope: 'all',
        discountAmount: 50,
        minOrderAmount: 100,
        applicableServiceTypes: [],
        enabled: true,
        perUserLimit: 5,
        totalIssueLimit: 1000,
        issuedCount: 0
      },
      {
        _id: 'tmpl_incident_30',
        name: '纠纷客诉关怀30元券',
        type: 'fixed',
        usageScope: 'all',
        discountAmount: 30,
        minOrderAmount: 60,
        applicableServiceTypes: [],
        enabled: true,
        perUserLimit: 5,
        totalIssueLimit: 1000,
        issuedCount: 0
      },
      {
        _id: 'tmpl_admin_direct',
        name: '管理员专属补贴券',
        type: 'fixed',
        usageScope: 'all',
        discountAmount: 20,
        minOrderAmount: 50,
        applicableServiceTypes: [],
        enabled: true,
        perUserLimit: 5,
        totalIssueLimit: 1000,
        issuedCount: 0
      }
    ],
    reward_mails: [
      {
        _id: 'mail_with_coupon_1',
        openid: 'openid_client_1',
        userId: 'u_client_1',
        title: '节日福利券',
        content: '为您送上一张大额优惠券',
        readAt: null,
        claimedAt: null,
        reward: {
          type: 'coupon',
          couponTemplateId: 'tmpl_mail_50'
        },
        createdAt: new Date()
      }
    ],
    order_incidents: [
      {
        _id: 'inc_test_1',
        orderId: 'order_test_1',
        clientOpenid: 'openid_client_1',
        status: 'investigating',
        content: '迟到反馈',
        createdAt: new Date()
      }
    ],
    orders: [
      {
        _id: 'order_test_1',
        clientOpenid: 'openid_client_1',
        status: 'completed',
        payAmount: 100
      }
    ],
    user_coupons: [],
    admin_operation_logs: [],
    platform_configs: [],
    ...extra
  })
}

test('coupon idempotency: 奖励邮件领取优惠券具备强幂等保护，异常重试不重复发放', async () => {
  const db = setupIdempotencyDb()
  const clientFn = loadCloudFunction('api', db, 'openid_client_1')

  // 1. 首次正常领取
  const res1 = await clientFn.main({
    module: 'rewardMail',
    action: 'claimReward',
    data: { id: 'mail_with_coupon_1' }
  })
  assert.equal(res1.ok, true)
  const couponId1 = res1.data.rewardClaimResult.couponId
  assert.ok(couponId1, '首次领取应发放优惠券')

  // 2. 模拟如果邮件未标记完成被重试再次领取（例如网络重试）
  db.state.reward_mails[0].claimedAt = null
  const res2 = await clientFn.main({
    module: 'rewardMail',
    action: 'claimReward',
    data: { id: 'mail_with_coupon_1' }
  })
  assert.equal(res2.ok, true)
  const couponId2 = res2.data.rewardClaimResult.couponId
  assert.equal(couponId2, couponId1, '重试领券必须返回同一张已发优惠券')

  // 验证用户券包严格只有 1 张券
  const userCoupons = db.state.user_coupons.filter((c) => c.openid === 'openid_client_1' && c.templateId === 'tmpl_mail_50')
  assert.equal(userCoupons.length, 1, '同一封邮件绝不可重复超发多张优惠券')
  assert.equal(userCoupons[0].idempotencyKey, 'reward_mail_mail_with_coupon_1')
})

test('coupon idempotency: 纠纷方案提出优惠券补偿具备幂等性，重复提交不重复下发', async () => {
  const db = setupIdempotencyDb()
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 1. 首次提交补偿方案
  const res1 = await adminFn.main({
    module: 'incident',
    action: 'proposeResolution',
    data: {
      id: 'inc_test_1',
      resolutionType: 'coupon',
      couponTemplateId: 'tmpl_incident_30',
      content: '赠送30元优惠券安抚'
    }
  })
  assert.equal(res1.ok, true)
  const couponId1 = res1.data.resolution.couponId
  assert.ok(couponId1)

  // 2. 二次提交相同纠纷方案（例如双击或网络重试）
  const res2 = await adminFn.main({
    module: 'incident',
    action: 'proposeResolution',
    data: {
      id: 'inc_test_1',
      resolutionType: 'coupon',
      couponTemplateId: 'tmpl_incident_30',
      content: '赠送30元优惠券安抚'
    }
  })
  assert.equal(res2.ok, true)
  const couponId2 = res2.data.resolution.couponId
  assert.equal(couponId2, couponId1, '重复提交纠纷方案必须幂等返回同一张券')

  // 验证用户券包严格只有 1 张该纠纷补偿券
  const userCoupons = db.state.user_coupons.filter((c) => c.openid === 'openid_client_1' && c.templateId === 'tmpl_incident_30')
  assert.equal(userCoupons.length, 1, '同一纠纷不可重复多发补偿券')
  assert.equal(userCoupons[0].idempotencyKey, 'incident_coupon_inc_test_1')
})

test('coupon idempotency: 管理员向单人发券携带 clientRequestId 严格防重', async () => {
  const db = setupIdempotencyDb()
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 1. 首次发券
  const res1 = await adminFn.main({
    module: 'admin',
    action: 'issueCouponToUser',
    data: {
      templateId: 'tmpl_admin_direct',
      openid: 'openid_client_1',
      clientRequestId: 'req_admin_issue_001'
    }
  })
  assert.equal(res1.ok, true)
  const couponId1 = res1.data._id

  // 2. 相同 clientRequestId 重复点击
  const res2 = await adminFn.main({
    module: 'admin',
    action: 'issueCouponToUser',
    data: {
      templateId: 'tmpl_admin_direct',
      openid: 'openid_client_1',
      clientRequestId: 'req_admin_issue_001'
    }
  })
  assert.equal(res2.ok, true)
  const couponId2 = res2.data._id
  assert.equal(couponId2, couponId1, '相同请求号发券应幂等返回')

  const userCoupons = db.state.user_coupons.filter((c) => c.openid === 'openid_client_1' && c.templateId === 'tmpl_admin_direct')
  assert.equal(userCoupons.length, 1, '相同请求号绝不重复写入第二张券')
})

test('coupon idempotency: 管理员按等级批量发券支持 batchKey 幂等重试', async () => {
  const db = setupIdempotencyDb()
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 1. 首次批量发放给黄金会员（包含 client_1 和 client_2）
  const res1 = await adminFn.main({
    module: 'admin',
    action: 'issueCouponByLevels',
    data: {
      templateId: 'tmpl_admin_direct',
      targetLevelIds: ['lvl_gold'],
      clientRequestId: 'batch_gold_20260924'
    }
  })
  assert.equal(res1.ok, true)
  assert.equal(res1.data.issued, 2, '首次应成功发放 2 张券')

  // 2. 携带相同的请求批次号再次执行（例如重试）
  const res2 = await adminFn.main({
    module: 'admin',
    action: 'issueCouponByLevels',
    data: {
      templateId: 'tmpl_admin_direct',
      targetLevelIds: ['lvl_gold'],
      clientRequestId: 'batch_gold_20260924'
    }
  })
  assert.equal(res2.ok, true)

  // 验证总共发放的券数依然为 2，绝不会变成 4
  const allIssued = db.state.user_coupons.filter((c) => c.templateId === 'tmpl_admin_direct')
  assert.equal(allIssued.length, 2, '批次重试不应重复发券')
})
