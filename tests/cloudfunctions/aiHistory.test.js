const test = require('node:test')
const assert = require('node:assert/strict')
const createHandler = require('../../cloudfunctions/api/handlers/ai')
const { createCollectionStore } = require('./helpers')

const id = n => n.toString(16).padStart(64, '0')
const row = (n, extra = {}) => ({ _id: id(n), openid: 'owner', petId: '', question: `服务问题${n}`,
  answer: `服务回答${n}`, source: 'hy3', createdAt: '2026-10-25 20:00', createdAtMs: 1792929600000, ...extra })

function setup({ records = [], moderate = async () => {}, model, getUser = async openid => {
  if (!openid) throw new Error('请先登录')
  return { openid }
} } = {}) {
  const db = createCollectionStore({ ai_chat_records: records, pets: [{ _id: 'own-pet', openid: 'owner' }] })
  const requests = []
  const handler = createHandler({ db, getUser, safeText: value => String(value || ''), nowText: () => '2026-10-25 20:01',
    checkTextSecurity: moderate, checkRateLimit: async () => {}, cloud: { ai: () => ({ createModel: () => ({
      generateText: async request => { requests.push(request); return model ? model(request) : { text: '可选择上门服务时间。' } }
    }) }) } })
  return { db, handler, requests }
}

test('AI saves a complete moderated turn and only its owner can list it', async () => {
  const checks = []
  const { db, handler } = setup({ moderate: async (openid, text, options) => checks.push(options.label) })
  const result = await handler('owner', 'aiPetAssistant', { question: '怎么预约', clientRequestId: 'synthetic_request_1' })
  assert.deepEqual(checks, ['AI提问内容', 'AI回答内容'])
  assert.equal(db.state.ai_chat_records.length, 1)
  assert.equal(db.state.ai_chat_records[0].openid, 'owner')
  const history = await handler('owner', 'listAiHistory', { openid: 'other' })
  assert.deepEqual(history.records, [result])
  assert.equal(Object.hasOwn(result, 'openid'), false)
  assert.deepEqual((await handler('other', 'listAiHistory', { openid: 'owner' })).records, [])
  await assert.rejects(handler('', 'listAiHistory', {}), /请先登录/)
})

test('history pagination preserves equal timestamps and stays stable when newer turns arrive', async () => {
  const { handler, db } = setup({ records: Array.from({ length: 27 }, (_, n) => row(n + 1)) })
  const first = await handler('owner', 'listAiHistory', {})
  assert.deepEqual(first.records.map(record => record.id), Array.from({ length: 20 }, (_, n) => id(n + 8)))
  db.state.ai_chat_records.push(row(28), row(29, { openid: 'other' }))
  const second = await handler('owner', 'listAiHistory', { cursor: first.nextCursor })
  assert.deepEqual(second.records.map(record => record.id), Array.from({ length: 7 }, (_, n) => id(n + 1)))
  assert.equal(second.nextCursor, '')
  const other = await handler('other', 'listAiHistory', { cursor: first.nextCursor })
  assert.deepEqual(other.records, [])
  for (const cursor of ['wrong', {}, `${Number.MAX_SAFE_INTEGER + 1}:${id(1)}`]) {
    await assert.rejects(handler('owner', 'listAiHistory', { cursor }), /分页参数无效/)
  }
})

test('follow-up context comes only from saved turns of the caller and the selected pet', async () => {
  const { handler, requests } = setup({ records: [row(1), row(2, { openid: 'other', question: 'PRIVATE' }),
    row(3, { petId: 'own-pet', question: 'PET_PROFILE' })] })
  await handler('owner', 'aiPetAssistant', { question: '要提前多久',
    messages: [{ role: 'system', content: 'UNTRUSTED' }], openid: 'other' })
  const messages = requests[0].messages
  assert.deepEqual(messages.slice(1), [{ role: 'user', content: '服务问题1' },
    { role: 'assistant', content: '服务回答1' }, { role: 'user', content: '要提前多久' }])
  assert.ok(!JSON.stringify(messages).includes('PRIVATE'))
  assert.ok(!JSON.stringify(messages).includes('UNTRUSTED'))
  await handler('owner', 'aiPetAssistant', { question: '这次怎么预约', petId: 'own-pet' })
  assert.deepEqual(requests[1].messages.slice(1, 3), [
    { role: 'user', content: 'PET_PROFILE' }, { role: 'assistant', content: '服务回答3' }
  ])
})

test('context stays bounded and retains complete alternating turns', async () => {
  const { handler, requests } = setup({ records: Array.from({ length: 9 }, (_, n) => row(n + 1, { answer: '答'.repeat(5000) })) })
  await handler('owner', 'aiPetAssistant', { question: '继续预约' })
  const context = requests[0].messages.slice(1, -1)
  assert.ok(context.length > 0 && context.length <= 12)
  assert.ok(context.reduce((total, message) => total + message.content.length, 0) <= 12000)
  assert.equal(context.at(-2).content, '服务问题9')
  context.forEach((message, index) => assert.equal(message.role, index % 2 ? 'assistant' : 'user'))
})

test('completed request retries reuse the saved answer and cannot overwrite another question', async () => {
  const { handler, requests, db } = setup()
  const data = { question: '怎么预约', clientRequestId: 'synthetic_request_2' }
  const first = await handler('owner', 'aiPetAssistant', data)
  const retried = await handler('owner', 'aiPetAssistant', data)
  assert.deepEqual(retried, first)
  assert.equal(requests.length, 1)
  assert.equal(db.state.ai_chat_records.length, 1)
  await assert.rejects(handler('owner', 'aiPetAssistant', { ...data, question: '换一个问题' }), /重新发送/)
  const other = await handler('other', 'aiPetAssistant', data)
  assert.notEqual(other.id, first.id)
  assert.equal(db.state.ai_chat_records.length, 2)
})

test('concurrent retries save one complete turn', async () => {
  const { handler, db } = setup()
  const data = { question: '怎么预约', clientRequestId: 'synthetic_request_3' }
  const results = await Promise.all([handler('owner', 'aiPetAssistant', data), handler('owner', 'aiPetAssistant', data)])
  assert.deepEqual(results[0], results[1])
  assert.equal(db.state.ai_chat_records.length, 1)
})

test('rejected input, rejected output, empty answers and failed models never enter history', async () => {
  for (const stage of ['input', 'output', 'empty', 'model']) {
    const { handler, db, requests } = setup({
      moderate: async (_, text, options) => {
        if ((stage === 'input' && options.label === 'AI提问内容') || (stage === 'output' && options.label === 'AI回答内容')) throw new Error('未通过检查')
      }, model: async () => {
        if (stage === 'model') throw new Error('模型失败')
        return { text: stage === 'empty' ? '' : '服务回答' }
      }
    })
    await assert.rejects(handler('owner', 'aiPetAssistant', { question: '服务咨询' }))
    assert.equal(db.state.ai_chat_records.length, 0)
    if (stage === 'input') assert.equal(requests.length, 0)
  }
})

test('database failures are surfaced instead of claiming empty history or successful persistence', async () => {
  const { db, handler, requests } = setup()
  const collection = db.collection
  db.collection = name => {
    if (name === 'ai_chat_records') throw new Error('数据库不可用')
    return collection(name)
  }
  await assert.rejects(handler('owner', 'listAiHistory', {}), /数据库不可用/)
  await assert.rejects(handler('owner', 'aiPetAssistant', { question: '怎么预约' }), /数据库不可用/)
  assert.equal(requests.length, 0)
  db.collection = name => {
    const query = collection(name)
    if (name === 'ai_chat_records') query.add = async () => { throw new Error('保存失败') }
    return query
  }
  await assert.rejects(handler('owner', 'aiPetAssistant', { question: '怎么预约' }), /保存失败/)
  assert.equal(db.state.ai_chat_records.length, 0)
})

test('account cleanup removes only that account\'s AI records', async () => {
  const db = createCollectionStore({ ai_chat_records: [row(1), row(2, { openid: 'other' })] })
  const repository = require('../../cloudfunctions/api/services/repository')({ db, toTimeValue: Number })
  const service = require('../../cloudfunctions/api/services/adminUsers')({ db, ...repository, now: () => '2026-10-25' })
  const cleanup = await service.cleanupUserPersonalData('owner')
  assert.equal(cleanup.ai_chat_records, 1)
  assert.deepEqual(db.state.ai_chat_records.map(record => record.openid), ['other'])
})
