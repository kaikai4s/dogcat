const test = require('node:test')
const assert = require('node:assert/strict')
const createContext = require('../../cloudfunctions/api/services/context')
const { createCollectionStore } = require('./helpers')

function createTestContext(initial = {}) {
  const db = createCollectionStore(initial)
  let t = 1717236000000
  return createContext({ db, cloud: {}, now: () => new Date(t += 1000) })
}

test('admin can send system notification with role targeting and validation', async () => {
  const context = createTestContext({
    users: [
      { _id: 'u_admin', openid: 'admin_openid', roles: ['admin'], name: '管理员小王', status: 'active' },
      { _id: 'u_client', openid: 'client_openid', roles: ['client'], name: '客户小李', status: 'active' },
      { _id: 'u_staff', openid: 'staff_openid', roles: ['staff'], name: '宠托师小张', status: 'active' }
    ],
    system_notifications: [],
    user_notification_reads: [],
    admin_operation_logs: []
  })

  const adminHandler = require('../../cloudfunctions/api/handlers/admin')(context)

  // 1. Validation: title and content are required
  await assert.rejects(
    adminHandler('admin_openid', 'sendSystemNotification', { title: '', content: '内容' }),
    /请输入通知标题/
  )
  await assert.rejects(
    adminHandler('admin_openid', 'sendSystemNotification', { title: '标题', content: '' }),
    /请输入通知内容/
  )

  // 2. Non-admin is rejected
  await assert.rejects(
    adminHandler('client_openid', 'sendSystemNotification', { title: '标题', content: '内容' }),
    /仅管理员可操作/
  )

  // 3. Admin successfully sends notifications to 'all', 'client', and 'staff'
  const resAll = await adminHandler('admin_openid', 'sendSystemNotification', {
    title: '平台端午假期服务安排通知',
    content: '端午节期间部分热门日期将根据平台规则执行服务加价，请提前安排。',
    target: 'all',
    type: 'system',
    level: 'normal'
  })
  assert.ok(resAll._id)
  assert.equal(resAll.title, '平台端午假期服务安排通知')
  assert.equal(resAll.target, 'all')

  const resClient = await adminHandler('admin_openid', 'sendSystemNotification', {
    title: '宠物新人专属关爱礼券已发放',
    content: '新一期满减关爱优惠券已放入您的卡券包，快去体验吧！',
    target: 'client',
    type: 'activity',
    targetUrl: '/pages/client/coupons/list/index'
  })
  assert.ok(resClient._id)
  assert.equal(resClient.target, 'client')

  const resStaff = await adminHandler('admin_openid', 'sendSystemNotification', {
    title: '端午节宠托师接单排班奖励通知',
    content: '假期出勤并完成准时打卡服务的宠托师可获得额外完单奖励。',
    target: 'staff',
    type: 'notice',
    level: 'urgent'
  })
  assert.ok(resStaff._id)
  assert.equal(resStaff.target, 'staff')

  // 4. Admin lists notifications
  const adminListRes = await adminHandler('admin_openid', 'listSystemNotifications', { page: 1, pageSize: 10 })
  assert.equal(adminListRes.total, 3)
  assert.equal(adminListRes.list.length, 3)
  assert.ok(adminListRes.list.some(item => item.typeText === '服务通知'))
  assert.ok(adminListRes.list.some(item => item.typeText === '活动福利'))
  assert.ok(adminListRes.list.some(item => item.typeText === '系统公告'))
})

test('client and staff receive corresponding system notifications and track unread status', async () => {
  const context = createTestContext({
    users: [
      { _id: 'u_admin', openid: 'admin_openid', roles: ['admin'], name: '管理员', status: 'active' },
      { _id: 'u_client', openid: 'client_openid', roles: ['client'], name: '客户小李', status: 'active' },
      { _id: 'u_staff', openid: 'staff_openid', roles: ['staff'], name: '宠托师小张', status: 'active' }
    ],
    order_message_threads: [],
    order_staff_message_threads: [],
    system_notifications: [
      {
        _id: 'notice_all',
        title: '全员系统公告',
        content: '平台维护公告',
        target: 'all',
        type: 'system',
        status: 'active',
        createdAt: '2026-09-20T09:00:00.000Z'
      },
      {
        _id: 'notice_client',
        title: '用户专属通知',
        content: '您的宠粮推荐',
        target: 'client',
        type: 'activity',
        status: 'active',
        createdAt: '2026-09-20T09:05:00.000Z'
      },
      {
        _id: 'notice_staff',
        title: '宠托师加急接单提醒',
        content: '附近有新的加急单发布',
        target: 'staff',
        type: 'notice',
        status: 'active',
        createdAt: '2026-09-20T09:10:00.000Z'
      },
      {
        _id: 'notice_revoked',
        title: '已撤回的历史通知',
        content: '测试撤回',
        target: 'all',
        type: 'system',
        status: 'revoked',
        createdAt: '2026-09-20T08:00:00.000Z'
      }
    ],
    user_notification_reads: [],
    admin_operation_logs: []
  })

  const clientHandler = require('../../cloudfunctions/api/handlers/message')(context)
  const staffHandler = require('../../cloudfunctions/api/handlers/staffMessage')(context)
  const adminHandler = require('../../cloudfunctions/api/handlers/admin')(context)

  // 1. Client views notifications: sees 'all' and 'client', does NOT see 'staff' or 'revoked'
  const clientNotices = await clientHandler('client_openid', 'listSystemNotifications', { page: 1, pageSize: 10 })
  assert.equal(clientNotices.total, 2)
  const clientNoticeIds = clientNotices.list.map(n => n._id)
  assert.ok(clientNoticeIds.includes('notice_all'))
  assert.ok(clientNoticeIds.includes('notice_client'))
  assert.ok(!clientNoticeIds.includes('notice_staff'))
  assert.ok(!clientNoticeIds.includes('notice_revoked'))
  assert.equal(clientNotices.unreadCount, 2)

  // Client unread summary includes systemUnread
  const clientSummary = await clientHandler('client_openid', 'getUnreadSummary', {})
  assert.equal(clientSummary.systemUnread, 2)
  assert.equal(clientSummary.totalUnread, 2)

  // 2. Staff views notifications: sees 'all' and 'staff', does NOT see 'client'
  const staffNotices = await staffHandler('staff_openid', 'listSystemNotifications', { page: 1, pageSize: 10 })
  assert.equal(staffNotices.total, 2)
  const staffNoticeIds = staffNotices.list.map(n => n._id)
  assert.ok(staffNoticeIds.includes('notice_all'))
  assert.ok(staffNoticeIds.includes('notice_staff'))
  assert.ok(!staffNoticeIds.includes('notice_client'))
  assert.equal(staffNotices.unreadCount, 2)

  // Staff unread summary includes systemUnread
  const staffSummary = await staffHandler('staff_openid', 'getUnreadSummary', {})
  assert.equal(staffSummary.systemUnread, 2)
  assert.equal(staffSummary.totalUnread, 2)

  // 3. Mark single notification as read
  await clientHandler('client_openid', 'markSystemNotificationRead', { id: 'notice_client' })
  const clientAfterOneRead = await clientHandler('client_openid', 'listSystemNotifications', {})
  assert.equal(clientAfterOneRead.unreadCount, 1)
  const clientNoticeClientItem = clientAfterOneRead.list.find(n => n._id === 'notice_client')
  assert.equal(clientNoticeClientItem.isRead, true)

  const clientSummaryAfterOne = await clientHandler('client_openid', 'getUnreadSummary', {})
  assert.equal(clientSummaryAfterOne.systemUnread, 1)

  // 4. Mark all as read
  await clientHandler('client_openid', 'markSystemNotificationRead', { all: true })
  const clientAfterAllRead = await clientHandler('client_openid', 'listSystemNotifications', {})
  assert.equal(clientAfterAllRead.unreadCount, 0)
  assert.equal(clientAfterAllRead.list.every(n => n.isRead), true)

  const clientSummaryAfterAll = await clientHandler('client_openid', 'getUnreadSummary', {})
  assert.equal(clientSummaryAfterAll.systemUnread, 0)
  assert.equal(clientSummaryAfterAll.totalUnread, 0)

  // 5. Admin revokes notification
  await adminHandler('admin_openid', 'revokeSystemNotification', { id: 'notice_all' })
  const staffAfterRevoke = await staffHandler('staff_openid', 'listSystemNotifications', {})
  // notice_all is revoked, so staff only sees notice_staff now
  assert.equal(staffAfterRevoke.total, 1)
  assert.equal(staffAfterRevoke.list[0]._id, 'notice_staff')
})
