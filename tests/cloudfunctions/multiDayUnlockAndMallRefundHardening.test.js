const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

process.env.HOME_SECURITY_KEY = process.env.HOME_SECURITY_KEY || 'test-home-security-key'

test('homeSecurity: multi-day/session independent one-time passwords storage, masking, and individual day update', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'client_open_1', roles: ['client'], status: 'active', phone: '13800138000' }
    ],
    orders: [
      {
        _id: 'ord_multi_1',
        orderNo: 'ORD_MULTI_1001',
        clientOpenid: 'client_open_1',
        status: 'assigned',
        startTime: '2026-10-01 10:00:00',
        endTime: '2026-10-03 11:00:00',
        serviceSessions: [
          { index: 1, date: '2026-10-01', startTime: '2026-10-01 10:00:00', endTime: '2026-10-01 11:00:00', status: 'pending' },
          { index: 2, date: '2026-10-02', startTime: '2026-10-02 10:00:00', endTime: '2026-10-02 11:00:00', status: 'pending' },
          { index: 3, date: '2026-10-03', startTime: '2026-10-03 10:00:00', endTime: '2026-10-03 11:00:00', status: 'pending' }
        ]
      }
    ],
    order_home_security: [],
    order_messages: []
  })

  const clientApi = loadCloudFunction('api', db, 'client_open_1')

  // 1. 用户上传每一天对应时间段的不同一次性密码
  const resSetSessions = await clientApi.main({
    module: 'homeSecurity',
    action: 'updateOrderOneTimeCode',
    data: {
      orderId: 'ord_multi_1',
      sessionCodes: [
        { sessionIndex: 1, date: '2026-10-01', code: '111111', effectiveStart: '2026-10-01 09:30:00', effectiveEnd: '2026-10-01 11:30:00' },
        { sessionIndex: 2, date: '2026-10-02', code: '222222', effectiveStart: '2026-10-02 09:30:00', effectiveEnd: '2026-10-02 11:30:00' },
        { sessionIndex: 3, date: '2026-10-03', code: '333333', effectiveStart: '2026-10-03 09:30:00', effectiveEnd: '2026-10-03 11:30:00' }
      ]
    }
  })

  assert.equal(resSetSessions.ok, true, `上传多天密码失败: ${resSetSessions.message}`)
  const returnCodes = resSetSessions.data.sessionCodes
  assert.equal(returnCodes.length, 3)
  assert.equal(returnCodes[0].masked, '1***1')
  assert.equal(returnCodes[1].masked, '2***2')
  assert.equal(returnCodes[2].masked, '3***3')
  // 对外绝不暴露 cipher/iv/tag
  assert.equal(returnCodes[0].cipher, undefined)
  assert.equal(returnCodes[0].iv, undefined)
  assert.equal(returnCodes[0].tag, undefined)

  // 检查底层数据库存储已经进行 AES 加密
  const orderDoc = db.state.orders.find(o => o._id === 'ord_multi_1')
  const dbSessions = orderDoc.orderHomeSecurity.sessionCodes
  assert.equal(dbSessions.length, 3)
  assert.ok(dbSessions[0].cipher)
  assert.ok(dbSessions[0].iv)
  assert.ok(dbSessions[0].tag)
  assert.notEqual(dbSessions[0].cipher, '111111')
  assert.notEqual(dbSessions[1].cipher, '222222')
  assert.notEqual(dbSessions[2].cipher, '333333')

  // 2. 客户单独更新第 2 天密码为 888888
  const resUpdateDay2 = await clientApi.main({
    module: 'homeSecurity',
    action: 'updateOrderOneTimeCode',
    data: {
      orderId: 'ord_multi_1',
      sessionIndex: 2,
      date: '2026-10-02',
      code: '888888',
      effectiveStart: '2026-10-02 09:00:00',
      effectiveEnd: '2026-10-02 12:00:00'
    }
  })

  assert.equal(resUpdateDay2.ok, true)
  const updatedList = resUpdateDay2.data.sessionCodes
  assert.equal(updatedList.find(s => s.sessionIndex === 1).masked, '1***1')
  assert.equal(updatedList.find(s => s.sessionIndex === 2).masked, '8***8')
  assert.equal(updatedList.find(s => s.sessionIndex === 3).masked, '3***3')
})

test('homeSecurity: getUnlockCode strictly isolates session time windows preventing cross-day off-session snooping', async () => {
  // 设置订单 2 个场次：
  // 场次 1：昨天已结束
  // 场次 2：明天才开始
  // 模拟夜间/闲时跨天状态
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'client_open_1', roles: ['client'], status: 'active' },
      { _id: 'u_staff', openid: 'staff_open_1', roles: ['staff'], status: 'active' }
    ],
    orders: [
      {
        _id: 'ord_multi_off_session',
        orderNo: 'ORD_OFF_1001',
        clientOpenid: 'client_open_1',
        staffOpenid: 'staff_open_1',
        status: 'assigned',
        startTime: '2020-01-01 10:00:00',
        endTime: '2099-01-01 11:00:00',
        serviceSessions: [
          { index: 1, date: '2020-01-01', startTime: '2020-01-01 10:00:00', endTime: '2020-01-01 11:00:00', status: 'completed' },
          { index: 2, date: '2099-01-01', startTime: '2099-01-01 10:00:00', endTime: '2099-01-01 11:00:00', status: 'pending' }
        ]
      }
    ],
    unlock_code_logs: [],
    order_messages: []
  })

  const clientApi = loadCloudFunction('api', db, 'client_open_1')
  const staffApi = loadCloudFunction('api', db, 'staff_open_1')

  await clientApi.main({
    module: 'homeSecurity',
    action: 'updateOrderOneTimeCode',
    data: {
      orderId: 'ord_multi_off_session',
      sessionCodes: [
        { sessionIndex: 1, date: '2020-01-01', code: '111111', effectiveStart: '2020-01-01 09:30:00', effectiveEnd: '2020-01-01 11:30:00' },
        { sessionIndex: 2, date: '2099-01-01', code: '222222', effectiveStart: '2099-01-01 09:30:00', effectiveEnd: '2099-01-01 11:30:00' }
      ]
    }
  })

  // 1. 宠托师在两场次之间的跨天闲时尝试获取密码 -> 必须拦截！
  const offSessionRes = await staffApi.main({
    module: 'homeSecurity',
    action: 'getUnlockCode',
    data: { orderId: 'ord_multi_off_session' }
  })
  assert.equal(offSessionRes.ok, false)
  assert.match(offSessionRes.message, /不在服务解锁时间窗口/)
  assert.equal(db.state.unlock_code_logs.length, 1)
  assert.equal(db.state.unlock_code_logs[0].result, 'forbidden')

  // 2. 宠托师传参 sessionIndex: 2 企图提前看第 2 天密码 -> 必须拦截！
  const sneakRes = await staffApi.main({
    module: 'homeSecurity',
    action: 'getUnlockCode',
    data: { orderId: 'ord_multi_off_session', sessionIndex: 2 }
  })
  assert.equal(sneakRes.ok, false)
  assert.match(sneakRes.message, /不在服务解锁时间窗口/)

  // 3. 构建当前正在服务时间窗口内的场次订单
  const nowMs = Date.now()
  const activeSessionStart = new Date(nowMs - 15 * 60 * 1000).toISOString()
  const activeSessionEnd = new Date(nowMs + 45 * 60 * 1000).toISOString()
  const nextSessionStart = new Date(nowMs + 24 * 3600 * 1000).toISOString()
  const nextSessionEnd = new Date(nowMs + 25 * 3600 * 1000).toISOString()

  const dbActive = createCollectionStore({
    users: [
      { _id: 'u_client2', openid: 'client_open_2', roles: ['client'], status: 'active' },
      { _id: 'u_staff2', openid: 'staff_open_2', roles: ['staff'], status: 'active' }
    ],
    orders: [
      {
        _id: 'ord_active',
        orderNo: 'ORD_ACTIVE_1002',
        clientOpenid: 'client_open_2',
        staffOpenid: 'staff_open_2',
        status: 'in_service',
        startTime: activeSessionStart,
        endTime: nextSessionEnd,
        serviceSessions: [
          { index: 1, date: 'day1', startTime: activeSessionStart, endTime: activeSessionEnd, status: 'in_service' },
          { index: 2, date: 'day2', startTime: nextSessionStart, endTime: nextSessionEnd, status: 'pending' }
        ]
      }
    ],
    unlock_code_logs: [],
    order_messages: []
  })

  const clientApi2 = loadCloudFunction('api', dbActive, 'client_open_2')
  const staffApi2 = loadCloudFunction('api', dbActive, 'staff_open_2')

  await clientApi2.main({
    module: 'homeSecurity',
    action: 'updateOrderOneTimeCode',
    data: {
      orderId: 'ord_active',
      sessionCodes: [
        { sessionIndex: 1, date: 'day1', code: '999111', effectiveStart: new Date(nowMs - 30 * 60 * 1000).toISOString(), effectiveEnd: new Date(nowMs + 60 * 60 * 1000).toISOString() },
        { sessionIndex: 2, date: 'day2', code: '999222', effectiveStart: nextSessionStart, effectiveEnd: nextSessionEnd }
      ]
    }
  })

  // 处于 Session 1 时间窗口内 -> 成功获取 Session 1 密码，绝不泄露 Session 2
  const activeRes = await staffApi2.main({
    module: 'homeSecurity',
    action: 'getUnlockCode',
    data: { orderId: 'ord_active' }
  })
  assert.equal(activeRes.ok, true, `获取当前场次密码失败: ${activeRes.message}`)
  assert.equal(activeRes.data.doorLockCode, '999111')
  assert.equal(activeRes.data.sessionIndex, 1)

  // 此时试图指定 sessionIndex: 2 查看未到时场的密码 -> 依然被时间窗口防御
  const futureSessionRes = await staffApi2.main({
    module: 'homeSecurity',
    action: 'getUnlockCode',
    data: { orderId: 'ord_active', sessionIndex: 2 }
  })
  assert.equal(futureSessionRes.ok, false)
  assert.match(futureSessionRes.message, /不在服务解锁时间窗口/)
})

test('adminMall & mall: zero-pay coupon order refund approval settles safely without WeChat Pay error and restores coupon', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'client_open', roles: ['client'], status: 'active', phone: '13800138000' },
      { _id: 'u_admin', openid: 'admin_open', roles: ['admin'], status: 'active' }
    ],
    mall_products: [
      {
        _id: 'p_zero',
        name: '猫玩具',
        price: 50,
        stock: 5,
        totalStock: 5,
        salesCount: 1,
        specMode: 'single',
        skus: [{ skuId: 'default', price: 50, stock: 5, salesCount: 1 }]
      }
    ],
    mall_orders: [
      {
        _id: 'ord_mall_zero',
        orderNo: 'MO_ZERO_1',
        clientOpenid: 'client_open',
        status: 'refund_applied',
        refundStatus: 'applied',
        preRefundStatus: 'pending_ship',
        paymentStatus: 'paid',
        payAmount: 0,
        amount: 50,
        couponId: 'coup_mall_zero',
        couponAmount: 50,
        refundReason: '商品缺货，申请退货',
        items: [
          { productId: 'p_zero', skuId: 'default', quantity: 1, price: 50 }
        ]
      }
    ],
    user_coupons: [
      {
        _id: 'coup_mall_zero',
        userId: 'u_client',
        openid: 'client_open',
        status: 'used',
        usedOrderId: 'ord_mall_zero',
        usedAt: '2026-09-24 10:00:00'
      }
    ],
    admin_operation_logs: [],
    platform_configs: []
  })

  const adminApi = loadCloudFunction('api', db, 'admin_open')

  // 1. 管理员审核通过 0 元券单售后
  const auditRes = await adminApi.main({
    module: 'adminMall',
    action: 'auditRefund',
    data: {
      orderId: 'ord_mall_zero',
      approved: true,
      remark: '同意退货并结案'
    }
  })

  assert.equal(auditRes.ok, true, `审核 0 元单售后失败: ${auditRes.message}`)
  assert.equal(auditRes.data.refundStatus, 'approved')
  assert.equal(auditRes.data.zeroPayAmount, true)

  // 验证订单状态安全流转
  const updatedOrder = db.state.mall_orders.find(o => o._id === 'ord_mall_zero')
  assert.equal(updatedOrder.status, 'refunded')
  assert.equal(updatedOrder.refundStatus, 'full_refunded')
  assert.equal(updatedOrder.refundAmount, 0)
  assert.equal(updatedOrder.refundedAmount, 0)
  assert.equal(updatedOrder.stockRestored, true, '0元单未发货全额退款成功后应标记 stockRestored')

  // 验证商品库存与销量恢复
  const updatedProd = db.state.mall_products.find(p => p._id === 'p_zero')
  assert.equal(updatedProd.stock, 6, '商品库存应从 5 恢复为 6')
  assert.equal(updatedProd.salesCount, 0, '商品销量应从 1 恢复为 0')

  // 验证优惠券被原路恢复为 available
  const updatedCoupon = db.state.user_coupons.find(c => c._id === 'coup_mall_zero')
  assert.equal(updatedCoupon.status, 'available')
  assert.equal(updatedCoupon.usedOrderId, '')

  // 2. 并发/重复审核拦截（乐观锁验证）
  const duplicateAuditRes = await adminApi.main({
    module: 'adminMall',
    action: 'auditRefund',
    data: {
      orderId: 'ord_mall_zero',
      approved: false,
      remark: '重复点击拒绝'
    }
  })
  assert.equal(duplicateAuditRes.ok, false)
  assert.match(duplicateAuditRes.message, /当前订单没有待审核售后/)
})

test('auth: bindPhone strictly validates 11-digit mainland format and rejects invalid inputs', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'client_open_test', roles: ['client'], status: 'active', phone: '13800000000' }
    ],
    orders: [
      { _id: 'ord_client_1', clientOpenid: 'client_open_test', contactPhone: '13800000000', status: 'assigned' }
    ]
  })

  const authApi = loadCloudFunction('api', db, 'client_open_test')

  // 1. 空手机号
  const resEmpty = await authApi.main({
    module: 'auth',
    action: 'bindPhone',
    data: { phone: '' }
  })
  assert.equal(resEmpty.ok, false)
  assert.match(resEmpty.message, /手机号不能为空/)

  // 2. 长度不足 11 位
  const resShort = await authApi.main({
    module: 'auth',
    action: 'bindPhone',
    data: { phone: '1381234567' }
  })
  assert.equal(resShort.ok, false)
  assert.match(resShort.message, /请输入有效的11位手机号码/)

  // 3. 超过 11 位
  const resLong = await authApi.main({
    module: 'auth',
    action: 'bindPhone',
    data: { phone: '138123456789' }
  })
  assert.equal(resLong.ok, false)
  assert.match(resLong.message, /请输入有效的11位手机号码/)

  // 4. 非 1 开头
  const resNonOne = await authApi.main({
    module: 'auth',
    action: 'bindPhone',
    data: { phone: '23812345678' }
  })
  assert.equal(resNonOne.ok, false)
  assert.match(resNonOne.message, /请输入有效的11位手机号码/)

  // 5. 包含非数字字符
  const resAlpha = await authApi.main({
    module: 'auth',
    action: 'bindPhone',
    data: { phone: '1381234abcd' }
  })
  assert.equal(resAlpha.ok, false)
  assert.match(resAlpha.message, /请输入有效的11位手机号码/)

  // 6. 合法 11 位大陆手机号码绑定成功并同步订单联系电话
  const resValid = await authApi.main({
    module: 'auth',
    action: 'bindPhone',
    data: { phone: '13987654321' }
  })
  assert.equal(resValid.ok, true)
  assert.equal(resValid.data.phone, '13987654321')

  const userDoc = db.state.users.find(u => u.openid === 'client_open_test')
  assert.equal(userDoc.phone, '13987654321')

  const orderDoc = db.state.orders.find(o => o._id === 'ord_client_1')
  assert.equal(orderDoc.contactPhone, '13987654321')
})
