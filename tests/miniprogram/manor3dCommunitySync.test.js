const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

const source = fs.readFileSync(require.resolve('../../miniprogram/packageManor3d/utils/manor-community-sync'), 'utf8')
const scene = { sceneId: 'court', session: 'session', playerId: 'owner', hasAvatar: true }

function fixture(callFunction) {
  const module = { exports: {} }, timers = new Map(), errors = [], states = [], calls = []
  let nextTimer = 0, closed = 0
  const query = { where: () => query, limit: () => query, watch: () => ({ close() { closed += 1 } }) }
  vm.runInNewContext(source, {
    module, require: () => ({
      getCloudEnv: () => 'test-env',
      async callFunction(name, action, data) {
        calls.push({ name, action, data: { ...data } })
        return callFunction(action, data)
      }
    }),
    wx: { cloud: { database: () => ({ collection: () => query }) } },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { timers.delete(id) }
  })
  const sync = new module.exports.ManorCommunitySync(scene, () => {}, error => errors.push(error.message), state => states.push(state))
  return { sync, timers, errors, states, calls, get closed() { return closed } }
}

test('an expired scene snapshot stops the watcher without retrying the expired credential', async () => {
  const f = fixture(() => { throw new Error('场景已切换，请重新进入') })
  await f.sync.start()
  assert.deepEqual(f.calls, [{ name: 'playground', action: 'getScene', data: { sceneId: 'court', session: 'session', cursor: '' } }])
  assert.deepEqual(f.errors, ['场景已切换，请重新进入'])
  assert.deepEqual(f.states, ['connecting'])
  assert.equal(f.closed, 1)
  assert.equal(f.timers.size, 0)
  assert.equal(f.sync.active, false)
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
