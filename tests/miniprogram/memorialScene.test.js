const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const G = require('../../miniprogram/packageMemorial/scene/geometry')
const layout = require('../../miniprogram/packageMemorial/scene/layout')
const { MemorialScene } = require('../../miniprogram/packageMemorial/scene/engine')
const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
function canvasFixture() {
  const draws = [], callbacks = new Map(), loads = []
  let id = 0
  const context = new Proxy({}, { get: (_, key) => (...args) => { if (key === 'drawImage') draws.push(args) }, set: () => true })
  const canvas = { getContext: () => context, requestAnimationFrame: fn => { callbacks.set(++id, fn); return id },
    cancelAnimationFrame: id => callbacks.delete(id), createImage() { const img = {}; loads.push(img); return img } }
  return { canvas, draws, callbacks, loads }
}
function makeScene() { const f = canvasFixture(); return { ...f, scene: new MemorialScene(f.canvas, { width: 390, height: 740 }) } }

test('parallel projection preserves distances and sizes at every ground position', () => {
  for (const y of [0, 150, 450, 899]) for (const x of [-400, 0, 800, 1800]) {
    const actual = G.unproject(G.project({ x, y }))
    assert.ok(Math.abs(actual.x - x) < 1e-8)
    assert.ok(Math.abs(actual.y - y) < 1e-8)
  }
  assert.equal(G.depthScale({ y: 1800 }), G.depthScale({ y: 200 }))
})

test('all lawn regions have regularly keyed cells and each full footprint avoids obstacles', () => {
  const cells = G.createCells(layout)
  assert.equal(new Set(cells.map(c => c.id)).size, cells.length)
  for (const lawn of layout.lawns) assert.ok(cells.some(c => c.corners.every(p => G.inside(p, lawn.polygon))), lawn.name)
  for (const cell of cells) {
    assert.equal(cell.corners[0].x, cell.col * 64 + 12)
    assert.equal(cell.corners[0].y, cell.row * 64 + 16)
    assert.ok(G.validCell(cell.corners, layout))
  }
  assert.ok(G.walkable(layout.spawn, layout))
  assert.equal(G.walkable({ x: 800, y: 30 }, layout), false)
})

test('plot footprint rejects a fully enclosed obstacle and a concave lawn notch', () => {
  const map = { boundary: rect(-100, -100, 300, 300), lawns: [{ polygon: rect(0, 0, 100, 100) }], obstacles: [rect(40, 40, 5, 5)] }
  assert.equal(G.validCell(rect(20, 20, 60, 60), map), false)
  map.obstacles = []
  map.lawns[0].polygon = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 60, y: 100 }, { x: 60, y: 40 }, { x: 40, y: 40 }, { x: 40, y: 100 }, { x: 0, y: 100 }]
  assert.equal(G.validCell(rect(20, 20, 60, 60), map), false)
})

test('movement handles four directions, collision and distance-driven walk phases', () => {
  const { scene } = makeScene()
  scene.map = { boundary: rect(-1000, -1000, 4000, 4000), obstacles: [] }
  for (const [x, y, dir] of [[-1, 1, 'sw'], [1, 1, 'se'], [-1, -1, 'nw'], [1, -1, 'ne']]) {
    scene.player = { x: 800, y: 500 }
    scene.setInput(x, y)
    const before = { ...scene.player }, phase = scene.walkPhase
    scene.step(0.05)
    const moved = G.distance(before, scene.player)
    assert.equal(scene.direction, dir)
    assert.ok(Math.abs(moved - 6) < 1e-8)
    assert.ok(Math.abs(scene.walkPhase - (phase + moved / 98 * 8) % 8) < 1e-8)
  }
  scene.player = { x: 100, y: 500 }
  scene.map.obstacles = [rect(110, 0, 2, 1000)]
  scene.setInput(1, 0)
  for (let i = 0; i < 100; i++) scene.step(5)
  assert.ok(scene.player.x <= 102)
  const phase = scene.walkPhase
  scene.step(0.05)
  assert.equal(scene.walkPhase, phase)
  assert.equal(scene.moving, false)
  scene.setInput(0, 0)
  assert.deepEqual(scene.input, { x: 0, y: 0 })
})

test('renderer slices the second row and never animates by moving the anchor', () => {
  const { scene, draws } = makeScene()
  scene.ready = true
  scene.images['garden.jpg'] = { background: true }
  const atlas = scene.images['boy/walk-sw.png'] = { sprite: true }
  scene.moving = true
  scene.walkPhase = 7
  scene.draw()
  const last = draws.find(d => d[0] === atlas)
  assert.deepEqual(last.slice(1, 5), [384, 128, 128, 128])
  scene.walkPhase = 0
  scene.draw()
  const first = draws.filter(d => d[0] === atlas).at(-1)
  assert.deepEqual(first.slice(5), last.slice(5))
})

test('pause, resume and destroy keep at most one render loop and clear held movement', () => {
  const { scene, callbacks } = makeScene()
  scene.ready = true
  scene.start(); scene.start()
  assert.equal(callbacks.size, 1)
  scene.setInput(1, 1)
  scene.pause()
  assert.equal(callbacks.size, 0)
  assert.deepEqual(scene.input, { x: 0, y: 0 })
  scene.start()
  assert.equal(callbacks.size, 1)
  scene.destroy(); scene.start()
  assert.equal(callbacks.size, 0)
})

test('late avatar image loads cannot resurrect a destroyed scene; failures can retry', async () => {
  const { scene, loads } = makeScene()
  const failure = scene.image('boy/walk-sw.png')
  loads[0].onerror()
  await assert.rejects(failure, /未能加载/)
  const retry = scene.image('boy/walk-sw.png')
  assert.equal(loads.length, 2)
  loads[1].onload()
  await retry
  const change = scene.setGender('girl')
  scene.destroy()
  loads.slice(2).forEach(img => img.onload())
  assert.equal(await change, false)
  assert.deepEqual(scene.images, {})
})

test('overview disables movement and zoom/camera stay within the painting', () => {
  const { scene } = makeScene()
  scene.toggleOverview()
  scene.setInput(1, 1)
  assert.deepEqual(scene.input, { x: 0, y: 0 })
  scene.setZoom(100)
  assert.ok(Math.abs(scene.zoom - 1.8) < 1e-8)
  for (const p of [{ x: 0, y: 0 }, { x: 2000, y: 900 }]) {
    scene.player = p
    scene.updateCamera(1, true)
    assert.ok(scene.camera.x >= scene.width / scene.scale / 2)
    assert.ok(scene.camera.x <= G.WIDTH - scene.width / scene.scale / 2)
    assert.ok(scene.camera.y >= scene.height / scene.scale / 2)
    assert.ok(scene.camera.y <= G.HEIGHT - scene.height / scene.scale / 2)
  }
})

test('page does not start a hidden scene after asynchronous loading, resumes once and destroys on exit', async () => {
  let definition, finish, instance
  class FakeScene {
    constructor() { instance = this; this.starts = 0; this.ready = false }
    load() { return new Promise(resolve => { finish = () => { this.ready = true; resolve() } }) }
    start() { this.starts++ }
    pause() { this.paused = true }
    destroy() { this.destroyed = true }
    setInput(x, y) { this.input = [x, y] }
  }
  const wx = { getStorageSync() {}, getWindowInfo: () => ({ pixelRatio: 2 }), createSelectorQuery() {
    const q = { in: () => q, select: () => q, fields: () => q, boundingClientRect: () => q,
      exec: fn => fn([{ node: {}, width: 390, height: 740 }, { left: 22, top: 560, width: 118, height: 118 }]) }
    return q
  } }
  vm.runInNewContext(fs.readFileSync(require.resolve('../../miniprogram/packageMemorial/pages/garden'), 'utf8'), {
    Page: value => { definition = value }, require: name => name === '../scene/engine' ? { MemorialScene: FakeScene } :
      require('../../miniprogram/packageMemorial/scene/' + name.split('/').pop()), wx
  })
  const page = { ...definition, data: structuredClone(definition.data), setData(value) { Object.assign(this.data, value) } }
  page.onLoad(); page.onShow(); page.onReady(); page.onHide()
  finish(); await Promise.resolve(); await Promise.resolve()
  assert.equal(instance.starts, 0)
  page.onShow()
  assert.equal(instance.starts, 1)
  page.onUnload()
  assert.equal(instance.destroyed, true)
  assert.deepEqual(instance.input, [0, 0])
})

test('memorial is a separate package below the size budget with all sixteen atlases', () => {
  const root = path.resolve(__dirname, '../../miniprogram/packageMemorial')
  function size(dir) { return fs.readdirSync(dir, { withFileTypes: true }).reduce((n, f) => n + (f.isDirectory() ? size(path.join(dir, f.name)) : fs.statSync(path.join(dir, f.name)).size), 0) }
  assert.ok(size(root) - size(path.join(root, 'assets')) < 2 * 1024 * 1024)
  assert.ok(require('../../project.config.json').packOptions.ignore.some(p => p.value === 'packageMemorial/assets'))
  const app = require('../../miniprogram/app.json')
  assert.ok(app.subpackages.some(p => p.root === 'packageMemorial' && p.pages.includes('pages/garden')))
  for (const gender of ['boy', 'girl']) for (const action of ['idle', 'walk']) for (const dir of ['sw', 'se', 'nw', 'ne']) {
    const png = fs.readFileSync(path.join(root, 'assets', gender, action + '-' + dir + '.png'))
    assert.equal(png.readUInt32BE(16), 512)
    assert.equal(png.readUInt32BE(20), 256)
  }
})
