const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')

test('支付成功通知使用下单支付成功模板的字段编号和值', async () => {
  const sent = []
  const db = createCollectionStore({
    platform_configs: [{ _id: 'settings', key: 'system_settings', value: {
      subscription: { enabled: true, templates: { orderPaid: 'configured-order-paid-template' } }
    } }]
  })
  const ctx = createContext({
    db,
    cloud: { openapi: { subscribeMessage: { send: async payload => sent.push(payload) } } }
  })
  const order = {
    _id: 'order_paid', orderNo: 'O202610220001', clientOpenid: 'client_paid',
    serviceSummary: '基础遛狗', payAmount: 50, startTime: '2026-10-23 17:00',
    serviceAddress: '上海市浦东新区测试小区'
  }

  const result = await ctx.notifyOrder(order.clientOpenid, 'orderPaid', order, { amount: order.payAmount, statusText: '已支付' })

  assert.equal(result.status, 'sent')
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].data, {
    thing2: { value: '基础遛狗' },
    character_string1: { value: 'O202610220001' },
    amount3: { value: '50.00' },
    time4: { value: '2026-10-23 17:00' },
    thing5: { value: '上海市浦东新区测试小区' }
  })
})
