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

test('admin: saveLotteryActivity text security check for activity and prize texts', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' }
    ],
    lottery_activities: [],
    admin_operation_logs: []
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin', { security: securityMock })

  // 1. 活动名称/说明包含违规词被拦截
  const badActivityRes = await adminFn.main({
    module: 'admin',
    action: 'saveLotteryActivity',
    data: {
      name: '违规敏感词大转盘',
      description: '参与抽大奖',
      prizes: [{ type: 'points', points: 10 }]
    }
  })
  assert.equal(badActivityRes.ok, false)
  assert.match(badActivityRes.error, /敏感|不合规|违规/)

  // 2. 奖品名称或文案包含违规词被拦截
  const badPrizeRes = await adminFn.main({
    module: 'admin',
    action: 'saveLotteryActivity',
    data: {
      name: '国庆狂欢抽奖',
      description: '每日一次',
      prizes: [{ type: 'text', name: '违规敏感词特别奖', text: '恭喜中奖' }]
    }
  })
  assert.equal(badPrizeRes.ok, false)
  assert.match(badPrizeRes.error, /敏感|不合规|违规/)

  // 3. 正常抽奖活动保存成功
  const goodActivityRes = await adminFn.main({
    module: 'admin',
    action: 'saveLotteryActivity',
    data: {
      name: '金秋萌宠狂欢抽奖',
      description: '每日登录免费抽一次，赢取积分与优惠券',
      enabled: true,
      prizes: [
        { type: 'points', name: '50积分', points: 50, probability: 60, stockLeft: 100 },
        { type: 'text', name: '萌宠祝福', text: '愿毛孩子健康快乐成长！', probability: 40, stockLeft: 999 }
      ]
    }
  })
  assert.equal(goodActivityRes.ok, true)
  assert.equal(goodActivityRes.data.name, '金秋萌宠狂欢抽奖')
  assert.equal(db.state.lottery_activities.length, 1)
})

test('adminMall: saveCategory and saveProduct security checks', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' }
    ],
    mall_categories: [],
    mall_products: [],
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

  // 1. 分类名称包含敏感词拦截
  const badCategoryRes = await adminFn.main({
    module: 'adminMall',
    action: 'saveCategory',
    data: { name: '违规敏感词玩具' }
  })
  assert.equal(badCategoryRes.ok, false)
  assert.match(badCategoryRes.error, /敏感|不合规|违规/)

  // 2. 正常分类保存成功
  const goodCategoryRes = await adminFn.main({
    module: 'adminMall',
    action: 'saveCategory',
    data: { name: '宠物玩具', icon: 'toy', sortOrder: 1 }
  })
  assert.equal(goodCategoryRes.ok, true)
  const categoryId = goodCategoryRes.data._id

  // 3. 商品名称/介绍包含敏感词拦截
  const badProductTextRes = await adminFn.main({
    module: 'adminMall',
    action: 'saveProduct',
    data: {
      categoryId,
      name: '违规敏感词逗猫棒',
      subtitle: '猫咪最爱',
      coverFileId: 'cloud://mall/toy.png',
      price: 19.9,
      originalPrice: 29.9,
      stock: 100,
      specText: '单支装'
    }
  })
  assert.equal(badProductTextRes.ok, false)
  assert.match(badProductTextRes.error, /敏感|不合规|违规/)

  // 4. 商品图片违规被拦截
  const badProductImageRes = await adminFn.main({
    module: 'adminMall',
    action: 'saveProduct',
    data: {
      categoryId,
      name: '羽毛逗猫棒',
      subtitle: '优质原生态羽毛',
      coverFileId: 'cloud://mall/bad_image.png',
      price: 19.9,
      originalPrice: 29.9,
      stock: 100,
      specText: '单支装'
    }
  })
  assert.equal(badProductImageRes.ok, false)
  assert.match(badProductImageRes.error, /敏感|不合规|违规/)

  // 5. 正常商品保存成功
  const goodProductRes = await adminFn.main({
    module: 'adminMall',
    action: 'saveProduct',
    data: {
      categoryId,
      name: '天然原木猫抓板',
      subtitle: '耐磨耐抓瓦楞纸',
      description: '精选高密度瓦楞原纸，环保健康不易掉屑',
      coverFileId: 'cloud://mall/good_scratch.png',
      imageFileIds: ['cloud://mall/good_carousel.png'],
      price: 39.9,
      originalPrice: 49.9,
      stock: 200,
      specText: '加大号'
    }
  })
  assert.equal(goodProductRes.ok, true)
  assert.equal(goodProductRes.data.name, '天然原木猫抓板')
  assert.equal(db.state.mall_products.length, 1)
})

test('adminMall: updateOrderStatus, refundOrder and auditRefund remark security checks', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active' }
    ],
    mall_orders: [
      {
        _id: 'mo_1',
        orderNo: 'MO20261001001',
        openid: 'openid_client',
        status: 'pending_ship',
        paymentStatus: 'paid',
        payAmount: 100,
        refundStatus: 'none',
        items: [{ productId: 'p1', title: '猫砂', price: 100, quantity: 1 }]
      },
      {
        _id: 'mo_2',
        orderNo: 'MO20261001002',
        openid: 'openid_client',
        status: 'pending_ship',
        paymentStatus: 'paid',
        payAmount: 60,
        refundStatus: 'applied',
        refundReason: '买多了想退货',
        items: [{ productId: 'p2', title: '罐头', price: 60, quantity: 1 }]
      }
    ],
    refunds: [],
    admin_operation_logs: []
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin', { security: securityMock })

  // 1. updateOrderStatus: 敏感词备注拦截
  const badStatusRemarkRes = await adminFn.main({
    module: 'adminMall',
    action: 'updateOrderStatus',
    data: {
      id: 'mo_1',
      status: 'shipped',
      remark: '由于违规敏感词原因已手动发货'
    }
  })
  assert.equal(badStatusRemarkRes.ok, false)
  assert.match(badStatusRemarkRes.error, /敏感|不合规|违规/)

  // 2. updateOrderStatus: 超长备注拦截
  const longStatusRemarkRes = await adminFn.main({
    module: 'adminMall',
    action: 'updateOrderStatus',
    data: {
      id: 'mo_1',
      status: 'shipped',
      remark: 'M'.repeat(201)
    }
  })
  assert.equal(longStatusRemarkRes.ok, false)
  assert.match(longStatusRemarkRes.error, /不能超过 200 字/)

  // 3. refundOrder: 敏感词拦截
  const badRefundOrderRes = await adminFn.main({
    module: 'adminMall',
    action: 'refundOrder',
    data: {
      id: 'mo_1',
      refundAmount: 50,
      reason: '协商一致退款违规敏感词处理'
    }
  })
  assert.equal(badRefundOrderRes.ok, false)
  assert.match(badRefundOrderRes.error, /敏感|不合规|违规/)

  // 4. auditRefund: 敏感词拦截
  const badAuditRefundRes = await adminFn.main({
    module: 'adminMall',
    action: 'auditRefund',
    data: {
      id: 'mo_2',
      approved: false,
      remark: '商品已开封违规敏感词不支持退款'
    }
  })
  assert.equal(badAuditRefundRes.ok, false)
  assert.match(badAuditRefundRes.error, /敏感|不合规|违规/)

  // 5. auditRefund: 正常驳回通过
  const goodAuditRefundRes = await adminFn.main({
    module: 'adminMall',
    action: 'auditRefund',
    data: {
      id: 'mo_2',
      approved: false,
      remark: '商品已拆封影响二次销售，暂无法支持退款'
    }
  })
  assert.equal(goodAuditRefundRes.ok, true)
  assert.equal(goodAuditRefundRes.data.refundStatus, 'rejected')
})

test('incident: proposeResolution, linkRefund and closeIncident security checks', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active' },
      { _id: 'u_staff', openid: 'openid_staff', roles: ['staff'], status: 'active' }
    ],
    orders: [
      {
        _id: 'ord_inc_1',
        orderNo: 'ORDINC1001',
        clientOpenid: 'openid_client',
        staffOpenid: 'openid_staff',
        status: 'in_service',
        paymentStatus: 'paid',
        payAmount: 120,
        refundAmount: 0
      }
    ],
    order_incidents: [
      {
        _id: 'inc_1',
        orderId: 'ord_inc_1',
        clientOpenid: 'openid_client',
        staffOpenid: 'openid_staff',
        status: 'open',
        title: '猫咪未按要求喂水',
        description: '宠托师未及时给饮水机换水',
        frozenEarningIds: []
      }
    ],
    refunds: [],
    incident_actions: [],
    order_timeline: [],
    admin_operation_logs: []
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin', { security: securityMock })

  // 1. proposeResolution: 敏感方案内容被拦截
  const badResolutionRes = await adminFn.main({
    module: 'incident',
    action: 'proposeResolution',
    data: {
      incidentId: 'inc_1',
      resolutionType: 'explain',
      content: '违规敏感词平台已协调宠托师跟进'
    }
  })
  assert.equal(badResolutionRes.ok, false)
  assert.match(badResolutionRes.error, /敏感|不合规|违规/)

  // 2. proposeResolution: 超长方案内容被拦截
  const longResolutionRes = await adminFn.main({
    module: 'incident',
    action: 'proposeResolution',
    data: {
      incidentId: 'inc_1',
      resolutionType: 'explain',
      content: 'I'.repeat(501)
    }
  })
  assert.equal(longResolutionRes.ok, false)
  assert.match(longResolutionRes.error, /不能超过 500 字/)

  // 3. proposeResolution: 正常方案提出
  const goodResolutionRes = await adminFn.main({
    module: 'incident',
    action: 'proposeResolution',
    data: {
      incidentId: 'inc_1',
      resolutionType: 'explain',
      content: '已要求宠托师立即折返核对饮水情况并补充服务打卡视频'
    }
  })
  assert.equal(goodResolutionRes.ok, true)
  assert.equal(goodResolutionRes.data.status, 'processing')

  // 4. linkRefund: 退款原因敏感词拦截
  const badRefundReasonRes = await adminFn.main({
    module: 'incident',
    action: 'linkRefund',
    data: {
      incidentId: 'inc_1',
      refundAmount: 30,
      reason: '退款违规敏感词补偿'
    }
  })
  assert.equal(badRefundReasonRes.ok, false)
  assert.match(badRefundReasonRes.error, /敏感|不合规|违规/)

  // 5. closeIncident: 结案说明敏感词拦截
  const badCloseRes = await adminFn.main({
    module: 'incident',
    action: 'closeIncident',
    data: {
      incidentId: 'inc_1',
      closeRemark: '由于违规敏感词达成一致结案'
    }
  })
  assert.equal(badCloseRes.ok, false)
  assert.match(badCloseRes.error, /敏感|不合规|违规/)

  // 6. closeIncident: 正常结案
  const goodCloseRes = await adminFn.main({
    module: 'incident',
    action: 'closeIncident',
    data: {
      incidentId: 'inc_1',
      closeRemark: '宠托师已补水确认，双方达成和解结案'
    }
  })
  assert.equal(goodCloseRes.ok, true)
  assert.equal(goodCloseRes.data.status, 'closed')
  assert.equal(db.state.order_incidents[0].status, 'closed')
})
