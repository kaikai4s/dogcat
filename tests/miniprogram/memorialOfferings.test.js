const test = require('node:test')
const assert = require('node:assert/strict')
const { MemorialScene } = require('../../miniprogram/packageMemorial/scene/engine')
const { activeCounts, placements, MAX_VISIBLE } = require('../../miniprogram/packageMemorial/scene/offerings')
const worldIndex = require('../../miniprogram/packageMemorial/scene/world-index')
const { ids } = require('../../miniprogram/packageMemorial/scene/plot-layout')
const plot = worldIndex.cells.find(row => ids.includes(row.id))
function fixture(gender = 'boy') {
  const context = new Proxy({}, { get: () => () => {} })
  const s = new MemorialScene({ getContext: () => context, cancelAnimationFrame() {} }, { gender, now: () => 600000 })
  s.draw = () => {}; s.ready = true; s.image = async key => { s.images[key] = {}; return {} }
  const memorial = { ...plot, applicationId: 'app', kind: 'memorial', legacy: false }
  s.setMemorials([memorial]); s.player = { x: plot.x + 25, y: plot.y + 95 }
  return { s, memorial }
}
const settle = () => new Promise(resolve => setImmediate(resolve))
async function approach(s, memorial, kind) {
  let ready = false, error
  const pending = s.prepareOffering(memorial, kind).then(() => { ready = true }, e => { error = e })
  await settle()
  for (let i = 0; i < 4000 && !ready && !error; i++) { s.step(.05); await Promise.resolve() }
  await pending
  if (error) throw error
}
test('each unexpired flower and snack adds a scene prop; expired gifts vanish and dense gifts retain exact quantity', () => {
  const memorial = { x: 100, y: 200, offeringScene: { flower: [[10, 2], [12, 3]], snack: [[11, 1]] } }
  assert.deepEqual(activeCounts(memorial.offeringScene, 600000), { flower: 3, snack: 1 })
  assert.equal(placements(memorial, 600000).length, 4)
  const items = placements(memorial, 600000)
  assert.ok(items.filter(r => r.kind === 'flower').every(r => r.x < 100))
  assert.ok(items.filter(r => r.kind === 'snack').every(r => r.x > 100))
  assert.equal(new Set(items.filter(r => r.kind === 'flower').map(r => r.x + ':' + r.y)).size, 3)
  assert.equal(placements(memorial, 720000).length, 0)
  memorial.offeringScene.flower = [[13, 100]]
  const dense = placements(memorial, 720000)
  assert.equal(dense.filter(r => !r.label).length, MAX_VISIBLE)
  assert.equal(dense.at(-1).label, '×100')
})
test('both genders approach each offering side without teleporting, release once and return to idle', async () => {
  for (const gender of ['boy', 'girl']) for (const kind of ['flower', 'snack']) {
    const { s, memorial } = fixture(gender)
    const start = { ...s.player }, pending = s.prepareOffering(memorial, kind)
    await settle()
    assert.deepEqual(s.player, start)
    let ready = false
    pending.then(() => { ready = true })
    for (let i = 0; i < 4000 && !ready; i++) { s.step(.05); await Promise.resolve() }
    await pending
    assert.equal(s.ritual.state.phase, 'ready'); assert.equal(s.direction, 'nw')
    assert.equal(s.canWalk(s.player), true)
    let releases = 0, finished = false
    const animation = s.playOffering(() => { releases++ }).then(() => { finished = true })
    assert.equal(s.ritual.frame(), 0)
    for (let i = 0; i < 20; i++) s.step(.05)
    assert.equal(releases, 0); assert.equal(finished, false)
    for (let i = 0; i < 40; i++) s.step(.05)
    await animation
    assert.equal(releases, 1); assert.equal(s.ritual.frame(), null)
    s.destroy()
  }
})
test('pause cancels pending downloads, approaching and playing gestures without starting hidden work', async () => {
  const other = fixture()
  await approach(other.s, other.memorial, 'snack')
  const playing = other.s.playOffering()
  const rejected = assert.rejects(playing, /结束/)
  other.s.pause(); await rejected
  assert.equal(other.s.ritual.state, null)
  // Explicit cancellation invalidates asset completions even before the approach exists.
  let resolveAssets
  const third = fixture()
  const assets = new Promise(resolve => { resolveAssets = resolve })
  third.s.image = () => assets
  const loading = third.s.prepareOffering(third.memorial, 'flower')
  const cancelled = assert.rejects(loading, /结束/)
  third.s.pause(); resolveAssets({}); await cancelled
  assert.equal(third.s.ritual.state, null)
})
test('world removal and manual input cancel the approach and cannot complete a placement', async () => {
  for (const cancel of [s => s.setInput(1, 0), s => { s.setMemorials([]); s.step(.05) }]) {
    const { s, memorial } = fixture()
    const approaching = s.prepareOffering(memorial, 'flower')
    const rejected = assert.rejects(approaching, /结束/)
    await settle(); cancel(s); await rejected
    assert.equal(s.ritual.state, null)
  }
})
