const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const flush = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const record = (id, extra = {}) => ({ id, question: `问题${id}`, answer: `回答${id}`,
  createdAtMs: 1000 + Number(id), generatedAt: '2026-10-25 20:00', ...extra })

function setup(call = async () => ({ records: [], nextCursor: '' }), { login } = {}) {
  let page, listener
  const state = { user: { _id: 'owner' }, env: 'test-env' }
  const requests = [], timers = new Map(), scrolls = []
  const cloud = {
    getCachedUser: () => state.user, getCloudEnv: () => state.env,
    ensureLogin: async options => {
      if (login) return login(options)
      if (!state.user) throw { code: 'LOGIN_CANCELLED' }
      return state.user
    },
    subscribeIdentityChange: callback => { listener = callback; return () => { listener = null } },
    callFunction: async (name, action, data) => {
      requests.push({ name, action, data, owner: state.user && state.user._id })
      return call(action, data, state.user && state.user._id)
    }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/client/ai-assistant/index.js'), 'utf8'), {
    Page: config => { page = config },
    require: name => name.endsWith('/cloud') ? cloud : {
      applyTheme: () => ({ value: 'day' }), getThemeState: () => ({}),
      applyFont: () => ({ value: 'system' }), getFontState: () => ({})
    },
    wx: { pageScrollTo: options => scrolls.push(options) },
    setTimeout: (callback, delay) => { const id = Symbol(); timers.set(id, { callback, delay }); return id },
    clearTimeout: id => timers.delete(id)
  })
  page.setData = function(patch, callback) { Object.assign(this.data, patch); if (callback) callback() }
  return { page, state, requests, timers, scrolls,
    setUser(user) { state.user = user; if (listener) listener(user) },
    hasListener: () => Boolean(listener) }
}

test('AI loads recent history, prepends older turns without duplicates and restores a saved new answer after reopening', async () => {
  const saved = [record('1'), record('2')]
  const call = async (action, data) => {
    if (action === 'listAiHistory') {
      return data.cursor ? { records: [saved[0], saved[1]], nextCursor: '' }
        : { records: saved.slice(1), nextCursor: 'older-cursor' }
    }
    const result = record('3', { question: data.question, answer: '新回答' })
    saved.push(result)
    return result
  }
  const { page, requests, timers } = setup(call)
  await page.onLoad()
  assert.deepEqual(Array.from(page.data.messages, message => message.content).slice(1), ['问题2', '回答2'])
  await page.loadOlder()
  assert.deepEqual(Array.from(page.data.messages, message => message.content).slice(1), ['问题1', '回答1', '问题2', '回答2'])
  assert.equal(page.data.historyCursor, '')
  page.data.inputText = '连续追问'
  await page.send()
  const request = requests.find(value => value.action === 'aiPetAssistant')
  assert.equal(request.data.question, '连续追问')
  assert.match(request.data.clientRequestId, /^[a-zA-Z0-9_-]{8,80}$/)
  assert.equal(Object.hasOwn(request.data, 'messages'), false)
  assert.equal(page.data.messages.at(-1).content, '新回答')
  assert.equal(new Set(page.data.messages.map(message => message.id)).size, page.data.messages.length)
  assert.equal(timers.size, 0)
  page.onUnload()
  const reopened = setup(call).page
  await reopened.onLoad()
  assert.equal(reopened.data.messages.at(-1).content, '新回答')
})

test('history loading blocks sending; a load failure can be retried', async () => {
  const pending = deferred()
  let count = 0
  const { page, requests } = setup(async () => ++count === 1 ? pending.promise : { records: [record('1')], nextCursor: '' })
  const loading = page.onLoad()
  page.data.inputText = '未加载完时发送'
  await page.send()
  await flush()
  assert.equal(requests.length, 1)
  pending.reject(new Error('暂时无法加载'))
  await loading
  assert.equal(page.data.historyError, '暂时无法加载')
  await page.retryHistory()
  assert.equal(page.data.historyError, '')
  assert.equal(page.data.messages.at(-1).content, '回答1')
})

test('history timeout releases the page and ignores a late response', async () => {
  const pending = deferred()
  const { page, timers } = setup(() => pending.promise)
  const loading = page.onLoad()
  await flush()
  const timeout = [...timers.values()].find(value => value.delay === 15000)
  timeout.callback()
  await loading
  assert.equal(page.data.historyLoading, false)
  assert.match(page.data.historyError, /加载超时/)
  pending.resolve({ records: [record('1', { answer: '迟到的记录' })], nextCursor: '' })
  await flush()
  assert.equal(page.data.messages.length, 1)
  assert.equal(timers.size, 0)
})

test('switching accounts during a history request clears private content and rejects stale output', async () => {
  const pending = deferred()
  const { page, setUser } = setup((action, data, owner) => owner === 'owner'
    ? pending.promise : { records: [record('2', { answer: '新账号记录' })], nextCursor: '' })
  const loading = page.onLoad()
  await flush()
  page.data.inputText = '旧账号草稿'
  setUser({ _id: 'other' })
  await flush()
  pending.resolve({ records: [record('1', { answer: '旧账号隐私' })], nextCursor: '' })
  await loading
  assert.equal(page.data.inputText, '')
  assert.equal(page.data.messages.at(-1).content, '新账号记录')
  assert.ok(!JSON.stringify(page.data).includes('旧账号隐私'))
})

test('logout during generation clears all records, draft and retry state; late answers stay hidden', async () => {
  const pending = deferred()
  const { page, setUser, timers } = setup(action => action === 'aiPetAssistant'
    ? pending.promise : { records: [record('1')], nextCursor: '' })
  await page.onLoad()
  page.data.inputText = '旧账号问题'
  const sending = page.send()
  await flush()
  setUser(null)
  assert.equal(page.data.messages.length, 1)
  assert.equal(page.data.loading, false)
  assert.equal(page.data.inputText, '')
  assert.equal(page._retryRequest, null)
  pending.resolve(record('2', { answer: '旧账号回答' }))
  await sending
  assert.equal(page.data.messages.length, 1)
  assert.equal(timers.size, 0)
})

test('failed answer retries reuse one request ID and do not duplicate the question', async () => {
  let attempts = 0
  const { page, requests } = setup((action, data) => {
    if (action === 'listAiHistory') return { records: [], nextCursor: '' }
    if (++attempts === 1) throw new Error('暂时不可用')
    return record('1', { question: data.question })
  })
  await page.onLoad()
  page.data.inputText = '怎么预约'
  await page.send()
  assert.equal(page.data.messages.length, 1)
  assert.equal(page.data.inputText, '怎么预约')
  await page.retry()
  const sends = requests.filter(row => row.action === 'aiPetAssistant')
  assert.equal(sends.length, 2)
  assert.equal(sends[0].data.clientRequestId, sends[1].data.clientRequestId)
  assert.equal(page.data.messages.filter(row => row.role === 'user').length, 1)
  assert.equal(page._retryRequest, null)
})

test('returning after an AI timeout reloads the answer eventually saved by the backend', async () => {
  const pending = deferred(), saved = []
  let clientRequestId
  const { page, timers } = setup((action, data) => {
    if (action === 'aiPetAssistant') { clientRequestId = data.clientRequestId; return pending.promise }
    return { records: saved, nextCursor: '' }
  })
  await page.onLoad()
  page.data.inputText = '怎么预约'
  const sending = page.send()
  await flush()
  ;[...timers.values()].find(value => value.delay === 45000).callback()
  await sending
  assert.match(page.data.errorText, /超时/)
  saved.push(record('1', { question: '怎么预约', answer: '云端稍后保存的答案', clientRequestId }))
  pending.resolve(saved[0])
  await flush()
  assert.equal(page.data.messages.length, 1)
  page.onHide()
  page.onShow()
  await flush()
  assert.equal(page.data.messages.at(-1).content, '云端稍后保存的答案')
  assert.equal(page.data.errorText, '')
  assert.equal(page.data.retryText, '')
  assert.equal(page.data.inputText, '')
  assert.equal(page._retryRequest, null)
})

test('environment changes clear prior records and unload removes identity listeners', async () => {
  const { page, state, hasListener } = setup(() => ({ records: [record('1')], nextCursor: '' }))
  await page.onLoad()
  assert.equal(hasListener(), true)
  state.env = 'different-env'
  page.onShow()
  assert.equal(page.data.messages.length, 1)
  await flush()
  page.onUnload()
  assert.equal(hasListener(), false)
})

test('cancelled login makes no history request and preserves a retry path', async () => {
  const { page, requests } = setup(undefined, { login: async () => { throw { code: 'LOGIN_CANCELLED' } } })
  await page.onLoad()
  assert.equal(requests.length, 0)
  assert.equal(page.data.historyLoading, false)
  assert.equal(page.data.historyError, '')
  assert.equal(page.data.messages.length, 1)
})
