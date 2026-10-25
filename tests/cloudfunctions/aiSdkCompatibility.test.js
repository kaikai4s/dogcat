const test = require('node:test')
const assert = require('node:assert/strict')
const sdk = require('../../cloudfunctions/api/node_modules/wx-server-sdk')
const createHandler = require('../../cloudfunctions/api/handlers/ai')
const { createCollectionStore } = require('./helpers')

function setup({ answer = '可以在服务页面选择服务和预约时间。', moderate = async () => {}, user = async () => ({ _id: 'user' }) } = {}) {
  sdk.init({ env: 'local-ai-compatibility' })
  const client = sdk.ai(), requests = [], checks = []
  // Exercise the installed SDK's model adapter and response parser without a cloud request.
  client.modelRequest = async request => {
    requests.push(request)
    // Official wx-server-sdk hy3 examples use createModel('cloudbase').
    // Reject legacy routes so tests cannot hide a production HTTP 404 again.
    if (!new URL(request.url).pathname.endsWith('/cloudbase/chat/completions')) {
      const error = new Error('Request failed with status code 404')
      error.response = { status: 404 }
      throw error
    }
    return { choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }] }
  }
  const db = createCollectionStore({ pets: [{ _id: 'private-pet', openid: 'other', name: 'PRIVATE' }] })
  const handler = createHandler({ cloud: { ai: () => client }, db, safeText: value => String(value || ''),
    nowText: () => '2026-10-25 18:00', getUser: user, checkRateLimit: async () => {},
    checkTextSecurity: async (openid, content, options) => { checks.push({ content, ...options }); await moderate(content, options) } })
  return { handler, requests, checks }
}

test('AI assistant supports the installed server SDK cloud.ai() with no legacy extension', async () => {
  assert.equal(typeof sdk.ai, 'function')
  assert.equal(sdk.extend, undefined)
  const { handler, requests, checks } = setup()
  const result = await handler('owner', 'aiPetAssistant', { question: '怎么预约服务' })
  assert.equal(result.answer, '可以在服务页面选择服务和预约时间。')
  assert.equal(result.source, 'hy3')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].data.model, 'hy3')
  assert.ok(new URL(requests[0].url).pathname.endsWith('/cloudbase/chat/completions'))
  assert.equal(requests[0].data.messages[1].content, '怎么预约服务')
  assert.deepEqual(checks.map(row => row.label), ['AI提问内容', 'AI回答内容'])
})

test('server SDK AI request still stops before model invocation for rejected questions and private pet data', async () => {
  const { handler, requests } = setup({ moderate: async () => { throw new Error('提问未通过检查') } })
  await assert.rejects(handler('owner', 'aiPetAssistant', { question: '服务咨询' }), /提问未通过检查/)
  assert.equal(requests.length, 0)
  const privateData = setup()
  await assert.rejects(privateData.handler('owner', 'aiPetAssistant', { question: '服务咨询', petId: 'private-pet' }), /无权访问/)
  assert.equal(privateData.requests.length, 0)
  const guest = setup({ user: async () => { throw new Error('请先登录') } })
  await assert.rejects(guest.handler('guest', 'aiPetAssistant', { question: '服务咨询' }), /请先登录/)
  assert.equal(guest.requests.length, 0)
})

test('server SDK AI answers must pass moderation and empty output stays an error', async () => {
  const { handler, requests } = setup({ moderate: async (_, options) => {
    if (options.label === 'AI回答内容') throw new Error('回答未通过检查')
  } })
  await assert.rejects(handler('owner', 'aiPetAssistant', { question: '服务咨询' }), /回答未通过检查/)
  assert.equal(requests.length, 1)
  const empty = setup({ answer: '' })
  await assert.rejects(empty.handler('owner', 'aiPetAssistant', { question: '服务咨询' }), /暂未返回内容/)
})

test('pet voice also uses server SDK AI instead of silently falling back to presets', async () => {
  const voices = ['我是合成测试心声一呀', '我是合成测试心声二呀', '我是合成测试心声三呀', '我是合成测试心声四呀', '我是合成测试心声五呀']
  const { handler, requests } = setup({ answer: JSON.stringify(voices) })
  const result = await handler('owner', 'generatePetVoice', { pet: { name: '测试宠物' }, dateKey: '2026-10-25' })
  assert.equal(result.source, 'hy3')
  assert.equal(result.voiceMessage, voices[0])
  assert.equal(requests.length, 1)
})

test('new server AI entry takes precedence over a stale extension and model errors remain visible', async () => {
  const error = new Error('模型服务调用失败')
  const handler = createHandler({ cloud: {
    ai: () => ({ createModel: () => ({ generateText: async () => { throw error } }) }),
    extend: { AI: { createModel() { assert.fail('must use cloud.ai()') } } }
  }, db: createCollectionStore(), safeText: value => String(value || ''), getUser: async () => ({}), checkRateLimit: async () => {} })
  await assert.rejects(handler('owner', 'aiPetAssistant', { question: '服务咨询' }), candidate => candidate === error)
})

test('unsupported server SDK reports an actionable deployment error', async () => {
  const handler = createHandler({ cloud: {}, db: createCollectionStore(), safeText: value => String(value || ''), getUser: async () => ({}), checkRateLimit: async () => {} })
  await assert.rejects(handler('owner', 'aiPetAssistant', { question: '服务咨询' }), /更新 api 云函数及依赖/)
})
