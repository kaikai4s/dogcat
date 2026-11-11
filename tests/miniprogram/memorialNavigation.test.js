const test = require('node:test')
const assert = require('node:assert/strict')
const { findRoute, clearLine } = require('../../miniprogram/packageMemorial/scene/navigation')
const index = require('../../miniprogram/packageMemorial/scene/world-index')
const world = require('../../miniprogram/packageMemorial/scene/world-template')
const { GroundCache } = require('../../miniprogram/packageMemorial/scene/ground-cache')
const { GardenSound } = require('../../miniprogram/packageMemorial/scene/sound')
test('routes reach both sides of the garden and avoid scenery along every segment', () => {
  for (const target of [...world.landmarks, { x: 2700, y: 2100 }, { x: 300, y: 300 }]) {
    const route = findRoute(world.spawn, target)
    assert.ok(route.length > 1)
    for (let i = 1; i < route.length; i++) assert.ok(clearLine(route[i - 1], route[i], index.objects))
    assert.ok(Math.hypot(route.at(-1).x - target.x, route.at(-1).y - target.y) < 180)
  }
})
test('approved memorials block navigation and client/server catalogs remain identical', () => {
  const memorial = { kind: 'memorial', x: world.spawn.x, y: world.spawn.y - 100 }
  const route = findRoute(world.spawn, { x: world.spawn.x, y: world.spawn.y - 220 }, [memorial])
  for (let i = 1; i < route.length; i++) assert.ok(clearLine(route[i - 1], route[i], index.objects.concat(memorial)))
  assert.deepEqual(index, require('../../cloudfunctions/api/config/memorial-world.json'))
  assert.equal(new Set(index.cells.map(p => p.id)).size, 492)
})
test('ground cache paints paving once then uses drawImage while panning over cached tiles', () => {
  let paints = 0, images = 0
  const ctx = new Proxy({}, { get: (_, key) => key === 'strokeRect' ? () => paints++ : () => {} })
  const cache = new GroundCache(() => ({ getContext: () => ctx }))
  const main = { drawImage() { images++ } }, view = { left: 800, top: 800, right: 1100, bottom: 1100 }
  cache.draw(main, view, {}, 1)
  const initial = paints
  assert.ok(initial > 0)
  for (let i = 0; i < 100; i++) cache.draw(main, { ...view, left: 800 + i / 100 }, {}, 1)
  assert.equal(paints, initial); assert.equal(images, 101)
  cache.destroy(); assert.equal(cache.tiles.size, 0)
})
test('native audio never seeks before decoding; replay can seek after canplay', () => {
  let canplay, seeks = 0, plays = 0
  const sound = new GardenSound(() => ({ onError() {}, onCanplay(fn) { canplay = fn }, seek() { seeks++ }, play() { plays++ }, pause() {}, destroy() {} }))
  sound.toggle('effects'); assert.equal(seeks, 0); assert.equal(plays, 1)
  canplay(); sound.chime(); assert.equal(seeks, 1); assert.equal(plays, 2)
  sound.destroy()
})

test('pan and pinch merge into the animation loop rather than rendering extra frames', () => {
  const { MemorialScene } = require('../../miniprogram/packageMemorial/scene/engine')
  let paints = 0, frame
  const scene = new MemorialScene({ getContext: () => ({}), requestAnimationFrame(fn) { frame = fn; return 1 }, cancelAnimationFrame() {} })
  scene.ready = true; scene.draw = () => paints++
  scene.start()
  for (let i = 0; i < 40; i++) { scene.pan(2, 1); scene.zoomAt(1.001) }
  assert.equal(paints, 0)
  frame(100); assert.equal(paints, 1)
  scene.destroy()
})
