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

test('homeSecurity: enforces content security on entry notes, one time code and returned key', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active' },
      { _id: 'u_staff', openid: 'openid_staff', roles: ['staff'], status: 'active' }
    ],
    home_security: [],
    orders: [
      {
        _id: 'ord_sec_1',
        orderNo: 'ORD_SEC_1',
        clientOpenid: 'openid_client',
        staffOpenid: 'openid_staff',
        status: 'in_service',
        startTime: '2026-10-01 10:00',
        endTime: '2026-10-01 11:00',
        orderHomeSecurity: {
          type: 'key',
          key: { keyReturnMethod: 'original_place', keyLocation: '地毯下' }
        }
      }
    ],
    order_home_security: []
  })

  const clientFn = loadCloudFunction('api', db, 'openid_client', { security: securityMock })
  const staffFn = loadCloudFunction('api', db, 'openid_staff', { security: securityMock })

  // 1. saveHomeSecurity 包含敏感词被拦截
  const resBadHomeSec = await clientFn.main({
    module: 'homeSecurity',
    action: 'saveHomeSecurity',
    data: {
      keyLocation: '地毯下',
      entryNotes: '进门联系加违规敏感词私聊'
    }
  })
  assert.equal(resBadHomeSec.ok, false)
  assert.match(resBadHomeSec.error, /敏感|不合规|违规/)

  // 2. saveHomeSecurity 正常内容通过
  const resGoodHomeSec = await clientFn.main({
    module: 'homeSecurity',
    action: 'saveHomeSecurity',
    data: {
      keyLocation: '门口地毯左下角',
      entryNotes: '鞋套在鞋柜第一层，进门请先换鞋套'
    }
  })
  assert.equal(resGoodHomeSec.ok, true)
  assert.equal(resGoodHomeSec.data.entryNotes, '鞋套在鞋柜第一层，进门请先换鞋套')

  // 3. updateOrderOneTimeCode 包含敏感词被拦截
  const resBadCode = await clientFn.main({
    module: 'homeSecurity',
    action: 'updateOrderOneTimeCode',
    data: {
      orderId: 'ord_sec_1',
      code: '123456',
      effectiveStart: '2026-10-01 09:30',
      effectiveEnd: '2026-10-01 11:30',
      entryNotes: '开门请加违规敏感词微信确认'
    }
  })
  assert.equal(resBadCode.ok, false)
  assert.match(resBadCode.error, /敏感|不合规|违规/)

  // 4. recordKeyReturned 放回钥匙说明包含违规词被拦截
  const resBadKeyReturn = await staffFn.main({
    module: 'homeSecurity',
    action: 'recordKeyReturned',
    data: {
      orderId: 'ord_sec_1',
      imageFileIds: ['cloud://photo_1'],
      note: '钥匙已放回，请加违规敏感词好友'
    }
  })
  assert.equal(resBadKeyReturn.ok, false)
  assert.match(resBadKeyReturn.error, /敏感|不合规|违规/)

  // 5. recordKeyReturned 正常通过
  const resGoodKeyReturn = await staffFn.main({
    module: 'homeSecurity',
    action: 'recordKeyReturned',
    data: {
      orderId: 'ord_sec_1',
      imageFileIds: ['cloud://photo_1'],
      note: '钥匙已放回地毯原位并确认门已反锁'
    }
  })
  assert.equal(resGoodKeyReturn.ok, true)
  assert.equal(resGoodKeyReturn.data.type, 'key')
})

test('order.createReview: tx docCheck strictly prevents duplicate review overwrite', async () => {
  const time = '2026-09-30 10:00:00'
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active', points: 0, totalPoints: 0 }
    ],
    orders: [
      {
        _id: 'ord_rev_1',
        orderNo: 'ORD_REV_1',
        clientOpenid: 'openid_client',
        staffOpenid: 'openid_staff',
        staffProfileId: 'sp_1',
        status: 'completed',
        paymentStatus: 'paid',
        startTime: '2026-09-29 10:00',
        endTime: '2026-09-29 11:00',
        reviewedAt: null,
        createdAt: time
      }
    ],
    service_reviews: [],
    point_logs: [],
    order_timeline: []
  })

  const clientFn = loadCloudFunction('api', db, 'openid_client', { security: securityMock })

  // 第一次评价成功
  const res1 = await clientFn.main({
    module: 'order',
    action: 'createReview',
    data: {
      orderId: 'ord_rev_1',
      rating: 5,
      content: '非常专业细心！'
    }
  })
  assert.equal(res1.ok, true)
  assert.equal(res1.data.rating, 5)

  // 再次评价（无论是通过 reviewedAt 还是通过 tx 内 docCheck）必须被拦截
  const res2 = await clientFn.main({
    module: 'order',
    action: 'createReview',
    data: {
      orderId: 'ord_rev_1',
      rating: 1,
      content: '覆盖差评！'
    }
  })
  assert.equal(res2.ok, false)
  assert.match(res2.error, /该订单已评价/)

  // 模拟并发极值场景：强制清空 order 上的 reviewedAt，使前置校验穿透，直接检验 tx 内的 docCheck 拦截
  const ordDoc = db.state.orders.find(o => o._id === 'ord_rev_1')
  ordDoc.reviewedAt = null

  const resConcurrent = await clientFn.main({
    module: 'order',
    action: 'createReview',
    data: {
      orderId: 'ord_rev_1',
      rating: 1,
      content: '并发恶意篡改评价'
    }
  })
  assert.equal(resConcurrent.ok, false)
  assert.match(resConcurrent.error, /该订单已评价/)

  // 验证原评价未被篡改
  const finalReview = db.state.service_reviews.find(r => r._id === 'review_ord_rev_1')
  assert.equal(finalReview.rating, 5)
  assert.equal(finalReview.content, '非常专业细心！')
})

test('withdrawals: createWithdrawRequest validates text security on remark', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_staff', openid: 'openid_staff', roles: ['staff'], status: 'active' }
    ],
    staff_profiles: [
      { _id: 'sp_1', openid: 'openid_staff', auditStatus: 'approved' }
    ],
    system_settings: [
      { _id: 'default', settlement: { minWithdrawAmount: 10 } }
    ],
    staff_earnings: [
      { _id: 'earn_1', staffOpenid: 'openid_staff', amount: 100, status: 'available' }
    ],
    withdraw_requests: [],
    finance_logs: []
  })

  const staffFn = loadCloudFunction('api', db, 'openid_staff', { security: securityMock })

  // 1. 提现备注包含违规词被拦截
  const resBad = await staffFn.main({
    module: 'finance',
    action: 'createWithdrawRequest',
    data: {
      amount: 100,
      accountName: '张三',
      accountNo: '6222000011112222',
      remark: '急需用钱加违规敏感词联系'
    }
  })
  assert.equal(resBad.ok, false)
  assert.match(resBad.error, /敏感|不合规|违规/)

  // 2. 正常提现通过
  const resGood = await staffFn.main({
    module: 'finance',
    action: 'createWithdrawRequest',
    data: {
      amount: 100,
      accountName: '张三',
      accountNo: '6222000011112222',
      remark: '9月份第3周服务收益提现'
    }
  })
  assert.equal(resGood.ok, true)
  assert.equal(resGood.data.amount, 100)
  assert.equal(resGood.data.status, 'pending')
  assert.equal(resGood.data.remark, '9月份第3周服务收益提现')
})

test('order: requestEarlyStart and approveEarlyStart validate text security', async () => {
  const time = '2026-09-30 08:00:00'
  const db = createCollectionStore({
    users: [
      { _id: 'u_staff', openid: 'openid_staff', roles: ['staff'], status: 'active' },
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active' }
    ],
    orders: [
      {
        _id: 'ord_early_1',
        orderNo: 'ORD_EARLY_1',
        clientOpenid: 'openid_client',
        staffOpenid: 'openid_staff',
        status: 'assigned',
        startTime: '2099-10-01 14:00',
        endTime: '2099-10-01 15:00',
        createdAt: time
      }
    ],
    order_early_start_requests: [],
    order_timeline: []
  })

  const staffFn = loadCloudFunction('api', db, 'openid_staff', { security: securityMock })
  const clientFn = loadCloudFunction('api', db, 'openid_client', { security: securityMock })

  // 1. requestEarlyStart 包含敏感词被拦截
  const resBadEarly = await staffFn.main({
    module: 'order',
    action: 'requestEarlyStart',
    data: {
      id: 'ord_early_1',
      reason: '提前到了，加违规敏感词私聊'
    }
  })
  assert.equal(resBadEarly.ok, false)
  assert.match(resBadEarly.error, /敏感|不合规|违规/)

  // 2. 正常提前开始申请通过
  const resGoodEarly = await staffFn.main({
    module: 'order',
    action: 'requestEarlyStart',
    data: {
      id: 'ord_early_1',
      reason: '已提前到达客户小区楼下，申请提前开始服务'
    }
  })
  assert.equal(resGoodEarly.ok, true)
  assert.equal(resGoodEarly.data.status, 'pending')
  assert.equal(resGoodEarly.data.reason, '已提前到达客户小区楼下，申请提前开始服务')

  // 3. approveEarlyStart 包含敏感词被拦截
  const resBadApprove = await clientFn.main({
    module: 'order',
    action: 'approveEarlyStart',
    data: {
      id: 'ord_early_1',
      remark: '同意提前，加违规敏感词私聊开门'
    }
  })
  assert.equal(resBadApprove.ok, false)
  assert.match(resBadApprove.error, /敏感|不合规|违规/)

  // 4. 正常同意通过
  const resGoodApprove = await clientFn.main({
    module: 'order',
    action: 'approveEarlyStart',
    data: {
      id: 'ord_early_1',
      remark: '同意提前开始，辛苦宠托师了'
    }
  })
  assert.equal(resGoodApprove.ok, true)
  assert.equal(resGoodApprove.data.status, 'approved')
  assert.equal(resGoodApprove.data.clientRemark, '同意提前开始，辛苦宠托师了')
})
