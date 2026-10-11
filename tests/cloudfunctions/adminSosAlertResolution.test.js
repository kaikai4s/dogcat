const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createService = require('../../cloudfunctions/api/services/adminNotifications')

const notice = (id, incidentId, patch = {}) => ({
  _id: id, orderId: 'order', type: 'sos_alert', level: 'urgent', read: false, readBy: [],
  title: '紧急求助', content: '请协调处理', extra: { incidentId },
  actionUrl: `/pages/admin/incidents/detail/index?id=${encodeURIComponent(incidentId)}`,
  createdAt: new Date('2026-10-11T01:00:00Z'), ...patch
})
const service = db => createService({ db, now: () => new Date(), safeText: value => String(value || ''),
  paginateList: (list, data) => ({ list: list.slice((data.page - 1) * data.pageSize, data.page * data.pageSize), total: list.length }) })
const seed = () => ({
  users: [{ _id: 'admin', openid: 'admin', roles: ['admin'], status: 'active' },
    { _id: 'staff', openid: 'staff', roles: ['staff'], status: 'active' },
    { _id: 'client', openid: 'client', roles: ['client'], status: 'active' }],
  orders: [{ _id: 'order', status: 'in_service', clientOpenid: 'client', staffOpenid: 'staff', staffUserId: 'staff' }],
  order_incidents: [], admin_notifications: []
})

test('historical closed SOS alerts leave the badge and pending list but remain in history', async () => {
  const terminal = ['resolved', 'rejected', 'closed']
  const active = ['open', 'triaging', 'waiting_client', 'waiting_staff', 'processing', 'refund_pending']
  const db = createCollectionStore({
    orders: [{ _id: 'order', status: 'completed' }],
    order_incidents: [...terminal, ...active].map(status => ({ _id: status, orderId: 'order', status })),
    admin_notifications: [...terminal, ...active].map(status => notice(status, status))
  })
  const api = service(db)
  const badge = await api.getAdminNotificationBadge('admin')
  assert.equal(badge.unreadCount, active.length)
  assert.equal(badge.urgentCount, active.length)
  assert.ok(active.includes(badge.latestUrgent._id))
  const pending = await api.listAdminNotifications({ status: 'unread' }, 'admin')
  assert.deepEqual(pending.list.map(row => row._id).sort(), active.sort())
  const history = await api.listAdminNotifications({}, 'admin')
  assert.equal(history.list.length, terminal.length + active.length)
  for (const row of history.list) assert.equal(row.isResolved, terminal.includes(row._id))
  assert.ok(db.state.admin_notifications.every(row => !row.read && !row.resolved), 'query preserves stored history and read receipts')
})

for (const [action, status] of [
  ['closeIncident', 'resolved'], ['closeIncident', 'rejected'], ['closeIncident', 'closed'],
  ['resolveIncident', 'resolved'], ['updateIncidentStatus', 'closed']
]) {
  test(`${action}/${status} removes the SOS banner and pending incident count on the next home refresh`, async () => {
    const state = seed()
    state.order_incidents = [{ _id: 'incident', orderId: 'order', staffOpenid: 'staff', status: 'open', frozenEarningIds: [] }]
    state.admin_notifications = [notice('sos', 'incident')]
    const db = createCollectionStore(state)
    const api = loadCloudFunction('api', db, 'admin')
    const call = async (module, action, data = {}) => {
      const result = await api.main({ module, action, data })
      assert.equal(result.ok, true, result.message)
      return result.data
    }
    assert.equal((await call('admin', 'dashboard')).incidentsOpen, 1)
    assert.equal((await call('admin', 'getAdminNotificationBadge')).unreadCount, 1)
    const closed = await call('incident', action, { incidentId: 'incident', status, closeRemark: '已协调解决' })
    assert.equal(closed.status, status)
    assert.equal((await call('admin', 'dashboard')).incidentsOpen, 0)
    const badge = await call('admin', 'getAdminNotificationBadge')
    assert.equal(badge.latestUrgent, null)
    assert.equal(badge.unreadCount, 0)
    assert.equal(badge.urgentCount, 0)
    const pending = await call('admin', 'listAdminNotifications', { status: 'unread' })
    assert.equal(pending.list.length, 0)
    const history = await call('admin', 'listAdminNotifications')
    assert.equal(history.list.length, 1)
    assert.equal(history.list[0].isResolved, true)
    assert.equal(history.list[0].isRead, false)
  })
}

test('separate SOS incidents on one order have independent notifications and replay does not duplicate them', async () => {
  const db = createCollectionStore(seed())
  const staff = loadCloudFunction('api', db, 'staff')
  const admin = loadCloudFunction('api', db, 'admin')
  const create = async clientRequestId => {
    const result = await staff.main({ module: 'incident', action: 'createSosIncident', data: { orderId: 'order', description: '需要平台协助', clientRequestId } })
    assert.equal(result.ok, true, result.message)
    return result.data
  }
  const first = await create('first-sos')
  const second = await create('second-sos')
  assert.notEqual(first._id, second._id)
  assert.equal(db.state.admin_notifications.length, 2)
  assert.notEqual(db.state.admin_notifications[0].idempotencyKey, db.state.admin_notifications[1].idempotencyKey)
  assert.equal((await create('second-sos'))._id, second._id)
  assert.equal(db.state.admin_notifications.length, 2)
  for (const [id, expected] of [[first._id, 1], [second._id, 0]]) {
    const closed = await admin.main({ module: 'incident', action: 'closeIncident', data: { incidentId: id, status: 'resolved' } })
    assert.equal(closed.ok, true, closed.message)
    const badge = await admin.main({ module: 'admin', action: 'getAdminNotificationBadge', data: {} })
    assert.equal(badge.ok, true, badge.message)
    assert.equal(badge.data.unreadCount, expected)
    if (expected) assert.equal(badge.data.latestUrgent.extra.incidentId, second._id)
    else assert.equal(badge.data.latestUrgent, null)
    const dashboard = await admin.main({ module: 'admin', action: 'dashboard', data: {} })
    assert.equal(dashboard.ok, true, dashboard.message)
    assert.equal(dashboard.data.incidentsOpen, expected)
  }
})

test('legacy SOS links resolve by incident ID; missing links and unrelated alerts remain visible', async () => {
  const db = createCollectionStore({
    order_incidents: [{ _id: 'legacy event', status: 'closed' }, { _id: 'active', status: 'open' }],
    admin_notifications: [notice('legacy', 'legacy event', { extra: {} }),
      notice('active', 'active'), notice('missing', 'deleted'),
      notice('unlinked', '', { extra: {}, actionUrl: '' }),
      notice('unrelated', 'legacy event', { type: 'refund_failure' })]
  })
  const api = service(db)
  const history = await api.listAdminNotifications({}, 'admin')
  assert.equal(history.list.find(row => row._id === 'legacy').isResolved, true)
  assert.ok(history.list.filter(row => row._id !== 'legacy').every(row => !row.isResolved))
  assert.equal((await api.getAdminNotificationBadge('admin')).unreadCount, 4)
})

test('SOS resolution queries include incident IDs beyond the first hundred', async () => {
  const incidents = Array.from({ length: 121 }, (_, i) => ({ _id: `incident_${i}`, status: i === 120 ? 'open' : 'resolved' }))
  const db = createCollectionStore({ order_incidents: incidents,
    admin_notifications: incidents.map((incident, i) => notice(`notice_${String(i).padStart(3, '0')}`, incident._id)) })
  const badge = await service(db).getAdminNotificationBadge('admin')
  assert.equal(badge.unreadCount, 1)
  assert.equal(badge.latestUrgent.extra.incidentId, 'incident_120')
})
