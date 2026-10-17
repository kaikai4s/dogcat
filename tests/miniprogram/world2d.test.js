const test = require('node:test')
const assert = require('node:assert/strict')
const {
  World2D,
  yardObstacles
} = require('../../miniprogram/packagePlayground/utils/world2d')
const {
  createNavigation
} = require('../../miniprogram/packagePlayground/utils/navigation')
function create(extra = {}) {
  const page = { setData() {}, fetchRegion: async () => ({ plots: [] }) }
  return new World2D(page, () => {}, {
    world: { width: 2240, height: 2240 },
    pets: [{ _id: 'dog', name: '豆豆', species: 'dog' }],
    ...extra
  })
}
test('unclaimed scene stays empty and projection round-trips a large world', () => {
  const w = create()
  w.buildWorld()
  assert.equal(w.plots().length, 0)
  for (const source of [
    { x: 0, z: 0 },
    { x: 2220, z: 1400 }
  ]) {
    const p = w.project(source.x, source.z),
      r = w.unproject(p.x, p.y)
    assert.ok(Math.abs(r.x - source.x) < 1e-8)
    assert.ok(Math.abs(r.z - source.z) < 1e-8)
  }
})
test('manual movement stays idle until requested and rejects out-of-world destinations', async () => {
  const w = create()
  w.buildWorld()
  const start = { ...w.pets[0].position }
  w.update(30)
  assert.deepEqual(w.pets[0].position, start)
  await w.moveTo({ x: -20, z: 100 })
  assert.equal(w.pets[0].route.length, 0)
  const target = { x: start.x + 10, z: start.z }
  await w.moveTo(target)
  for (let i = 0; i < 40; i++) w.update(0.1)
  assert.deepEqual(w.pets[0].position, target)
  w.update(100)
  assert.deepEqual(w.pets[0].position, target)
})
test('fence blocks shortcuts while six metre gate allows entering and leaving', () => {
  const p = { x: 84, z: 84 }
  const nav = createNavigation(
    { minX: 20, maxX: 150, minZ: 20, maxZ: 150 },
    yardObstacles(p),
    0.8,
    1.5
  )
  assert.equal(nav.clearSegment({ x: 84, z: 104 }, { x: 84, z: 115 }), true)
  assert.equal(nav.clearSegment({ x: 70, z: 104 }, { x: 70, z: 115 }), false)
  assert.equal(nav.walkable({ x: 84, z: 84 }), false)
  const path = nav.path({ x: 70, z: 100 }, { x: 70, z: 116 })
  assert.ok(path)
  assert.ok(path.some((t) => t.x > 80 && t.x < 88 && t.z > 106))
})
test('viewport loads bounded chunks, shares in-flight requests and evicts distant regions', async () => {
  const w = create()
  let calls = 0
  w.page.fetchRegion = async () => {
    calls++
    return { plots: [] }
  }
  await Promise.all([w.loadChunk(0, 0), w.loadChunk(0, 0)])
  assert.equal(calls, 1)
  await w.loadVisible()
  assert.ok(calls < 20)
  w.camera = { x: 2000, z: 2000 }
  await w.loadVisible()
  assert.equal(w.chunks.has('0,0'), false)
  assert.ok(w.chunks.size < 25)
})
test('placement is offered only on loaded unoccupied grass and not beyond bounds', async () => {
  const w = create()
  w.buildWorld()
  w.beginPlacement()
  await w.pickPlot({ x: 84, z: 84 })
  assert.equal(w.candidate.cellX, 1)
  w.chunks.set('0,0', [{ id: 'taken', cellX: 1, cellZ: 1, x: 84, z: 84 }])
  await w.pickPlot({ x: 84, z: 84 })
  assert.equal(w.candidate, null)
  await w.pickPlot({ x: 9999, z: 9999 })
  assert.equal(w.candidate, null)
  w.setPlot({ id: 'mine', x: 140, z: 140, size: 48 })
  w.beginPlacement()
  assert.equal(w.placing, false)
})
