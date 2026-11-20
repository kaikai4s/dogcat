const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

const source = fs.readFileSync(require.resolve('../../miniprogram/packageManor3d/utils/manor-community-sync'), 'utf8')
const scene = { sceneId: 'court', session: 'session', playerId: 'owner', hasAvatar: true }

function fixture(callFunction) {
  const module = { exports: {} }, timers = new Map(), errors = [], states = [], calls = []
  let nextTimer = 0, closed = 0, now = 100000, watcher
  const applied = []
  const query = { where: () => query, limit: () => query, watch(callbacks) {
    watcher = callbacks
    return { close() { closed += 1 } }
  } }
  vm.runInNewContext(source, {
    module, require: () => ({
      getCloudEnv: () => 'test-env',
      async callFunction(name, action, data) {
        calls.push({ name, action, data: { ...data } })
        return callFunction(action, data)
      }
    }),
    wx: { cloud: { database: () => ({ collection: () => query }) } },
    Date: { now: () => now },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, due: now + delay }); return id },
    clearTimeout(id) { timers.delete(id) }
  })
  const sync = new module.exports.ManorCommunitySync(scene, (records, { replace }) =>
    applied.push({ records: Array.from(records, record => ({ ...record })), replace }), error => errors.push(error.message), state => states.push(state))
  async function advance(ms) {
    const until = now + ms
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.due <= until).sort((a, b) => a[1].due - b[1].due)[0]
      if (!next) break
      const [id, timer] = next
      now = timer.due
      timers.delete(id)
      await timer.callback()
      await sync.positionFlight?.promise
    }
    now = until
  }
  return { sync, timers, errors, states, calls, applied, advance, watch: event => watcher.onChange(event), get closed() { return closed } }
}

test('an expired scene snapshot stops the watcher without retrying the expired credential', async () => {
  const f = fixture(() => { throw new Error('场景已切换，请重新进入') })
  await f.sync.start()
  assert.deepEqual(f.calls, [{ name: 'playground', action: 'getScene', data: { sceneId: 'court', session: 'session', cursor: '', manor3d: true } }])
  assert.deepEqual(f.errors, ['场景已切换，请重新进入'])
  assert.deepEqual(f.states, ['connecting'])
  assert.equal(f.closed, 1)
  assert.equal(f.timers.size, 0)
  assert.equal(f.sync.active, false)
})

function movement(x) {
  return { position3d: { x, z: 0 }, moving: true, running: true, facing: .2 }
}

test('rapid changes coalesce to the latest sample and departure includes the final position', async () => {
  let finishFirst
  const f = fixture((action, data) => {
    if (action === 'getScene') return { records: [] }
    if (data.seq === 1) return new Promise(resolve => { finishFirst = resolve })
    return { accepted: true, ackSeq: data.seq }
  })
  await f.sync.start()
  const first = f.sync.syncPosition(movement(1))
  for (let x = 2; x <= 20; x++) f.sync.syncPosition(movement(x))
  const sent = () => f.calls.filter(call => call.action === 'syncManor3d').map(call => call.data.position3d.x)
  assert.deepEqual(sent(), [1])
  finishFirst({ accepted: true, ackSeq: 1 })
  await first
  await f.advance(160)
  assert.deepEqual(sent(), [1, 20])
  f.sync.syncPosition(movement(21))
  f.sync.stop({ position: movement(22) })
  assert.deepEqual(sent(), [1, 20, 22])
  assert.equal(f.calls.at(-1).data.online, false)
  assert.equal(f.timers.size, 0)
})

test('posture changes publish even when the player has not moved', async () => {
  const f = fixture((action, data) => action === 'getScene' ? { records: [] } : { accepted: true, ackSeq: data.seq })
  await f.sync.start()
  await f.sync.syncPosition({ ...movement(1), pose: 'sit' })
  await f.advance(160)
  await f.sync.syncPosition({ ...movement(1), pose: 'lie' })
  assert.deepEqual(f.calls.filter(call => call.action === 'syncManor3d').map(call => call.data.pose), ['sit', 'lie'])
  f.sync.stop()
})

test('a transient position failure retries only the newest sample while keeping the scene connected', async () => {
  const f = fixture((action, data) => {
    if (action === 'getScene') return { records: [] }
    if (data.seq === 1) throw new Error('网络超时')
    return { accepted: true, ackSeq: data.seq }
  })
  await f.sync.start()
  await f.sync.syncPosition(movement(1))
  f.sync.syncPosition(movement(4))
  f.sync.syncPosition(movement(10))
  await f.advance(350)
  assert.deepEqual(f.calls.filter(call => call.action === 'syncManor3d').map(call => call.data.position3d.x), [1, 10])
  assert.deepEqual(f.states, ['connecting', 'connected'])
  assert.deepEqual(f.errors, [])
  f.sync.stop()
})

test('watch publishes only updated peers, discards older versions, and expires disconnected peers', async () => {
  const alice = { id: 'alice', kind: 'presence', manor3d: true, manor3dOnline: true,
    manor3dLastSeen: 100000, version: { epoch: 1, seq: 1 } }
  const plot = { id: 'plot', kind: 'plot', version: { epoch: 1, seq: 1 } }
  const f = fixture(() => ({ records: [alice, plot], serverTime: 100000 }))
  await f.sync.start()
  assert.equal(f.applied[0].replace, true)
  f.watch({ docs: [{ records: { plot, alice: { ...alice, kind: 'manor3dPresence', version: { epoch: 1, seq: 3 } } } }] })
  f.watch({ docs: [{ records: { alice: { ...alice, version: { epoch: 1, seq: 2 } } } }] })
  await f.advance(32)
  assert.equal(f.applied[1].replace, false)
  assert.deepEqual(f.applied[1].records.map(record => [record.id, record.version.seq]), [['alice', 3]])
  assert.equal(f.applied[1].records[0].kind, 'presence')
  await f.advance(16032)
  assert.deepEqual(f.applied[2], { replace: false, records: [{ id: 'alice', kind: 'presence', deleted: true }] })
  f.sync.stop()
})

test('the snapshot and live watcher publish personal manor vehicle records', async () => {
  const vehicle = { id: 'car-neighbor', kind: 'manor3dVehicle', ownerId: 'neighbor',
    position3d: { x: 12, y: 4, z: 18 }, yaw: .4, seq: 2, version: { epoch: 1, seq: 2 } }
  const f = fixture(action => action === 'getScene' ? { records: [vehicle], serverTime: 100000 }
    : { accepted: true, ackSeq: 1 })
  await f.sync.start()
  assert.equal(f.applied[0].records[0].kind, 'manor3dVehicle')
  assert.equal(f.applied[0].records[0].mine, false)
  const moved = { ...vehicle, position3d: { x: 22, y: 4, z: 28 }, version: { epoch: 1, seq: 3 } }
  f.watch({ docs: [{ records: { [moved.id]: moved } }] })
  await f.advance(32)
  assert.equal(f.applied[1].replace, false)
  assert.deepEqual(f.applied[1].records[0].position3d, moved.position3d)
  assert.equal(f.applied[1].records[0].mine, false)
  f.sync.stop()
})

test('backgrounding while a movement request is in flight ignores its late failure', async () => {
  let rejectPosition
  const position = new Promise((resolve, reject) => { rejectPosition = reject })
  const f = fixture((action, data) => {
    if (action === 'getScene') return { records: [] }
    if (data.online) return position
    throw new Error('场景已切换，请重新进入')
  })
  await f.sync.start()
  const moving = f.sync.syncPosition({ position3d: { x: 12, z: 18 }, moving: true, running: false, facing: 0 })
  f.sync.stop()
  rejectPosition(new Error('旧请求失败'))
  await moving
  assert.deepEqual(f.calls.filter(call => call.action === 'syncManor3d').map(call => call.data.online), [true, false])
  assert.deepEqual(f.errors, [])
  assert.equal(f.timers.size, 0)
})
