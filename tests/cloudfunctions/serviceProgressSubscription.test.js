const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')

test('服务进度提醒使用图片模板的字段编号和值', async () => {
  const sent = []
  const db = createCollectionStore({
    platform_configs: [{ _id: 'settings', key: 'system_settings', value: {
      subscription: { enabled: true, templates: { serviceProgress: 'configured-service-progress-template' } }
    } }]
  })
  const ctx = createContext({
    db,
    cloud: { openapi: { subscribeMessage: { send: async payload => sent.push(payload) } } }
  })
  const order = {
    _id: 'order_progress', orderNo: 'order_cat_169923328433713406', clientOpenid: 'client_progress',
    serviceSummary: '药浴', staffName: '张三'
  }

  const result = await ctx.notifyOrder(order.clientOpenid, 'serviceProgress', order, {
    statusText: '未开始', tip: '需要提前准备'
  })

  assert.equal(result.status, 'sent')
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].data, {
    thing4: { value: '药浴' },
    phrase7: { value: '未开始' },
    thing9: { value: '需要提前准备' },
    character_string11: { value: 'order_cat_169923328433713406' },
    thing10: { value: '张三' }
  })
})

test('服务进度提醒将较长状态压缩为模板可接受的短语', async () => {
  const sent = []
  const db = createCollectionStore({
    platform_configs: [{ _id: 'settings', key: 'system_settings', value: {
      subscription: { enabled: true, templates: { serviceProgress: 'configured-service-progress-template' } }
    } }]
  })
  const ctx = createContext({
    db,
    cloud: { openapi: { subscribeMessage: { send: async payload => sent.push(payload) } } }
  })

  const result = await ctx.notifyOrder('client_progress', 'serviceProgress', {
    _id: 'order_progress', orderNo: 'O001', serviceSummary: '上门遛狗'
  }, { statusText: '宠托师即将到达' })

  assert.equal(result.status, 'sent')
  assert.equal(sent[0].data.phrase7.value, '即将到达')
})
