const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')

function createTestContext(initial = {}) {
  const db = createCollectionStore(initial)
  const context = createContext({ db, cloud: {} })
  return { db, context }
}

test('petBeauty: importFromServiceCheckins succeeds without ReferenceError and handles checkin photos', async () => {
  const { db, context } = createTestContext({
    users: [
      { _id: 'u_client', openid: 'client_1', roles: ['client'] }
    ],
    pets: [
      { _id: 'pet_1', openid: 'client_1', name: '大黄', beautyPhotos: [] }
    ],
    orders: [
      { _id: 'ord_1', clientOpenid: 'client_1', petIds: ['pet_1'], status: 'completed' }
    ],
    checkin_logs: [
      { _id: 'chk_1', orderId: 'ord_1', eventType: 'pet_beauty_photo', mediaFileId: 'cloud://photo1.jpg', recordedAt: '2026-09-23 10:00' },
      { _id: 'chk_2', orderId: 'ord_1', eventType: 'pet_beauty_photo', mediaFileId: 'cloud://photo2.jpg', recordedAt: '2026-09-23 10:05' }
    ]
  })

  const handler = require('../../cloudfunctions/api/handlers/petBeauty')({
    ...context,
    getUser: async () => ({ _id: 'u_client', openid: 'client_1', roles: ['client'] }),
    requireClientOrder: async () => ({
      user: { _id: 'u_client', openid: 'client_1' },
      order: { _id: 'ord_1', clientOpenid: 'client_1', petIds: ['pet_1'], status: 'completed' }
    })
  })

  const res = await handler('client_1', 'importFromServiceCheckins', {
    orderId: 'ord_1',
    petId: 'pet_1',
    checkinIds: ['chk_1', 'chk_2']
  })

  assert.equal(res.petId, 'pet_1')
  assert.equal(res.importedCount, 2)
  assert.equal(res.beautyPhotos.length, 2)
  assert.equal(res.beautyPhotos[0].fileId, 'cloud://photo1.jpg')
  assert.equal(res.beautyPhotos[1].fileId, 'cloud://photo2.jpg')

  // 验证写回 pets 集合
  const petInDb = (await db.collection('pets').doc('pet_1').get()).data
  assert.equal(petInDb.beautyPhotos.length, 2)
  assert.equal(petInDb.avatarFileId, 'cloud://photo1.jpg')
})

test('petBeauty: non-existent pet returns friendly error instead of unhandled crash', async () => {
  const { db, context } = createTestContext({
    pets: []
  })

  const handler = require('../../cloudfunctions/api/handlers/petBeauty')({
    ...context,
    getUser: async () => ({ _id: 'u_client', openid: 'client_1', roles: ['client'] }),
    toCstParts: () => ({ dayNumber: 1 })
  })

  await assert.rejects(
    () => handler('client_1', 'deleteBeautyPhoto', { petId: 'pet_non_existent', photoId: 'photo_1' }),
    { message: '宠物不存在' }
  )
})

test('message & staffMessage: non-existent threadId returns friendly error instead of document does not exist crash', async () => {
  const { db, context } = createTestContext({
    order_message_threads: [],
    order_staff_message_threads: []
  })

  const clientMsgHandler = require('../../cloudfunctions/api/handlers/message')({
    ...context,
    getUser: async () => ({ _id: 'u_1', openid: 'client_1' })
  })

  const staffMsgHandler = require('../../cloudfunctions/api/handlers/staffMessage')({
    ...context,
    getUser: async () => ({ _id: 'u_2', openid: 'staff_1', roles: ['staff'] })
  })

  // 客户端获取不存在的会话
  await assert.rejects(
    () => clientMsgHandler('client_1', 'getThreadMessages', { threadId: 'not_exist_thread' }),
    { message: '消息会话不存在' }
  )

  // 客户端标记不存在的会话为已读
  await assert.rejects(
    () => clientMsgHandler('client_1', 'markThreadRead', { threadId: 'not_exist_thread' }),
    { message: '消息会话不存在' }
  )

  // 宠托师获取不存在的会话
  await assert.rejects(
    () => staffMsgHandler('staff_1', 'getThreadMessages', { threadId: 'not_exist_thread' }),
    { message: '消息会话不存在' }
  )

  // 宠托师标记不存在的会话为已读
  await assert.rejects(
    () => staffMsgHandler('staff_1', 'markThreadRead', { threadId: 'not_exist_thread' }),
    { message: '消息会话不存在' }
  )
})

test('rewardMail: markRead and claimReward with non-existent id returns friendly error', async () => {
  const { db, context } = createTestContext({
    reward_mails: []
  })

  const handler = require('../../cloudfunctions/api/handlers/rewardMail')({
    ...context,
    getUser: async () => ({ _id: 'u_1', openid: 'client_1' })
  })

  await assert.rejects(
    () => handler('client_1', 'markRead', { id: 'mail_not_exist' }),
    { message: '奖励邮件不存在' }
  )

  await assert.rejects(
    () => handler('client_1', 'claimReward', { id: 'mail_not_exist' }),
    { message: '奖励邮件不存在' }
  )
})

test('order: getPublicCompletedOrderDetail returns friendly error on non-existent order', async () => {
  const { db, context } = createTestContext({
    orders: []
  })

  const handler = require('../../cloudfunctions/api/handlers/order')({
    ...context
  })

  await assert.rejects(
    () => handler('any_user', 'getPublicCompletedOrderDetail', { orderId: 'ord_not_exist' }),
    { message: '订单不可查看' }
  )
})

test('staff: checkAcceptOrderRisk and acceptOrder return friendly error on non-existent order', async () => {
  const { db, context } = createTestContext({
    staff_profiles: [
      { _id: 'sp_1', openid: 'staff_1', status: 'approved', serviceLatitude: 30.1, serviceLongitude: 120.1, serviceAddress: '杭州市' }
    ],
    orders: []
  })

  const handler = require('../../cloudfunctions/api/handlers/staff')({
    ...context,
    getUser: async () => ({ _id: 'u_staff', openid: 'staff_1', roles: ['staff'] }),
    getSystemSettings: async () => ({ staffDeposit: 0 }),
    validateStaffTakeOrderAbility: () => ({ can: true })
  })

  await assert.rejects(
    () => handler('staff_1', 'checkAcceptOrderRisk', { orderId: 'ord_not_exist' }),
    { message: '订单不存在' }
  )

  await assert.rejects(
    () => handler('staff_1', 'acceptOrder', { orderId: 'ord_not_exist' }),
    { message: '订单不存在' }
  )
})

test('admin: assignOrder and updateOrderStatus return friendly error on non-existent order', async () => {
  const { db, context } = createTestContext({
    orders: [],
    staff_profiles: [{ _id: 'sp_1', openid: 'staff_1' }]
  })

  const handler = require('../../cloudfunctions/api/handlers/admin')({
    ...context,
    requireAdmin: async () => ({ _id: 'admin_1', openid: 'admin_openid', roles: ['admin'] })
  })

  await assert.rejects(
    () => handler('admin_openid', 'assignOrder', { orderId: 'ord_not_exist', staffProfileId: 'sp_1' }),
    { message: '订单不存在' }
  )

  await assert.rejects(
    () => handler('admin_openid', 'updateOrderStatus', { id: 'ord_not_exist', status: 'completed', remark: '测试核实' }),
    { message: '订单不存在' }
  )
})

test('incident: getIncidentDetail gracefully handles non-existent linked order without crashing', async () => {
  const { db, context } = createTestContext({
    order_incidents: [
      { _id: 'inc_1', clientOpenid: 'client_1', orderId: 'ord_deleted', title: '投诉问题' }
    ],
    orders: []
  })

  const handler = require('../../cloudfunctions/api/handlers/incident')({
    ...context,
    getIncidentForAccess: async () => ({
      user: { _id: 'u_1', openid: 'client_1', roles: ['client'] },
      incident: { _id: 'inc_1', clientOpenid: 'client_1', orderId: 'ord_deleted', title: '投诉问题' }
    })
  })

  const detail = await handler('client_1', 'getIncidentDetail', { incidentId: 'inc_1' })
  assert.equal(detail.incident._id, 'inc_1')
  assert.equal(detail.order, null)
})

test('homeSecurity: requestRemoteUnlock and recordKeyReturned return friendly error on non-existent order', async () => {
  const { db, context } = createTestContext({
    orders: []
  })

  const handler = require('../../cloudfunctions/api/handlers/homeSecurity')({
    ...context,
    getUser: async () => ({ _id: 'u_staff', openid: 'staff_1', roles: ['staff'] })
  })

  await assert.rejects(
    () => handler('staff_1', 'requestRemoteUnlock', { orderId: 'ord_not_exist' }),
    { message: '订单不存在' }
  )

  await assert.rejects(
    () => handler('staff_1', 'recordKeyReturned', { orderId: 'ord_not_exist' }),
    { message: '订单不存在' }
  )
})

test('checkin: deleteCheckin returns friendly error when checkin does not exist', async () => {
  const { db, context } = createTestContext({
    orders: [
      { _id: 'ord_1', staffOpenid: 'staff_1', status: 'in_service' }
    ],
    checkin_logs: []
  })

  const handler = require('../../cloudfunctions/api/handlers/checkin')({
    ...context,
    requireStaffOrder: async () => ({
      order: { _id: 'ord_1', staffOpenid: 'staff_1', status: 'in_service' }
    })
  })

  await assert.rejects(
    () => handler('staff_1', 'deleteCheckin', { orderId: 'ord_1', checkinId: 'chk_not_exist' }),
    { message: '打卡照片不存在' }
  )
})

test('finance: readAll safely paginates and avoids infinite loop with maxLimit and cursor protection', async () => {
  // 模拟超过 100 条数据的 staff_earnings
  const mockEarnings = Array.from({ length: 110 }, (_, i) => ({
    _id: `earning_${String(i + 1).padStart(4, '0')}`,
    staffOpenid: 'staff_1',
    amount: 10,
    status: 'settled',
    type: 'order_reward'
  }))

  const { db, context } = createTestContext({
    staff_earnings: mockEarnings,
    withdraw_requests: []
  })

  const handler = require('../../cloudfunctions/api/handlers/finance')({
    ...context,
    getUser: async () => ({ _id: 'u_staff', openid: 'staff_1', roles: ['staff'] }),
    refreshStaffEarnings: async () => {},
    getSystemSettings: async () => ({ settlement: { minWithdrawAmount: 10 } }),
    summarizeStaffEarnings: (earnings) => ({ totalEarnings: earnings.length * 10, count: earnings.length })
  })

  const res = await handler('staff_1', 'getStaffBalance', {})
  assert.equal(res.count, 110)
  assert.equal(res.totalEarnings, 1100)
})

test('admin: getUserDetail, setSitterFeatured, getOrderDetail return friendly error instead of unhandled crash on invalid ID', async () => {
  const { db, context } = createTestContext({
    users: [
      { _id: 'u_admin', openid: 'admin_1', roles: ['admin'], status: 'active' }
    ],
    orders: [],
    staff_profiles: []
  })

  const adminHandler = require('../../cloudfunctions/api/handlers/admin')({
    ...context,
    getUser: async () => ({ _id: 'u_admin', openid: 'admin_1', roles: ['admin'], status: 'active' })
  })

  await assert.rejects(
    () => adminHandler('admin_1', 'getUserDetail', { userId: 'not_exist_user' }),
    { message: '用户不存在' }
  )

  await assert.rejects(
    () => adminHandler('admin_1', 'setSitterFeatured', { staffProfileId: 'not_exist_profile' }),
    { message: '宠托师不存在' }
  )

  await assert.rejects(
    () => adminHandler('admin_1', 'getOrderDetail', { orderId: 'not_exist_order' }),
    { message: '订单不存在' }
  )
})

test('staff: updateStaffProfileConfig and updateCurrentLocation throw friendly error when profile is missing', async () => {
  const { db, context } = createTestContext({
    users: [
      { _id: 'u_staff', openid: 'staff_1', roles: ['staff'], status: 'active' }
    ],
    staff_profiles: []
  })

  const staffHandler = require('../../cloudfunctions/api/handlers/staff')({
    ...context,
    getUser: async () => ({ _id: 'u_staff', openid: 'staff_1', roles: ['staff'], status: 'active' })
  })

  await assert.rejects(
    () => staffHandler('staff_1', 'updateStaffProfileConfig', { weeklySchedule: {} }),
    { message: '请先提交宠托师认证' }
  )

  await assert.rejects(
    () => staffHandler('staff_1', 'updateCurrentLocation', { latitude: 30.123, longitude: 120.456 }),
    { message: '请先提交员工认证' }
  )
})

test('adminMall: updateOrderStatus safely handles non-existent order in transaction', async () => {
  const { db, context } = createTestContext({
    users: [
      { _id: 'u_admin', openid: 'admin_1', roles: ['admin'], status: 'active' }
    ],
    mall_orders: []
  })

  const adminMallHandler = require('../../cloudfunctions/api/handlers/adminMall')({
    ...context,
    getUser: async () => ({ _id: 'u_admin', openid: 'admin_1', roles: ['admin'], status: 'active' }),
    getDocOrNull: async () => ({ _id: 'mo_1', status: 'paid', paymentStatus: 'paid' })
  })

  await assert.rejects(
    () => adminMallHandler('admin_1', 'updateOrderStatus', { id: 'mo_1', status: 'shipped', remark: '管理员发货' }),
    { message: '订单状态已变化，请刷新后重试' }
  )
})

