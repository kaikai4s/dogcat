const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const { buildAdminPendingAuditData } = require('../../cloudfunctions/api/services/adminAuditNotifications')

test('buildAdminPendingAuditData: enforces exact template 35413 fields and max length 20', () => {
  const data = buildAdminPendingAuditData({
    applicant: '长'.repeat(50),
    type: '型'.repeat(50),
    reason: '由'.repeat(50)
  })
  assert.equal(data.thing1.value, '长'.repeat(20))
  assert.equal(data.thing2.value, '型'.repeat(20))
  assert.equal(data.thing3.value, '由'.repeat(20))

  const emptyData = buildAdminPendingAuditData({})
  assert.equal(emptyData.thing1.value, '申请人')
  assert.equal(emptyData.thing2.value, '待审核事项')
  assert.equal(emptyData.thing3.value, '待管理员审核处理')
})

test('adminPendingAudit: enqueues to all active admins and sends with exact template fields', async () => {
  const admin1 = { _id: 'a1', openid: 'admin_1', roles: ['admin'], status: 'active' }
  const admin2 = { _id: 'a2', openid: 'admin_2', roles: ['admin'], status: 'active' }
  const adminDisabled = { _id: 'a3', openid: 'admin_disabled', roles: ['admin'], status: 'disabled' }
  const normalUser = { _id: 'u1', openid: 'user_1', roles: ['client'], status: 'active' }

  const db = createCollectionStore({
    users: [admin1, admin2, adminDisabled, normalUser],
    staff_profiles: [],
    withdraw_requests: [{ _id: 'w1', status: 'pending', amount: 99.5 }],
    subscription_logs: [],
    admin_notifications: [],
    platform_configs: [{
      _id: 'settings',
      key: 'system_settings',
      value: {
        subscription: {
          enabled: true,
          templates: { adminPendingAudit: 'DqH2qvsFMbTj6Wh0bMPcHX8muEGybMil56ZScroy2SA' }
        }
      }
    }]
  })

  const sent = []
  const context = createContext({
    db,
    cloud: {
      openapi: {
        subscribeMessage: {
          send: async (payload) => {
            sent.push(payload)
            return { errCode: 0 }
          }
        }
      }
    }
  })

  // 在事务中入队待审核通知
  await db.runTransaction(async (tx) => {
    await context.enqueueAdminAuditNotification(tx, {
      auditType: 'withdraw',
      targetId: 'w1',
      applicant: '小明',
      type: '提现申请审核',
      reason: '申请提现 ¥99.50',
      page: 'pages/admin/finance/index?tab=withdraws'
    })
  })

  // 验证入队记录：2位活跃管理员，已禁用的管理员不入队
  const deliveries = db.state.subscription_logs.filter((row) => row.delivery)
  assert.equal(deliveries.length, 2)
  const openids = deliveries.map((d) => d.openid).sort()
  assert.deepEqual(openids, ['admin_1', 'admin_2'])

  // 验证同时在 admin_notifications 生成待办记录
  assert.equal(db.state.admin_notifications.length, 1)
  assert.equal(db.state.admin_notifications[0].type, 'audit_withdraw')
  assert.equal(db.state.admin_notifications[0].targetId, 'w1')

  // 发送队列中的消息
  await context.retryFailedSubscriptions()
  assert.equal(sent.length, 2)

  // 验证向管理员发送的报文格式
  for (const s of sent) {
    assert.equal(s.templateId, 'DqH2qvsFMbTj6Wh0bMPcHX8muEGybMil56ZScroy2SA')
    assert.equal(s.page, 'pages/admin/finance/index?tab=withdraws')
    assert.deepEqual(s.data, {
      thing1: { value: '小明' },
      thing2: { value: '提现申请审核' },
      thing3: { value: '申请提现 ¥99.50' }
    })
  }
})

test('adminPendingAudit: skips sending if the audit target has already been handled', async () => {
  const admin = { _id: 'a1', openid: 'admin_1', roles: ['admin'], status: 'active' }
  const db = createCollectionStore({
    users: [admin],
    staff_profiles: [{ _id: 'sp_1', auditStatus: 'approved' }], // 已经不是 pending
    subscription_logs: [],
    admin_notifications: [],
    platform_configs: [{
      _id: 'settings',
      key: 'system_settings',
      value: {
        subscription: {
          enabled: true,
          templates: { adminPendingAudit: 'audit-template-id' }
        }
      }
    }]
  })

  const sent = []
  const context = createContext({
    db,
    cloud: {
      openapi: {
        subscribeMessage: {
          send: async (payload) => {
            sent.push(payload)
            return { errCode: 0 }
          }
        }
      }
    }
  })

  await db.runTransaction(async (tx) => {
    await context.enqueueAdminAuditNotification(tx, {
      auditType: 'staff_audit',
      targetId: 'sp_1',
      applicant: '已通过人员',
      type: '宠托师入驻审核',
      reason: '已审核完成',
      page: 'pages/admin/staff-audit/list/index'
    })
  })

  await context.retryFailedSubscriptions()
  // 因为已经被处理为 approved，发送时应当自动跳过，不打扰管理员
  assert.equal(sent.length, 0)
  const delivery = db.state.subscription_logs.find((r) => r.delivery)
  assert.equal(delivery.status, 'skipped')
  assert.equal(delivery.error, 'admin_audit_handled')
})

test('adminPendingAudit: covers community application, appearance customization, incident, and mall after-sale', async () => {
  const admin = { _id: 'a1', openid: 'admin_1', roles: ['admin'], status: 'active' }
  const db = createCollectionStore({
    users: [admin],
    platform_configs: [
      {
        _id: 'settings',
        key: 'system_settings',
        value: {
          subscription: {
            enabled: true,
            templates: { adminPendingAudit: 'audit-template-id' }
          }
        }
      },
      {
        _id: 'comm_app_1',
        key: 'map_community_application',
        name: '阳光花园',
        city: '上海市',
        status: 'pending'
      }
    ],
    pet_playground_appearance_requests: [
      {
        _id: 'app_req_1',
        targetName: '旺财',
        targetType: 'pet',
        status: 'pending'
      }
    ],
    order_incidents: [
      {
        _id: 'inc_1',
        status: 'open'
      }
    ],
    mall_orders: [
      {
        _id: 'mo_1',
        refundStatus: 'applied'
      }
    ],
    subscription_logs: [],
    admin_notifications: []
  })

  const context = createContext({
    db,
    cloud: { openapi: { subscribeMessage: { send: async () => ({ errCode: 0 }) } } }
  })

  // 1. 小区申请
  assert.equal(await context.isAuditTargetHandled('community_application', 'comm_app_1'), false)
  // 模拟已解决
  db.state.platform_configs.find(r => r._id === 'comm_app_1').status = 'resolved'
  assert.equal(await context.isAuditTargetHandled('community_application', 'comm_app_1'), true)

  // 2. 形象定制申请
  assert.equal(await context.isAuditTargetHandled('appearance_customization', 'app_req_1'), false)
  // 模拟已完成
  db.state.pet_playground_appearance_requests.find(r => r._id === 'app_req_1').status = 'completed'
  assert.equal(await context.isAuditTargetHandled('appearance_customization', 'app_req_1'), true)

  // 3. 异常与客诉
  assert.equal(await context.isAuditTargetHandled('incident', 'inc_1'), false)
  // 模拟已关闭
  db.state.order_incidents.find(r => r._id === 'inc_1').status = 'resolved'
  assert.equal(await context.isAuditTargetHandled('incident', 'inc_1'), true)

  // 4. 商城售后退款
  assert.equal(await context.isAuditTargetHandled('mall_after_sale', 'mo_1'), false)
  // 模拟已审核通过
  db.state.mall_orders.find(r => r._id === 'mo_1').refundStatus = 'approved'
  assert.equal(await context.isAuditTargetHandled('mall_after_sale', 'mo_1'), true)
})
