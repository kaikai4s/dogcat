const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

function fixture({ enabled = true, template = '51HMaxS6ydK6m93cZSUrRog7hOwc8mVvXib6WXW9zb0', sendError } = {}) {
  const sent = []
  const db = createCollectionStore({
    users: [
      { _id: 'staff', openid: 'staff', realName: '张宠托', roles: ['staff'], status: 'active' },
      { _id: 'client', openid: 'client', nickName: '李主人', roles: ['client'], status: 'active' },
      { _id: 'admin', openid: 'admin', roles: ['admin'], status: 'active' }
    ],
    platform_configs: [
      {
        _id: 'system_settings',
        key: 'system_settings',
        value: {
          subscription: {
            enabled,
            templates: {
              ...(template ? { orderChat: template } : {})
            }
          }
        }
      }
    ],
    orders: [
      {
        _id: 'order_1',
        orderNo: 'OD20261012001',
        clientOpenid: 'client',
        staffOpenid: 'staff',
        status: 'in_service',
        serviceSummary: '上门喂猫'
      }
    ],
    order_session_messages: [],
    subscription_logs: []
  })
  require('./optimisticTransactions')(db)
  const apiStaff = loadCloudFunction('api', db, 'staff', {
    openapi: {
      subscribeMessage: {
        send: async (message) => {
          sent.push(message)
          if (sendError) throw sendError
        }
      }
    }
  })
  const apiClient = loadCloudFunction('api', db, 'client', {
    openapi: {
      subscribeMessage: {
        send: async (message) => {
          sent.push(message)
          if (sendError) throw sendError
        }
      }
    }
  })
  return { db, apiStaff, apiClient, sent }
}

test('staff sending chat message notifies client using orderChat template with thing1, thing2, time3 and openChat=1', async () => {
  const { apiStaff, sent } = fixture()
  const res = await apiStaff.main({
    module: 'order',
    action: 'sendOrderSessionMessage',
    data: {
      orderId: 'order_1',
      content: '猫砂盆已清理干净，粮水已添满'
    }
  })

  assert.equal(res.ok, true, res.message)
  assert.equal(sent.length, 1)

  const msg = sent[0]
  assert.equal(msg.touser, 'client')
  assert.equal(msg.templateId, '51HMaxS6ydK6m93cZSUrRog7hOwc8mVvXib6WXW9zb0')
  assert.equal(msg.page, 'pages/client/orders/detail/index?id=order_1&openChat=1')
  assert.deepEqual(Object.keys(msg.data).sort(), ['thing1', 'thing2', 'time3'])
  assert.equal(msg.data.thing1.value, '张宠托')
  assert.equal(msg.data.thing2.value, '猫砂盆已清理干净，粮水已添满')
  assert.match(msg.data.time3.value, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
})

test('client sending chat message notifies staff with openChat=1', async () => {
  const { apiClient, sent } = fixture({ template: 'custom-chat-template' })
  const res = await apiClient.main({
    module: 'order',
    action: 'sendOrderSessionMessage',
    data: {
      orderId: 'order_1',
      content: '罐头在厨房上层吊柜里面哦'
    }
  })

  assert.equal(res.ok, true, res.message)
  assert.equal(sent.length, 1)

  const msg = sent[0]
  assert.equal(msg.touser, 'staff')
  assert.equal(msg.templateId, 'custom-chat-template')
  assert.equal(msg.page, 'pages/staff/orders/service/index?id=order_1&openChat=1')
  assert.equal(msg.data.thing1.value, '李主人')
  assert.equal(msg.data.thing2.value, '罐头在厨房上层吊柜里面哦')
})

test('rapid chat messages within throttling window aggregate delivery without exhausting quota', async () => {
  const { apiStaff, sent } = fixture()
  const res1 = await apiStaff.main({
    module: 'order',
    action: 'sendOrderSessionMessage',
    data: { orderId: 'order_1', content: '第一句话' }
  })
  assert.equal(res1.ok, true)
  assert.equal(sent.length, 1)

  const res2 = await apiStaff.main({
    module: 'order',
    action: 'sendOrderSessionMessage',
    data: { orderId: 'order_1', content: '紧接着发送第二句话' }
  })
  assert.equal(res2.ok, true)
  // Within the same 2-minute throttling window, second push is deduplicated
  assert.equal(sent.length, 1)
})

test('chat message sending succeeds even if user quota is exhausted (43101)', async () => {
  const { apiStaff, db } = fixture({ sendError: { errCode: 43101, errMsg: 'user rejected or quota empty' } })
  const res = await apiStaff.main({
    module: 'order',
    action: 'sendOrderSessionMessage',
    data: { orderId: 'order_1', content: '测试配额耗尽不阻塞即时会话' }
  })

  assert.equal(res.ok, true)
  const delivery = db.state.subscription_logs.find(l => l.delivery && l.templateKey === 'orderChat')
  assert.ok(delivery)
  assert.equal(delivery.isQuotaExhausted, true)
})

test('skips sending subscription when orderChat is not configured in backend settings', async () => {
  const { apiStaff, sent, db } = fixture({ template: '' })
  const res = await apiStaff.main({
    module: 'order',
    action: 'sendOrderSessionMessage',
    data: { orderId: 'order_1', content: '测试后台未配置模板时不报错' }
  })

  assert.equal(res.ok, true)
  assert.equal(sent.length, 0)
  const delivery = db.state.subscription_logs.find(l => l.templateKey === 'orderChat')
  assert.ok(delivery)
  assert.equal(delivery.status, 'skipped')
  assert.equal(delivery.error, 'template_not_configured')
})

test('chat message with newlines is sanitized to single line without special characters', async () => {
  const { apiStaff, sent } = fixture()
  const res = await apiStaff.main({
    module: 'order',
    action: 'sendOrderSessionMessage',
    data: {
      orderId: 'order_1',
      content: '第一行内容\n第二行内容\r\n第三行内容'
    }
  })
  assert.equal(res.ok, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].data.thing2.value.includes('\n'), false)
  assert.equal(sent[0].data.thing2.value.includes('\r'), false)
  assert.equal(sent[0].data.thing2.value, '第一行内容 第二行内容 第三行内容')
})

for (const kind of ['previous', 'original', 'preview', 'admin', 'unrelated']) {
  test(`${kind} user cannot read or send current order chat`, async () => {
    const { db } = fixture()
    db.state.users.push({ _id: 'reader', openid: 'reader', roles: kind === 'admin' ? ['admin'] : ['staff'], status: 'active' })
    const order = db.state.orders[0]
    if (kind === 'previous') order.previousStaffRecords = [{ staffOpenid: 'reader' }]
    if (kind === 'original') order.originalStaffOpenid = 'reader'
    if (kind === 'preview') { order.status = 'paid'; order.publishMode = 'open'; order.staffOpenid = '' }
    const api = loadCloudFunction('api', db, 'reader')
    if (kind !== 'unrelated') {
      const detail = await api.main({ module: 'order', action: 'getOrderDetail', data: { id: 'order_1' } })
      assert.equal(detail.ok, true, detail.message)
    }
    for (const action of ['listOrderSessionMessages', 'sendOrderSessionMessage']) {
      const result = await api.main({ module: 'order', action, data: { orderId: 'order_1', content: '不应发送' } })
      assert.equal(result.ok, false, kind + action)
      assert.match(result.message, /无权/)
    }
    assert.equal(db.state.order_session_messages.length, 0)
    assert.equal(db.state.subscription_logs.length, 0)
    assert.equal((db.state.order_message_threads || []).length, 0)
    if (kind === 'admin') {
      const adminRead = await api.main({ module: 'admin', action: 'listOrderSessionMessages', data: { orderId: 'order_1' } })
      assert.equal(adminRead.ok, true, adminRead.message)
    }
  })
}

for (const participant of ['staff', 'client']) {
  test(`current ${participant}+admin participates without delegated administrator read permission`, async () => {
    const { db, apiStaff, apiClient } = fixture()
    db.state.users.find(row => row.openid === participant).roles.push('admin')
    db.state.admin_access_config = [{ _id: 'policy', enabled: true, ownerOpenid: 'owner' }]
    const api = participant === 'staff' ? apiStaff : apiClient
    const sent = await api.main({ module: 'order', action: 'sendOrderSessionMessage', data: { orderId: 'order_1', content: '合法参与者' } })
    assert.equal(sent.ok, true, sent.message)
    assert.equal(sent.data.senderRole, participant)
    const list = await api.main({ module: 'order', action: 'listOrderSessionMessages', data: { orderId: 'order_1' } })
    assert.equal(list.ok, true, list.message)
    assert.equal(list.data.length, 1)
  })
}

test('sending chat message to self does not trigger subscription notification', async () => {
  const { db } = fixture()
  // Client and staff share same openid (self-testing scenario)
  db.state.orders[0].staffOpenid = 'client'
  const apiClient = loadCloudFunction('api', db, 'client', {
    openapi: {
      subscribeMessage: {
        send: async () => { throw new Error('should not be called') }
      }
    }
  })
  const res = await apiClient.main({
    module: 'order',
    action: 'sendOrderSessionMessage',
    data: { orderId: 'order_1', content: '测试自发自收不向自己推订阅消息' }
  })
  assert.equal(res.ok, true)
  assert.equal((db.state.subscription_logs || []).length, 0)
})


