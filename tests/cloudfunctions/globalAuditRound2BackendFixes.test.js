const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const createAdminHandler = require('../../cloudfunctions/api/handlers/admin')
const createAiHandler = require('../../cloudfunctions/api/handlers/ai')
const createStaffDepositRefunds = require('../../cloudfunctions/api/services/staffDepositRefunds')

function cappedStoreLimit(initial = {}, defaultLimit = 20) {
  const db = createCollectionStore(initial)
  const origCollection = db.collection.bind(db)
  db.collection = (name) => {
    const col = origCollection(name)
    const origGet = col.get.bind(col)
    col.get = async function () {
      const res = await origGet()
      const max = col._limit !== null ? Math.min(col._limit, 100) : defaultLimit
      return { data: (res.data || []).slice(0, max) }
    }
    return col
  }
  return db
}

test('B1: autoRefundStaffDeposit persists PROCESSING state, queries correct V3 endpoint on retry, and syncs to refunded', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'admin_1', roles: ['admin'], status: 'active' },
      { _id: 'u_staff', openid: 'staff_1', roles: ['client', 'staff'], activeRole: 'staff', status: 'active' }
    ],
    staff_profiles: [
      { _id: 'sp_1', userId: 'u_staff', openid: 'staff_1', auditStatus: 'approved', staffLevel: 'certified', depositStatus: 'paid', currentDepositId: 'dep_1' }
    ],
    staff_deposits: [
      {
        _id: 'dep_1',
        staffOpenid: 'staff_1',
        staffUserId: 'u_staff',
        staffProfileId: 'sp_1',
        amount: 200,
        paidAmount: 200,
        refundedAmount: 0,
        forfeitedAmount: 0,
        availableRefundAmount: 200,
        status: 'paid',
        paymentNo: 'PAY_200',
        wxTransactionId: 'WX_TX_200',
        paymentChannel: 'wechat',
        createdAt: '2026-08-01 10:00:00',
        paidAt: '2026-08-01 10:01:00'
      }
    ],
    payments: [
      { _id: 'pay_1', orderId: 'dep_1', depositId: 'dep_1', targetType: 'staff_deposit', openid: 'staff_1', status: 'success', channel: 'wechat', amount: 200, paymentNo: 'PAY_200', wxTransactionId: 'WX_TX_200' }
    ],
    staff_earnings: [],
    withdraw_requests: [],
    staff_deposit_events: [],
    finance_logs: [],
    admin_operation_logs: [],
    refunds: []
  })

  const gatewayCalls = []
  let phase = 'processing'
  const ctx = createContext({ db, cloud: {} })
  ctx.getSystemSettings = async () => ({
    staffDeposit: { enabled: true, amount: 200 },
    payment: { mode: 'wechat', refundEnabled: true }
  })
  ctx.getWechatPayConfig = () => ({ mchId: 'MCH_1', appId: 'APP_1', refundEnabled: true })
  ctx.wechatPayRequest = async (method, path, body) => {
    gatewayCalls.push({ method, path, body })
    if (phase === 'processing' && method === 'POST') {
      return {
        status: 'PROCESSING',
        refund_id: 'WX_REF_PROC_1',
        out_refund_no: body.out_refund_no,
        out_trade_no: 'PAY_200',
        transaction_id: 'WX_TX_200',
        amount: body.amount
      }
    }
    if (phase === 'duplicate_error' && method === 'POST') {
      throw new Error('duplicate out_refund_no')
    }
    if (method === 'GET') {
      return {
        status: phase === 'success' ? 'SUCCESS' : 'PROCESSING',
        refund_id: 'WX_REF_PROC_1',
        out_refund_no: path.split('/').pop(),
        out_trade_no: 'PAY_200',
        transaction_id: 'WX_TX_200',
        amount: { refund: 20000, total: 20000, currency: 'CNY' }
      }
    }
    return { status: 'PROCESSING', refund_id: 'WX_REF_PROC_1' }
  }
  ctx.checkTextSecurity = async () => {}
  const refundSync = createStaffDepositRefunds({ ...ctx, crypto })
  ctx.syncStaffDepositRefund = refundSync.syncStaffDepositRefund
  const adminHandler = createAdminHandler(ctx)

  const res1 = await adminHandler('admin_1', 'autoRefundStaffDeposit', { id: 'dep_1', reason: '原路退还测试' })
  assert.equal(res1.status, 'refunding')
  assert.equal(res1.refundStatus, 'processing')

  const depAfterProc = db.state.staff_deposits.find(d => d._id === 'dep_1')
  assert.equal(depAfterProc.status, 'refunding')
  assert.equal(depAfterProc.refundStatus, 'processing')
  assert.equal(depAfterProc.approvedRefundAmount, 200)
  assert.equal(depAfterProc.wechatRefundId, 'WX_REF_PROC_1')
  assert.equal(depAfterProc.refundNo, res1.refundNo)

  // Verify V3 retry query path has no /out-refund-no/ segment and sync transitions PROCESSING -> refunded
  depAfterProc.refundNextCheckAt = new Date(0)
  phase = 'success'
  const syncRes = await adminHandler('admin_1', 'syncDepositRefund', { id: 'dep_1' })
  assert.equal(syncRes.status, 'refunded')
  assert.equal(syncRes.refundStatus, 'success')
  const getCall = gatewayCalls.find(c => c.method === 'GET')
  assert.ok(getCall && !getCall.path.includes('/out-refund-no/'), `Expected valid V3 refund query path, got ${getCall && getCall.path}`)
  assert.equal(db.state.staff_deposits[0].status, 'refunded')
  assert.deepEqual(db.state.users.find(u => u._id === 'u_staff').roles, ['client'])
})

test('B1b: autoRefundStaffDeposit duplicate error fallback queries /v3/refund/domestic/refunds/{refundNo}', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'admin_1', roles: ['admin'], status: 'active' },
      { _id: 'u_staff', openid: 'staff_1', roles: ['client', 'staff'], activeRole: 'staff', status: 'active' }
    ],
    staff_profiles: [
      { _id: 'sp_1', userId: 'u_staff', openid: 'staff_1', auditStatus: 'approved', staffLevel: 'certified', depositStatus: 'paid', currentDepositId: 'dep_1' }
    ],
    staff_deposits: [
      { _id: 'dep_1', staffOpenid: 'staff_1', staffUserId: 'u_staff', staffProfileId: 'sp_1', amount: 100, paidAmount: 100, refundedAmount: 0, forfeitedAmount: 0, availableRefundAmount: 100, status: 'paid', paymentNo: 'PAY_1', wxTransactionId: 'WX_1', paymentChannel: 'wechat', createdAt: '2026-08-01 10:00:00', paidAt: '2026-08-01 10:01:00' }
    ],
    payments: [
      { _id: 'pay_1', orderId: 'dep_1', depositId: 'dep_1', targetType: 'staff_deposit', openid: 'staff_1', status: 'success', channel: 'wechat', amount: 100, paymentNo: 'PAY_1', wxTransactionId: 'WX_1' }
    ],
    staff_earnings: [],
    withdraw_requests: [],
    refunds: [],
    finance_logs: [],
    staff_deposit_events: [],
    admin_operation_logs: []
  })
  const paths = []
  const ctx = createContext({ db, cloud: {} })
  ctx.getSystemSettings = async () => ({ staffDeposit: { enabled: true, amount: 100 }, payment: { mode: 'wechat', refundEnabled: true } })
  ctx.getWechatPayConfig = () => ({ mchId: 'MCH', appId: 'APP', refundEnabled: true })
  ctx.wechatPayRequest = async (method, path) => {
    paths.push(`${method} ${path}`)
    if (method === 'POST') throw new Error('already exists')
    return { status: 'SUCCESS', refund_id: 'WX_REF_DUP_1' }
  }
  ctx.checkTextSecurity = async () => {}
  const res = await createAdminHandler(ctx)('admin_1', 'autoRefundStaffDeposit', { id: 'dep_1', reason: '重试恢复' })
  assert.equal(res.status, 'refunded')
  assert.equal(paths[1], `GET /v3/refund/domestic/refunds/${res.refundNo}`)
})

test('B3: admin.auditStaff rejection does not mutate profile or identity when staff funds check fails', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'admin_1', roles: ['admin'], status: 'active' },
      { _id: 'u_staff', openid: 'staff_1', roles: ['client', 'staff'], activeRole: 'staff', status: 'active' }
    ],
    staff_profiles: [
      { _id: 'sp_1', openid: 'staff_1', realName: '李四', gender: 'female', auditStatus: 'approved', staffLevel: 'certified', onboardingStatus: 'certified' }
    ],
    staff_identity_verifications: [
      { _id: 'idv_1', staffProfileId: 'sp_1', auditStatus: 'approved', identityStatus: 'verified' }
    ],
    staff_earnings: [
      { _id: 'e_1', staffOpenid: 'staff_1', status: 'available', amount: 50 }
    ],
    withdraw_requests: [],
    staff_deposits: [],
    admin_operation_logs: []
  })

  const api = loadCloudFunction('api', db, 'admin_1')
  const blockedRes = await api.main({
    module: 'admin',
    action: 'auditStaff',
    data: { staffProfileId: 'sp_1', auditStatus: 'rejected', auditRemark: '需先结清' }
  })
  assert.equal(blockedRes.ok, false)
  // Must remain completely unchanged prior to settlement
  assert.equal(db.state.staff_profiles[0].auditStatus, 'approved')
  assert.equal(db.state.staff_identity_verifications[0].auditStatus, 'approved')
  assert.deepEqual(db.state.users.find(u => u._id === 'u_staff').roles, ['client', 'staff'])

  // Settle earnings, then retry rejection succeeds cleanly
  db.state.staff_earnings[0].status = 'paid'
  const okRes = await api.main({
    module: 'admin',
    action: 'auditStaff',
    data: { staffProfileId: 'sp_1', auditStatus: 'rejected', auditRemark: '清退后驳回' }
  })
  assert.equal(okRes.ok, true)
  assert.equal(db.state.staff_profiles[0].auditStatus, 'rejected')
  assert.equal(db.state.staff_identity_verifications[0].auditStatus, 'rejected')
  assert.equal(db.state.staff_identity_verifications[0].identityStatus, 'failed')
  assert.deepEqual(db.state.users.find(u => u._id === 'u_staff').roles, ['client'])
})

test('B4: adminNotifications tracks read state per admin without clearing badge for other admins', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'a1', openid: 'admin_1', roles: ['admin'], status: 'active' },
      { _id: 'a2', openid: 'admin_2', roles: ['admin'], status: 'active' }
    ],
    admin_notifications: [
      { _id: 'n1', type: 'refund_failure', title: '告警1', content: '详情1', level: 'urgent', read: false, readBy: [], createdAt: '2026-09-01 10:00:00' },
      { _id: 'n2', type: 'refund_failure', title: '告警2', content: '详情2', level: 'info', read: false, readBy: [], createdAt: '2026-09-01 11:00:00' }
    ]
  })
  const api1 = loadCloudFunction('api', db, 'admin_1')
  const api2 = loadCloudFunction('api', db, 'admin_2')

  await api1.main({ module: 'admin', action: 'markAdminNotificationRead', data: { id: 'n1' } })
  const b1 = await api1.main({ module: 'admin', action: 'getAdminNotificationBadge' })
  const b2 = await api2.main({ module: 'admin', action: 'getAdminNotificationBadge' })
  assert.equal(b1.data.unreadCount, 1)
  assert.equal(b2.data.unreadCount, 2)

  await api1.main({ module: 'admin', action: 'markAdminNotificationRead', data: { all: true } })
  const b1All = await api1.main({ module: 'admin', action: 'getAdminNotificationBadge' })
  const b2AfterAll = await api2.main({ module: 'admin', action: 'getAdminNotificationBadge' })
  const list2Unread = await api2.main({ module: 'admin', action: 'listAdminNotifications', data: { status: 'unread' } })
  assert.equal(b1All.data.unreadCount, 0)
  assert.equal(b2AfterAll.data.unreadCount, 2)
  assert.equal(list2Unread.data.list.length, 2)

  // Exceeding 2000 historical read:false records must not starve newer alerts
  const manyNotices = Array.from({ length: 2050 }, (_, i) => ({
    _id: `hist_${String(i + 1).padStart(4, '0')}`,
    type: 'refund_failure',
    title: `历史告警${i + 1}`,
    content: 'c',
    level: i === 2049 ? 'urgent' : 'info',
    read: false,
    readBy: i < 2049 ? ['admin_2'] : [],
    createdAt: '2026-09-02 10:00:00'
  }))
  db.state.admin_notifications = manyNotices
  const b2Past2000 = await api2.main({ module: 'admin', action: 'getAdminNotificationBadge' })
  assert.equal(b2Past2000.data.unreadCount, 1)
  assert.equal(b2Past2000.data.latestUrgent._id, 'hist_2050')
})

test('B6: safeCollectionData paginates beyond default 20-doc cap while respecting explicit limits', async () => {
  const staffProfiles = Array.from({ length: 35 }, (_, i) => ({
    _id: `sp_${String(i + 1).padStart(2, '0')}`,
    openid: `staff_${i + 1}`,
    auditStatus: 'approved',
    staffLevel: 'certified',
    depositStatus: 'paid',
    acceptOrders: true,
    realName: `托师${i + 1}`,
    ratingAverage: 4.5 + (i === 24 ? 0.5 : 0),
    isFeatured: i === 24,
    updatedAt: `2026-09-01 10:${String(35 - i).padStart(2, '0')}:00`
  }))
  const users = staffProfiles.map((p, i) => ({ _id: `u_${i}`, openid: p.openid, nickname: p.realName, roles: ['staff'] }))
  const orders = Array.from({ length: 8 }, (_, i) => ({
    _id: `ord_${i}`,
    status: 'completed',
    clientOpenid: 'c_1',
    staffProfileId: 'sp_01',
    createdAt: `2026-09-01 09:0${i}:00`,
    completedAt: `2026-09-01 10:0${i}:00`
  }))
  const checkins = Array.from({ length: 30 }, (_, i) => ({
    _id: `chk_${i}`,
    orderId: `ord_${i % 6}`,
    mediaFileId: `cloud://photo_${i}`,
    createdAt: `2026-09-01 10:00:${String(i).padStart(2, '0')}`
  }))

  const db = cappedStoreLimit({
    staff_profiles: staffProfiles,
    users: [...users, { _id: 'uc', openid: 'c_1', nickname: '客户' }],
    orders,
    checkin_logs: checkins,
    service_reviews: [],
    coupon_templates: [],
    user_coupons: []
  }, 20)
  const ctx = createContext({ db, cloud: {} })
  const rows = await ctx.safeCollectionData('staff_profiles', (col) => col.where({ auditStatus: 'approved' }).orderBy('updatedAt', 'desc'))
  assert.equal(rows.length, 35, 'safeCollectionData without limit() must return all 35 rows past default 20 cap')
  const explicit = await ctx.safeCollectionData('orders', (col) => col.where({ status: 'completed' }).orderBy('createdAt', 'desc').limit(6))
  assert.equal(explicit.length, 6, 'safeCollectionData with explicit .limit(6) must respect 6')

  const sysFn = loadCloudFunction('api', db, 'c_1')
  const home = await sysFn.main({ module: 'system', action: 'getHomePageData', data: {} })
  assert.equal(home.ok, true)
  // Featured sitter at index 24 (beyond default 20) must be included in top sitters
  assert.ok(home.data.featuredSitters.some(s => s._id === 'sp_25'), 'featured sitter past doc 20 must not be truncated')
})

test('B7: petBeauty, userAssets expiry, grab notifications, sitter batching, and getStaffDepositDetail avoid caps', async () => {
  // 7a. petBeauty > 1000 raw pets
  const deletedPets = Array.from({ length: 1005 }, (_, i) => ({
    _id: `pet_del_${String(i).padStart(4, '0')}`,
    openid: 'o1',
    name: '已删',
    deletedAt: '2026-01-01'
  }))
  const dbBeauty = createCollectionStore({
    users: [{ _id: 'u1', openid: 'o1', roles: ['client'], status: 'active' }],
    pets: [
      ...deletedPets,
      { _id: 'pet_live_1006', openid: 'o1', name: '尾号萌宠', species: 'cat', avatarFileId: 'cloud://avatar_1006', beautyPhotos: [{ id: 'bp1', fileId: 'cloud://p1006' }] }
    ],
    pet_beauty_votes: [],
    pet_beauty_month_locks: []
  })
  const beautyApi = loadCloudFunction('api', dbBeauty, 'o1')
  const candRes = await beautyApi.main({ module: 'petBeauty', action: 'listCandidates', data: {} })
  assert.equal(candRes.ok, true)
  assert.equal(candRes.data.total, 1)
  assert.equal(candRes.data.list[0].petId, 'pet_live_1006')

  // 7b. userAssets > 1000 available earnings
  const longLived = Array.from({ length: 1005 }, (_, i) => ({
    _id: `uae_${String(i).padStart(4, '0')}`,
    userOpenid: 'u_a',
    sourceType: 'invite_binding',
    status: 'available',
    amount: 10,
    createdAt: '2099-01-01 00:00:00',
    expiresAt: '2099-02-01 00:00:00'
  }))
  const dbAssets = createCollectionStore({
    user_asset_earnings: [
      ...longLived,
      { _id: 'uae_9999_expired', userOpenid: 'u_b', sourceType: 'invite_binding', status: 'available', amount: 15, createdAt: '2020-01-01 00:00:00', expiresAt: '2020-02-01 00:00:00' }
    ]
  })
  const assetCtx = createContext({ db: dbAssets, cloud: {} })
  const expRes = await assetCtx.expireDueUserAssetEarnings()
  assert.equal(expRes.count, 1)
  assert.equal(expRes.totalAmount, 15)
  assert.equal(dbAssets.state.user_asset_earnings.find(r => r._id === 'uae_9999_expired').status, 'expired')

  // 7c. publicOrderGrabNotifications > 300 approved sitters
  const farSitters = Array.from({ length: 305 }, (_, i) => ({
    _id: `sp_${String(i).padStart(3, '0')}`,
    openid: `s_${i}`,
    auditStatus: 'approved',
    staffLevel: 'certified',
    depositStatus: 'paid',
    acceptOrders: true,
    serviceAddress: '远郊',
    serviceLatitude: 0,
    serviceLongitude: 0
  }))
  const nearSitter = {
    _id: 'sp_999_near',
    openid: 's_near',
    auditStatus: 'approved',
    staffLevel: 'certified',
    depositStatus: 'paid',
    acceptOrders: true,
    serviceAddress: '上海市浦东新区',
    serviceLatitude: 31.23,
    serviceLongitude: 121.47,
    serviceRadiusKm: 10,
    weeklySchedule: { mon: [{ start: '08:00', end: '22:00' }], tue: [{ start: '08:00', end: '22:00' }], wed: [{ start: '08:00', end: '22:00' }], thu: [{ start: '08:00', end: '22:00' }], fri: [{ start: '08:00', end: '22:00' }], sat: [{ start: '08:00', end: '22:00' }], sun: [{ start: '08:00', end: '22:00' }] }
  }
  const dbGrab = createCollectionStore({
    staff_profiles: [...farSitters, nearSitter],
    orders: [],
    staff_schedule_exceptions: [],
    subscription_logs: []
  })
  const grabCtx = createContext({ db: dbGrab, cloud: {} })
  const notified = []
  grabCtx.getSystemSettings = async () => ({ subscription: { enabled: true }, dispatch: { maxPublicGrabRecipients: 8 }, staffDeposit: { enabled: false } })
  grabCtx.sendSubscribeMessage = async (openid) => { notified.push(openid); return { status: 'sent' } }
  grabCtx.validateStaffScheduleOnly = async () => true
  grabCtx.findStaffOrderConflict = async () => null
  const createGrab = require('../../cloudfunctions/api/services/publicOrderGrabNotifications')
  const grabRes = await createGrab(grabCtx).notifyEligibleSittersForPublicOrder({
    _id: 'ord_pub_1',
    clientOpenid: 'c_1',
    status: 'paid',
    paymentStatus: 'paid',
    publishMode: 'open',
    addressLatitude: 31.231,
    addressLongitude: 121.471,
    startTime: new Date(Date.now() + 2 * 3600000).toISOString(),
    endTime: new Date(Date.now() + 3 * 3600000).toISOString(),
    payAmount: 50
  })
  assert.equal(grabRes.notifiedCount, 1)
  assert.deepEqual(notified, ['s_near'])

  // 7d. staffProfiles.batchWithSitterUserProfiles > 100 profiles
  const profiles120 = Array.from({ length: 120 }, (_, i) => ({ _id: `sp_${i}`, openid: `u_${i}` }))
  const users120 = Array.from({ length: 120 }, (_, i) => ({ _id: `user_${i}`, openid: `u_${i}`, nickname: `昵称${i}`, avatarUrl: `https://a/${i}` }))
  const dbSp = createCollectionStore({ users: users120 })
  const spCtx = createContext({ db: dbSp, cloud: {} })
  const enriched120 = await spCtx.batchWithSitterUserProfiles(profiles120)
  assert.equal(enriched120[119].nickname, '昵称119')
  assert.equal(enriched120[119].avatarUrl, 'https://a/119')

  // 7e. getStaffDepositDetail aggregates multiple deposits & >20 events
  const dbDep = createCollectionStore({
    users: [
      { _id: 'ua', openid: 'admin_1', roles: ['admin'], status: 'active' },
      { _id: 'us', openid: 'staff_1', roles: ['staff'], status: 'active' }
    ],
    staff_profiles: [{ _id: 'sp_1', openid: 'staff_1', auditStatus: 'approved', depositStatus: 'paid' }],
    staff_deposits: [
      { _id: 'dep_old', staffOpenid: 'staff_1', status: 'paid', paidAmount: 300, refundedAmount: 0, forfeitedAmount: 50, availableRefundAmount: 250, createdAt: '2026-01-01' },
      { _id: 'dep_new', staffOpenid: 'staff_1', status: 'paid', paidAmount: 200, refundedAmount: 0, forfeitedAmount: 0, availableRefundAmount: 200, createdAt: '2026-06-01' }
    ],
    staff_deposit_events: Array.from({ length: 25 }, (_, i) => ({
      _id: `ev_${i}`,
      staffOpenid: 'staff_1',
      type: 'pay',
      amount: 10,
      reason: `记录${i}`,
      createdAt: `2026-01-${String(i + 1).padStart(2, '0')}`
    }))
  })
  const depApi = loadCloudFunction('api', dbDep, 'admin_1')
  const detailRes = await depApi.main({ module: 'admin', action: 'getStaffDepositDetail', data: { staffOpenid: 'staff_1' } })
  assert.equal(detailRes.ok, true)
  assert.equal(detailRes.data.paidAmount, 500)
  assert.equal(detailRes.data.forfeitedAmount, 50)
  assert.equal(detailRes.data.availableRefundAmount, 450)
  assert.equal(detailRes.data.events.length, 25)
})

test('B8 & F6: admin finance actions forward page param and admin.listOrders keyword matches clientOpenid/staffOpenid', async () => {
  const logs = Array.from({ length: 25 }, (_, i) => ({
    _id: `log_${String(i + 1).padStart(2, '0')}`,
    action: 'order_paid',
    targetType: 'order',
    targetId: `o_${i + 1}`,
    amountDelta: 10,
    createdAt: `2026-09-01 ${String(25 - i).padStart(2, '0')}:00:00`
  }))
  const payments = Array.from({ length: 25 }, (_, i) => ({
    _id: `pay_${String(i + 1).padStart(2, '0')}`,
    orderId: `o_${i + 1}`,
    paymentNo: `P${i + 1}`,
    status: 'success',
    amount: 100,
    paidAt: `2026-09-01 ${String(25 - i).padStart(2, '0')}:00:00`,
    createdAt: `2026-09-01 ${String(25 - i).padStart(2, '0')}:00:00`
  }))
  const db = createCollectionStore({
    users: [{ _id: 'ua', openid: 'admin_1', roles: ['admin'], status: 'active' }],
    finance_logs: logs,
    payments,
    orders: [
      { _id: 'o_client_match', orderNo: 'ORD001', clientOpenid: 'openid_target_user', staffOpenid: 'openid_other', status: 'paid', createdAt: '2026-09-01 10:00:00' },
      { _id: 'o_staff_match', orderNo: 'ORD002', clientOpenid: 'openid_other2', staffOpenid: 'openid_target_user', status: 'assigned', createdAt: '2026-09-01 11:00:00' },
      { _id: 'o_unrelated', orderNo: 'ORD003', clientOpenid: 'openid_x', staffOpenid: 'openid_y', status: 'paid', createdAt: '2026-09-01 12:00:00' }
    ]
  })
  const adminApi = loadCloudFunction('api', db, 'admin_1')
  const logsP1 = await adminApi.main({ module: 'admin', action: 'listFinanceLogs', data: { page: 1, pageSize: 10 } })
  const logsP2 = await adminApi.main({ module: 'admin', action: 'listFinanceLogs', data: { page: 2, pageSize: 10 } })
  assert.equal(logsP1.data.length, 10)
  assert.equal(logsP2.data.length, 10)
  assert.notEqual(logsP1.data[0]._id, logsP2.data[0]._id)

  const payP1 = await adminApi.main({ module: 'admin', action: 'listPayments', data: { page: 1, pageSize: 10 } })
  const payP2 = await adminApi.main({ module: 'admin', action: 'listPayments', data: { page: 2, pageSize: 10 } })
  assert.notEqual(payP1.data[0]._id, payP2.data[0]._id)

  const ordersRes = await adminApi.main({ module: 'admin', action: 'listOrders', data: { keyword: 'openid_target_user' } })
  assert.equal(ordersRes.ok, true)
  assert.deepEqual(ordersRes.data.list.map(o => o._id).sort(), ['o_client_match', 'o_staff_match'])
})

test('B9: ai.generatePetVoice runs checkTextSecurity before picking returned voiceMessage', async () => {
  const aiHandler = createAiHandler({
    cloud: {
      ai: () => ({
        createModel: () => ({
          generateText: async () => ({
            choices: [{ message: { content: JSON.stringify(['违规违禁第一条心声内容', '今天散步好开心想多贴贴呀']) } }]
          })
        })
      })
    },
    db: createCollectionStore({}),
    safeText: v => String(v || ''),
    nowText: () => '2026-09-01 10:00:00',
    getUser: async () => ({ _id: 'u1' }),
    checkRateLimit: async () => {},
    checkTextSecurity: async (_, content) => {
      if (String(content).includes('违规')) throw new Error('内容不合规')
    }
  })

  const res = await aiHandler('u1', 'generatePetVoice', { pet: { name: '豆豆', species: 'dog' }, dateKey: '2026-09-01' })
  assert.equal(res.voiceMessage, '今天散步好开心想多贴贴呀')
  assert.equal(res.source, 'hy3')
})

