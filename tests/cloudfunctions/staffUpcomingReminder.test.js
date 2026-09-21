const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('staff upcoming service reminder: triggered within 1 hour before service start, deduplicated and directs staff to service page', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000000' },
      { _id: 'staff', openid: 'openid_staff', roles: ['client', 'staff'], status: 'active', phone: '13900000000' },
      { _id: 'admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active' }
    ],
    pets: [{ _id: 'p1', openid: 'openid_client', name: '大黄', species: 'dog', weight: 8, birthDate: '2021-01-01' }],
    staff_profiles: [{ _id: 'sp1', openid: 'openid_staff', realName: '张宠托', auditStatus: 'approved', serviceCity: '上海', serviceAddress: '服务点', serviceLatitude: 31.2, serviceLongitude: 121.5 }],
    service_prices: [
      { _id: 'price0', key: 'visit_fee', label: '基础服务费', price: 30, enabled: true, sortOrder: 0 },
      { _id: 'price1', key: 'walk', label: '上门遛狗', price: 80, enabled: true, sortOrder: 1 }
    ],
    platform_configs: [{
      _id: 'cfg_1',
      key: 'system_settings',
      value: {
        subscription: {
          enabled: true,
          templates: {
            upcomingServiceReminder: 'tmpl_upcoming_123',
            serviceStart: 'tmpl_start_456'
          }
        }
      }
    }],
    orders: [],
    subscription_logs: [],
    order_staff_messages: [],
    order_staff_message_threads: [],
    order_timelines: []
  })

  const clientFn = loadCloudFunction('api', db, 'openid_client')
  const staffFn = loadCloudFunction('api', db, 'openid_staff')

  // 1. 创建订单 A（距离开始还剩 45 分钟，在 1 小时内）
  const in45Min = new Date(Date.now() + 45 * 60 * 1000)
  const in45MinEnd = new Date(in45Min.getTime() + 60 * 60 * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  const formatTime = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`

  const orderResA = await clientFn.main({
    module: 'order',
    action: 'createOrder',
    data: {
      petId: 'p1',
      serviceTypes: ['visit_fee', 'walk'],
      serviceAddress: '阳光花园 1 号楼',
      addressDetail: '1单元 201',
      doorplate: '201',
      startTime: formatTime(in45Min),
      endTime: formatTime(in45MinEnd),
      durationMinutes: 60
    }
  })
  assert.equal(orderResA.ok, true)
  const orderIdA = orderResA.data._id
  await clientFn.main({ module: 'payment', action: 'mockPayOrder', data: { orderId: orderIdA } })
  await staffFn.main({ module: 'staff', action: 'acceptOrder', data: { orderId: orderIdA } })

  // 2. 创建订单 B（距离开始还有 3 小时，不在 1 小时内）
  const in3Hours = new Date(Date.now() + 3 * 60 * 60 * 1000)
  const in3HoursEnd = new Date(in3Hours.getTime() + 60 * 60 * 1000)
  const orderResB = await clientFn.main({
    module: 'order',
    action: 'createOrder',
    data: {
      petId: 'p1',
      serviceTypes: ['visit_fee', 'walk'],
      serviceAddress: '月光花园 2 号楼',
      addressDetail: '2单元 301',
      doorplate: '301',
      startTime: formatTime(in3Hours),
      endTime: formatTime(in3HoursEnd),
      durationMinutes: 60
    }
  })
  assert.equal(orderResB.ok, true)
  const orderIdB = orderResB.data._id
  await clientFn.main({ module: 'payment', action: 'mockPayOrder', data: { orderId: orderIdB } })
  await staffFn.main({ module: 'staff', action: 'acceptOrder', data: { orderId: orderIdB } })

  // 3. 执行提醒检查 (checkUpcomingReminders)
  const checkRes = await staffFn.main({
    module: 'staff',
    action: 'checkUpcomingReminders'
  })
  assert.equal(checkRes.ok, true)
  assert.equal(checkRes.data.remindedCount, 1, '只有在 1 小时内即将开始的订单 A 会被提醒')
  assert.equal(checkRes.data.list[0].orderId, orderIdA)

  // 4. 验证订阅消息日志：接收人为宠托师，且跳转链接为服务执行页
  const logsRes = await db.collection('subscription_logs').where({ orderId: orderIdA }).get()
  const reminderLog = (logsRes.data || []).find((l) => l.templateKey === 'upcomingServiceReminder')
  assert.ok(reminderLog, '应当记录 upcomingServiceReminder 订阅发送日志')
  assert.equal(reminderLog.openid, 'openid_staff', '接收人应为宠托师')
  assert.equal(reminderLog.templateId, 'tmpl_upcoming_123')
  assert.equal(reminderLog.page, `pages/staff/orders/service/index?id=${orderIdA}`, '订阅消息应当跳转至宠托师服务执行页面')

  // 5. 验证宠托师站内消息已写入
  const messagesRes = await db.collection('order_staff_messages').where({ orderId: orderIdA }).get()
  const staffMsg = (messagesRes.data || []).find((m) => m.eventType === 'upcoming_service_reminder')
  assert.ok(staffMsg, '应当向宠托师发送站内提醒消息')
  assert.equal(staffMsg.title, '订单即将开始，请前往服务')
  assert.ok(staffMsg.detail.includes('不足 1 小时'))

  // 6. 验证订单防重字段已记录
  const orderDoc = (await db.collection('orders').doc(orderIdA).get()).data
  assert.ok(Array.isArray(orderDoc.staffUpcomingRemindedSessions))
  assert.ok(orderDoc.staffUpcomingRemindedSessions.includes(1))

  // 7. 再次执行提醒检查，应幂等不重复提醒
  const secondCheckRes = await staffFn.main({
    module: 'staff',
    action: 'checkUpcomingReminders'
  })
  assert.equal(secondCheckRes.ok, true)
  assert.equal(secondCheckRes.data.remindedCount, 0, '防重机制下已提醒的订单不会再次触发')
})
