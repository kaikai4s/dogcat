const test = require('node:test')
const assert = require('node:assert/strict')
const { GrassRenderer, grassGround, covered, MAX_TILES, MAX_TUFTS, MAX_IMPULSES } = require('../../miniprogram/packageMemorial/scene/grass')
const { environmentAt } = require('../../miniprogram/packageMemorial/scene/environment')
const world = require('../../miniprogram/packageMemorial/scene/world-index')
const env = environmentAt(Date.parse('2026-07-15T12:00:00+08:00'))
const view = { left: 1000, right: 1450, top: 1250, bottom: 1650 }
const scene = () => ({ player: { x: 1536, y: 1430 }, visitors: { actors: new Map() }, scale: 1, effectsEnabled: true, overview: false })
const candidate = grass => grass.tile(3, 3).find(p => p.x > 1200 && p.x < 1350 && p.y > 1350 && p.y < 1550)

test('grass roots remain deterministic after eviction, avoid pavement/building footprints, and cover the expanded lawns', () => {
  const grass = new GrassRenderer(), original = JSON.stringify(grass.tile(3, 3))
  let east = 0, south = 0
  for (let y = 0; y < 8; y++) for (let x = 0; x < 12; x++) {
    for (const p of grass.tile(x, y)) {
      assert.ok(grassGround(p.x, p.y))
      assert.equal(covered(p, world.objects), false)
      if (p.x > 3072) east++
      if (p.y > 2304) south++
    }
    assert.ok(grass.tiles.size <= MAX_TILES)
  }
  assert.ok(east > 100 && south > 100)
  assert.equal(JSON.stringify(grass.tile(3, 3)), original)
})

test('new or released memorial platforms update the grass mask without moving roots or obscuring the pet platform', () => {
  const grass = new GrassRenderer(), p = candidate(grass), s = scene()
  grass.prepare(s, view, env)
  assert.ok(grass.visible.some(item => item.p.id === p.id))
  const memorial = { kind: 'memorial', x: p.x, y: p.y }
  grass.setMemorials([memorial]); grass.prepare(s, view, env)
  assert.ok(grass.visible.every(item => !covered(item.p, [memorial])))
  grass.setMemorials([]); grass.prepare(s, view, env)
  assert.ok(grass.visible.some(item => item.p.id === p.id))
})

test('local and remote feet both bend nearby grass; grass recovers after departure and still reacts with weather effects disabled', () => {
  for (const remote of [false, true]) {
    const grass = new GrassRenderer(), s = scene(), p = candidate(grass)
    s.effectsEnabled = false
    const feet = { id: 'visitor', epoch: 1, x: p.x - 9, y: p.y - 2 }
    if (remote) s.visitors.actors.set('visitor', feet)
    else s.player = feet
    grass.prepare(s, view, env)
    const touched = grass.visible.find(item => item.p.id === p.id)
    assert.ok(touched.press > .7)
    assert.ok(touched.bend > 4)
    s.player = { x: 1536, y: 1430 }; s.visitors.actors.clear()
    for (let i = 0; i < 20; i++) grass.advance(.05)
    grass.prepare(s, view, env)
    const recovering = grass.visible.find(item => item.p.id === p.id)
    assert.ok(recovering.press < touched.press * .06)
    assert.ok(Math.abs(recovering.bend) < Math.abs(touched.bend) * .1)
    for (let i = 0; i < 30; i++) grass.advance(.05)
    grass.prepare(s, view, env)
    assert.equal(grass.impulses.has(p.id), false)
  }
})

test('walking parts grass to either side, while distant feet and teleports leave no swept trail', () => {
  const grass = new GrassRenderer()
  const feet = [{ x: 1200, y: 1400, ax: 1200, ay: 1400 }]
  assert.ok(grass.contact({ id: 1, x: 1190, y: 1400 }, feet).bend < 0)
  assert.ok(grass.contact({ id: 2, x: 1210, y: 1400 }, feet).bend > 0)
  assert.equal(grass.contact({ id: 3, x: 1260, y: 1400 }, feet).press, 0)
  const s = scene(); s.player = { x: 1100, y: 1400 }
  grass.footprints(s, view); s.player = { x: 1400, y: 1400 }
  const bins = grass.footprints(s, view)
  assert.equal(grass.contact({ id: 4, x: 1250, y: 1400 }, [...bins.values()].flat()).press, 0)
  grass.previous.set('visitor', { x: 1100, y: 1400, epoch: 1 })
  s.visitors.actors.set('visitor', { id: 'visitor', x: 1120, y: 1400, epoch: 2 })
  const changedEpoch = [...grass.footprints(s, view).values()].flat().find(f => f.x === 1120)
  assert.equal(changedEpoch.ax, 1120)
})

test('crowded/panned scenes retain bounded grass, history and cache; overview and pause discard stale footsteps', () => {
  const grass = new GrassRenderer(), s = scene()
  for (let step = 0; step < 60; step++) {
    const x = 300 + step * 60
    s.player = { x, y: 1500 }
    for (let i = 0; i < 100; i++) s.visitors.actors.set('v' + i, { id: 'v' + i, x: x - 180 + i % 10 * 36, y: 1200 + Math.floor(i / 10) * 50 })
    grass.advance(.05)
    grass.prepare(s, { left: x - 300, right: x + 300, top: 1000, bottom: 1900 }, env)
    assert.ok(grass.visible.length <= MAX_TUFTS)
    assert.ok(grass.tiles.size <= MAX_TILES)
    assert.ok(grass.impulses.size <= MAX_IMPULSES)
    assert.ok(grass.previous.size <= 101)
  }
  s.overview = true; grass.prepare(s, view, env)
  assert.equal(grass.visible.length, 0)
  assert.equal(grass.impulses.size, 0)
  assert.equal(grass.previous.size, 0)
  s.overview = false; grass.prepare(s, view, env)
  grass.resetMotion(); assert.equal(grass.impulses.size, 0)
  grass.destroy(); assert.equal(grass.tiles.size, 0)
})

test('cached blade poses fit inside sprite cells, retain the root when flattened, and reuse one atlas', () => {
  let allocations = 0, paths = [], current = [], paints = 0
  const ctx = { clearRect() {}, save() {}, restore() {}, beginPath() { current = []; paths.push(current) },
    moveTo(x, y) { current.push([x, y]) }, quadraticCurveTo(...points) { for (let i = 0; i < points.length; i += 2) current.push(points.slice(i, i + 2)) }, closePath() {}, fill() { paints++ } }
  const grass = new GrassRenderer((width, height) => { allocations++; return { width, height, getContext: () => ctx } })
  const draws = [], main = { save() {}, restore() {}, drawImage(...args) { draws.push(args) } }
  grass.prepare(scene(), view, env)
  const variants = new Map(grass.visible.map(item => [item.p.variant, item]))
  const items = [...variants.values()].flatMap(item => [-15, 15].map(bend => ({ ...item, bend, press: .9 })))
  grass.draw(main, items)
  for (const points of paths) {
    const [first] = points
    if (!first) continue
    for (const [x, y] of points) {
      assert.equal(Math.floor(x / 64), Math.floor(first[0] / 64))
      assert.equal(Math.floor(y / 24), Math.floor(first[1] / 24))
    }
  }
  for (let i = 0; i < draws.length; i++) {
    const scaleY = items[i].height * (1 - items[i].press * .64)
    assert.ok(Math.abs(draws[i][6] + 20 * scaleY - items[i].p.y) < 1e-9)
  }
  const before = paints
  grass.draw(main, items)
  assert.equal(paints, before)
  assert.equal(allocations, 1)
  assert.ok(grass.atlas.width * grass.atlas.height * 4 < 3 * 1024 * 1024)
  grass.destroy(); assert.equal(grass.atlas, null)
})

test('missing offscreen canvas falls back to batched paths and close detail is omitted at map scale', () => {
  const grass = new GrassRenderer(() => { throw new Error('unavailable') })
  const s = scene(), calls = []
  const ctx = new Proxy({}, { get: (_, key) => (...args) => calls.push([key, ...args]) })
  grass.prepare(s, view, env); grass.draw(ctx)
  assert.equal(calls.filter(c => c[0] === 'fill').length, 3)
  assert.ok(calls.some(c => c[0] === 'quadraticCurveTo'))
  s.scale = .5; grass.prepare(s, view, env)
  assert.equal(grass.visible.length, 0)
})

test('wind uses the frame clock between one-second environment updates and pause clears interaction history', () => {
  const grass = new GrassRenderer(), s = scene()
  grass.prepare(s, view, env, env.time)
  const first = grass.visible.map(item => item.bend)
  grass.prepare(s, view, env, env.time + 16)
  const next = grass.visible.map(item => item.bend)
  assert.ok(next.some((bend, i) => bend !== first[i]))
  assert.ok(next.every((bend, i) => Math.abs(bend - first[i]) < .1))
  const { MemorialScene } = require('../../miniprogram/packageMemorial/scene/engine')
  const engine = new MemorialScene({ getContext: () => ({}), cancelAnimationFrame() {} })
  engine.grass.impulses.set(1, { time: 0, bend: 3, press: .5 })
  engine.grass.previous.set('local', { x: 1200, y: 1400 })
  engine.pause()
  assert.equal(engine.grass.impulses.size, 0)
  assert.equal(engine.grass.previous.size, 0)
  engine.destroy(); assert.equal(engine.grass.tiles.size, 0)
})
