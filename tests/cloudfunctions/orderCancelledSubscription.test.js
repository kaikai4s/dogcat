const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')

test('订单取消通知使用 17217 模板字段，并兼容旧宠托师取消配置', async () => {
  const sent = []
  const db = createCollectionStore({
    platform_configs: [{ _id: 'settings', key: 'system_settings', value: {
      subscription: { enabled: true, templates: { orderCancelled: 'configured-cancel-template' } }
    } }]
  })
  const ctx = createContext({ db, cloud: { openapi: { subscribeMessage: { send: async payload => sent.push(payload) } } } })
  const order = { _id: 'order_cancelled', orderNo: 'ASD1234567', clientOpenid: 'client', status: 'cancelled', payAmount: 99 }
  const result = await ctx.notifyOrder('client', 'orderCancelled', order, {
    cancelReason: '宠托师取消接单', statusText: '已取消', refundAmount: 99, cancelledAt: '2026-10-22 11:11'
  }, 'client')

  assert.equal(result.status, 'sent')
  assert.deepEqual(sent[0].data, {
    thing3: { value: '宠托师取消接单' },
    time4: { value: '2026-10-22 11:11' },
    phrase2: { value: '已取消' },
    character_string1: { value: 'ASD1234567' },
    amount8: { value: '99.00' }
  })
})

test('旧 staffCancellation 配置仍可发送统一订单取消通知', async () => {
  const sent = []
  const db = createCollectionStore({
    platform_configs: [{ _id: 'settings', key: 'system_settings', value: {
      subscription: { enabled: true, templates: { staffCancellation: 'legacy-staff-cancel-template' } }
    } }]
  })
  const ctx = createContext({ db, cloud: { openapi: { subscribeMessage: { send: async payload => sent.push(payload) } } } })
  const result = await ctx.notifyOrder('client', 'orderCancelled', { _id: 'order_legacy', orderNo: 'OLD001', status: 'expired' }, {
    cancelReason: '无人接单，订单已过期', statusText: '已过期', refundAmount: 0, cancelledAt: '2026-10-22 11:11'
  }, 'client')

  assert.equal(result.status, 'sent')
  assert.equal(sent[0].templateId, 'legacy-staff-cancel-template')
  assert.equal(sent[0].data.phrase2.value, '已过期')
})
