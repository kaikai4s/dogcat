const test = require('node:test')
const assert = require('node:assert/strict')
const { PresenceSync } = require('../../miniprogram/packageMemorial/scene/presence-sync')
const { Visitors } = require('../../miniprogram/packageMemorial/scene/visitors')
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
const state = { x: 1536, y: 1430, gender: 'boy', direction: 'sw', moving: false, activity: 'walk' }
test('join and sync calibrate the environment clock; absent/slow samples and stale replies do not corrupt it', async () => {
  const clocks = []
  const f = fixture(action => action === 'joinPresence' ? { session: 'token', playerId: 'me', sceneId: 'garden', serverTime: 100200 } : { accepted: true, serverTime: 100300 })
  f.sync.onClock = (...args) => clocks.push(args)
  f.sync.start(); await flush()
  assert.equal(clocks.length, 2)
  assert.equal(f.sync.offset, 300)
  f.sync.syncClock(undefined, 100000)
  f.sync.syncClock(100200, 80000)
  assert.equal(f.sync.offset, 300)
  assert.equal(clocks.length, 2)
  f.sync.stop(); await f.advance(10000)
  assert.equal(clocks.length, 2)
})
function fixture(api) {
  let now = 100000, serial = 0, current = { ...state }, revisions = 0
  const timers = new Map(), watches = [], calls = [], statuses = [], actors = new Map()
  const sync = new PresenceSync({ sceneId: 'garden', now: () => now, state: () => current,
    delay: (fn, ms) => { timers.set(++serial, { fn, at: now + ms }); return serial }, cancel: id => timers.delete(id),
    api: async (action, data) => { calls.push({ action, data }); return api ? api(action, data) : action === 'joinPresence' ? { session: 'token', playerId: 'me', sceneId: 'garden', serverTime: now } : { accepted: true } },
    watch: (session, onChange, onError) => { const w = { onChange, onError, close() { this.closed = true } }; watches.push(w); return w },
    onRecords: (rows, removed) => { removed.forEach(id => actors.delete(id)); rows.forEach(r => actors.set(r.id, r)) },
    onWorldChange: () => revisions++, onStatus: value => statuses.push(value) })
  async function advance(ms) {
    const until = now + ms
    for (;;) {
      const pending = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!pending) break
      now = pending[1].at; timers.delete(pending[0]); pending[1].fn(); await flush()
    }
    now = until; await flush()
  }
  const row = (id, seq = 1, extra = {}) => ({ id, ...state, epoch: 1, seq, updatedAt: now, ...extra })
  const doc = (records, revision = 1) => ({ _id: 'shard', kind: 'scene', sceneId: 'garden', revision, records: Object.fromEntries(records.map(r => [r.id, r])) })
  return { sync, actors, timers, watches, calls, statuses, row, doc, advance, setState: v => { current = v }, revisions: () => revisions }
}
test('push adds distinct visitors, ignores self/other gardens/stale versions, removes leavers and expires ghosts', async () => {
  const f = fixture(); f.sync.start(); await flush()
  const w = f.watches[0], a = f.row('a'), b = f.row('b')
  w.onChange({ type: 'init', docs: [f.doc([a, b, f.row('me')])] })
  assert.equal(f.actors.size, 2)
  w.onChange({ docChanges: [{ doc: f.doc([f.row('a', 2, { x: 1540 }), b], 2) }] })
  w.onChange({ docChanges: [{ doc: f.doc([a], 1) }] })
  assert.equal(f.actors.get('a').x, 1540)
  w.onChange({ docChanges: [{ doc: { ...f.doc([f.row('wrong')], 50), sceneId: 'other' } }] })
  assert.equal(f.actors.has('wrong'), false)
  w.onChange({ docChanges: [{ doc: f.doc([f.row('a', 3)], 3) }] })
  assert.equal(f.actors.has('b'), false)
  await f.advance(21000)
  assert.equal(f.actors.size, 0)
  f.sync.stop(); assert.equal(f.timers.size, 0)
})
test('slow movement requests never accumulate and send only the newest state after settling', async () => {
  let resolve, inFlight = 0, maximum = 0
  const f = fixture((action) => {
    if (action === 'joinPresence') return { session: 'token', playerId: 'me', sceneId: 'garden', serverTime: 100000 }
    if (action === 'leavePresence') return {}
    maximum = Math.max(maximum, ++inFlight)
    return new Promise(done => { resolve = () => { inFlight--; done({ accepted: true }) } })
  })
  f.sync.start(); await flush()
  for (let i = 1; i <= 40; i++) { f.setState({ ...state, x: 1536 + i }); await f.advance(250) }
  assert.equal(f.calls.filter(c => c.action === 'syncPresence').length, 1)
  assert.equal(maximum, 1)
  assert.ok(f.statuses.some(s => /较慢/.test(s.message)))
  resolve(); await flush(); await f.advance(1)
  const calls = f.calls.filter(c => c.action === 'syncPresence')
  assert.equal(calls.length, 2); assert.equal(calls[1].data.state.x, 1576)
  assert.equal(calls[0].data.state.sampledAt, 100000)
  assert.equal(calls[1].data.state.sampledAt, 110000)
  assert.equal(maximum, 1)
  f.sync.stop(); resolve(); await flush(); assert.equal(f.timers.size, 0)
})
test('idle uses heartbeat and moving requests stay bounded to four per second', async () => {
  const f = fixture(); f.sync.start(); await flush(); await f.advance(10000)
  assert.equal(f.calls.filter(c => c.action === 'syncPresence').length, 3)
  assert.deepEqual(f.calls.filter(c => c.action === 'syncPresence').map(c => c.data.state.sampledAt), [100000, 104000, 108000])
  const before = f.calls.length
  for (let i = 0; i < 20; i++) { f.setState({ ...state, x: 1540 + i, moving: true }); await f.advance(250) }
  assert.equal(f.calls.length - before, 20)
  f.sync.stop()
})
test('watch reconnect replaces absent shards, ignores retired callbacks and teardown stops retries', async () => {
  const f = fixture(); f.sync.start(); await flush()
  const old = f.watches[0]
  old.onChange({ type: 'init', docs: [f.doc([f.row('a')])] })
  old.onError(new Error('offline')); assert.equal(old.closed, true)
  await f.advance(2000)
  const next = f.watches.at(-1); assert.notEqual(next, old)
  next.onChange({ type: 'init', docs: [] }); assert.equal(f.actors.size, 0)
  old.onChange({ type: 'init', docs: [f.doc([f.row('ghost')], 99)] }); assert.equal(f.actors.size, 0)
  next.onChange({ docs: [{ _id: 'world', kind: 'scene', sceneId: 'garden', revision: 1 }] })
  next.onChange({ docs: [{ _id: 'world', kind: 'scene', sceneId: 'garden', revision: 1 }] })
  assert.equal(f.revisions(), 1)
  f.sync.stop(); next.onError(new Error('late')); assert.equal(f.timers.size, 0)
})
test('hiding during join closes the late session without opening a watcher', async () => {
  let join
  const f = fixture(action => action === 'joinPresence' ? new Promise(resolve => { join = resolve }) : {})
  f.sync.start(); f.sync.stop(); join({ session: 'late', playerId: 'me', sceneId: 'garden' }); await flush()
  assert.equal(f.watches.length, 0)
  assert.equal(f.calls.at(-1).action, 'leavePresence')
  assert.equal(f.timers.size, 0)
})
test('session replacement stops instead of repeatedly stealing the other device session', async () => {
  const f = fixture(action => action === 'joinPresence' ? { session: 'token', playerId: 'me', sceneId: 'garden', serverTime: 100000 } : { replaced: true })
  f.sync.start(); await flush()
  assert.equal(f.sync.active, false); assert.equal(f.timers.size, 0)
  assert.match(f.statuses.at(-1).message, /另一处/)
})
test('visitors interpolate a 100-person crowd continuously, settle at the final position and never extrapolate', () => {
  let time = 1000
  const v = new Visitors(() => time)
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: 'p' + i, ...state, epoch: 1, x: 1000 + i }))
  v.apply(rows)
  time += 250; v.apply(rows.map(r => ({ ...r, x: r.x + 30, direction: 'se', moving: true })))
  for (; time < 1425; time += 1000 / 60) v.step(1 / 60)
  assert.equal(v.actors.size, 100)
  assert.ok(v.actors.get('p0').x > 1000 && v.actors.get('p0').x < 1030)
  assert.equal(v.actors.get('p0').direction, 'se')
  for (; time < 4000; time += 1000 / 60) {
    v.step(1 / 60)
    assert.ok(v.actors.get('p0').x <= 1030)
  }
  assert.equal(v.actors.get('p0').x, 1030)
  assert.equal(v.actors.get('p0').moving, false)
  v.apply([{ ...rows[0], epoch: 2, x: 1600 }]); assert.equal(v.actors.get('p0').x, 1600)
  time = 30000; v.step(.016); assert.equal(v.actors.size, 0)
})

test('silent watch stalls reconnect even when uploads continue succeeding', async () => {
  const f = fixture(); f.sync.start(); await flush()
  f.watches[0].onChange({ type: 'init', docs: [] })
  await f.advance(16000)
  assert.notEqual(f.watches[0].closed, true)
  await f.advance(18000)
  assert.equal(f.watches[0].closed, true)
  assert.ok(f.watches.length > 1)
  f.sync.stop(); assert.equal(f.timers.size, 0)
})
test('a failed action request after hiding cannot leave a watchdog or retry behind', async () => {
  let reject
  const f = fixture(action => action === 'joinPresence' ? { session: 'token', playerId: 'me', sceneId: 'garden', serverTime: 100000 } :
    action === 'syncPresence' ? new Promise((_, fail) => { reject = fail }) : {})
  f.sync.start(); await flush(); f.sync.stop(); reject(new Error('offline')); await flush()
  assert.equal(f.timers.size, 0)
})

test('index and permission errors stop automatic retries, retain diagnosis, and allow a clean manual restart', async () => {
  for (const message of ['database watch requires index', 'DATABASE_PERMISSION_DENIED', 'collection not exist']) {
    const f = fixture(); f.sync.start(); await flush()
    f.watches[0].onError(new Error(message))
    assert.equal(f.sync.active, false); assert.equal(f.timers.size, 0)
    assert.match(f.statuses.at(-1).message, /索引|权限|集合/)
    assert.ok(f.statuses.at(-1).detail.includes(message))
    const calls = f.calls.length; await f.advance(60000); assert.equal(f.calls.length, calls)
    f.sync.start(); await flush()
    f.watches[1].onChange({ type: 'init', docs: [f.doc([f.row('me', f.sync.seq)], 2)] })
    assert.equal(f.statuses.at(-1).detail, '')
    assert.equal(f.sync.awaitingEcho, null)
    f.sync.stop()
  }
})
test('confirmed own echoes keep an idle room connected and are never shown as another visitor', async () => {
  const f = fixture(); f.sync.start(); await flush()
  for (let i = 0; i < 15; i++) {
    f.watches[0].onChange({ type: 'init', docs: [f.doc([f.row('me', f.sync.seq)], i + 1)] })
    await f.advance(4000)
  }
  assert.equal(f.actors.size, 0); assert.equal(f.watches.length, 1)
  assert.notEqual(f.watches[0].closed, true)
  f.sync.stop()
})
test('missing collection during join does not loop or open subscriptions', async () => {
  const f = fixture(() => { throw new Error('collection not exist') })
  f.sync.start(); await flush(); await f.advance(60000)
  assert.equal(f.calls.length, 1); assert.equal(f.watches.length, 0)
  assert.match(f.statuses.at(-1).message, /集合/)
  f.sync.stop()
})
