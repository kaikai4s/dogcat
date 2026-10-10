const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createService = require('../../cloudfunctions/api/services/adminNotifications')

const notice = (id, orderId, extra = {}) => ({
  _id: id, orderId, type: 'order_start_overdue', level: 'urgent', read: false, readBy: [],
  title: '超时未开始预警', content: '请联系宠托师', createdAt: new Date('2026-10-10T01:00:00Z'), ...extra
})
const service = db => createService({ db, now: () => new Date(), safeText: value => String(value || ''),
  paginateList: (list, data) => ({ list: list.slice((data.page - 1) * data.pageSize, data.page * data.pageSize), total: list.length }) })

test('legacy completed and non-actionable orders never appear as dispatch alerts; history remains', async () => {
  const statuses = ['completed', 'cancelled', 'refunded', 'closed', 'in_service', 'paid']
  const db = createCollectionStore({
    orders: [...statuses.map(status => ({ _id: status, status })),
      { _id: 'active', status: 'assigned', isStartOverdue: true },
      { _id: 'way', status: 'on_the_way' }, { _id: 'day', status: 'day_completed' },
      { _id: 'cleared', status: 'assigned', isStartOverdue: false }],
    admin_notifications: [...statuses.map(status => notice(status, status)),
      notice('missing', 'missing'), notice('cleared', 'cleared'), notice('active', 'active'),
      notice('way', 'way', { createdAt: new Date('2026-10-10T02:00:00Z') }), notice('day', 'day'),
      notice('closed', 'active', { resolved: true }), notice('read', 'active', { read: true }),
      notice('readBy', 'active', { readBy: ['admin'] }),
      notice('unrelated', 'completed', { type: 'refund_failure', level: 'warning' }),
      notice('republished', 'completed', { type: 'order_urgent_republished' })]
  })
  const api = service(db)
  const badge = await api.getAdminNotificationBadge('admin')
  assert.equal(badge.urgentCount, 3)
  assert.equal(badge.unreadCount, 4)
  assert.equal(badge.latestUrgent._id, 'way')
  const unread = await api.listAdminNotifications({ status: 'unread' }, 'admin')
  assert.equal(unread.list.length, 4)
  assert.equal(unread.unreadCount, badge.unreadCount)
  const history = await api.listAdminNotifications({}, 'admin')
  assert.equal(history.list.length, db.state.admin_notifications.length)
  assert.equal(history.list.find(n => n._id === 'completed').isResolved, true)
  assert.equal(history.list.find(n => n._id === 'unrelated').isResolved, false)
  assert.equal(db.state.admin_notifications.find(n => n._id === 'completed').read, false)
})

test('legacy alert filtering works across notification and order query pages', async () => {
  const db = createCollectionStore({
    orders: Array.from({ length: 121 }, (_, i) => ({ _id: 'order_' + i, status: i === 120 ? 'assigned' : 'completed' })),
    admin_notifications: Array.from({ length: 121 }, (_, i) => notice('notice_' + String(i).padStart(3, '0'), 'order_' + i))
  })
  const badge = await service(db).getAdminNotificationBadge('admin')
  assert.equal(badge.unreadCount, 1)
  assert.equal(badge.latestUrgent.orderId, 'order_120')
})

test('manual completion closes every dispatch alert, preserves read state, timeline and unrelated notices', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'admin', openid: 'admin', roles: ['admin'], status: 'active' },
      { _id: 'client', openid: 'client', roles: ['client'], status: 'active' }],
    orders: [{ _id: 'order', status: 'assigned', clientOpenid: 'client', clientUserId: 'client',
      payAmount: 100, isStartOverdue: true, isFinishOverdue: true }],
    admin_notifications: [notice('unread', 'order'), notice('read', 'order', { read: true, readBy: ['admin'] }),
      notice('urgent', 'order', { type: 'order_urgent_republished' }),
      notice('other_type', 'order', { type: 'refund_failure' }), notice('other_order', 'other'),
      notice('finish', 'order', { type: 'order_finish_overdue' })],
    order_timeline: [{ _id: 'old', orderId: 'order', type: 'overdue_unstarted_alert', title: '原超时记录' }]
  })
  const api = loadCloudFunction('api', db, 'admin')
  const result = await api.main({ module: 'admin', action: 'manualCompleteOrder', data: { id: 'order', remark: '已核实服务凭据' } })
  assert.equal(result.ok, true, result.message)
  assert.equal(db.state.orders[0].status, 'completed')
  assert.equal(db.state.orders[0].isStartOverdue, false)
  for (const id of ['unread', 'read', 'urgent', 'finish']) {
    const item = db.state.admin_notifications.find(n => n._id === id)
    assert.equal(item.resolved, true)
    assert.equal(item.resolvedBy, 'admin')
    assert.equal(item.resolutionReason, 'admin_manual_completed')
    assert.ok(item.resolvedAt)
  }
  assert.equal(db.state.admin_notifications[0].read, false)
  assert.deepEqual(db.state.admin_notifications[1].readBy, ['admin'])
  assert.equal(db.state.admin_notifications[3].resolved, undefined)
  assert.equal(db.state.admin_notifications[4].resolved, undefined)
  assert.ok(db.state.order_timeline.some(t => t._id === 'old'))
  assert.ok(db.state.order_timeline.some(t => t.type === 'admin_manual_completed'))
  const badge = await api.main({ module: 'admin', action: 'getAdminNotificationBadge' })
  assert.equal(badge.ok, true)
  assert.equal(badge.data.latestUrgent._id, 'other_type')
  const history = await api.main({ module: 'admin', action: 'listAdminNotifications', data: {} })
  assert.equal(history.data.list.length, 6)
  assert.equal(history.data.list.find(n => n._id === 'unread').isResolved, true)
  const resolvedAt = db.state.admin_notifications[0].resolvedAt
  await service(db).resolveOrderDispatchNotifications('order', { reason: 'retry' })
  assert.equal(db.state.admin_notifications[0].resolvedAt, resolvedAt)
})

test('completed order finish-overdue notices are history, while active finish alerts remain actionable', async () => {
  const db = createCollectionStore({
    orders: [{ _id: 'completed', status: 'completed', completionType: 'admin_manual', finishOverdueIncidentCreated: true },
      { _id: 'active', status: 'in_service', isFinishOverdue: true }],
    admin_notifications: [notice('done', 'completed', { type: 'order_finish_overdue' }),
      notice('active', 'active', { type: 'order_finish_overdue' })]
  })
  const api = service(db)
  const badge = await api.getAdminNotificationBadge('admin')
  assert.equal(badge.unreadCount, 1)
  assert.equal(badge.latestUrgent._id, 'active')
  const history = await api.listAdminNotifications({}, 'admin')
  assert.equal(history.list.length, 2)
  assert.equal(history.list.find(n => n._id === 'done').isResolved, true)
  assert.equal(db.state.admin_notifications.length, 2)
})

test('completed orders with stale flags or historical incidents are excluded from overdue list and detail warnings', async () => {
  const terminalStatuses = ['completed', 'auto_completed', 'cancelled', 'refunded', 'closed', 'expired', 'timeout_closed']
  const db = createCollectionStore({
    users: [{ _id: 'admin', openid: 'admin', roles: ['admin'], status: 'active' }],
    orders: [...terminalStatuses.map(status => ({ _id: status, status, isStartOverdue: true, isFinishOverdue: true,
      finishOverdueIncidentCreated: true, completionType: 'admin_manual' })),
      { _id: 'verified', status: 'completed', isStartOverdue: false, isFinishOverdue: false, finishOverdueIncidentCreated: true },
      { _id: 'active', status: 'in_service', isFinishOverdue: true }]
  })
  const api = loadCloudFunction('api', db, 'admin')
  const all = await api.main({ module: 'admin', action: 'listOrders', data: {} })
  assert.equal(all.ok, true, all.message)
  for (const order of all.data.list.filter(o => o._id !== 'active')) {
    assert.equal(order.isOverdue, false, order._id)
    assert.equal(order.isStartOverdue, false, order._id)
    assert.equal(order.isFinishOverdue, false, order._id)
  }
  const overdue = await api.main({ module: 'admin', action: 'listOrders', data: { status: 'overdue' } })
  assert.equal(overdue.ok, true, overdue.message)
  assert.deepEqual(overdue.data.list.map(o => o._id), ['active'])
  const detail = await api.main({ module: 'admin', action: 'getOrderDetail', data: { id: 'verified' } })
  assert.equal(detail.ok, true, detail.message)
  assert.equal(detail.data.order.isOverdue, false)
  assert.equal(detail.data.order.finishOverdueIncidentCreated, true)
  assert.equal(db.state.orders[0].isStartOverdue, true, 'query must preserve historical source fields')
})
