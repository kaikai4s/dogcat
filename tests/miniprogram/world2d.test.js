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
  w.selectPet('dog')
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
  const p = { x: 84, z: 84, size: 48 }
  const nav = createNavigation(
    { minX: 20, maxX: 150, minZ: 20, maxZ: 150 },
    yardObstacles(p),
    0.8,
    1.5
  )
  assert.equal(nav.clearSegment({ x: 84, z: 104 }, { x: 84, z: 115 }), true)
  assert.equal(nav.clearSegment({ x: 70, z: 104 }, { x: 70, z: 115 }), false)
  assert.equal(nav.walkable({ x: 84, z: 84 }), false)
  const path = nav.path({ x: 70, z: 104 }, { x: 70, z: 116 })
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

test('walking keeps the camera fixed and retains an exact destination until arrival', async () => {
  const w = create()
  w.buildWorld()
  w.selectPet('dog')
  w.camera = { x: 1100, z: 1150 }
  w.follow = true
  const camera = { ...w.camera },
    target = { x: w.pets[0].position.x + 20, z: w.pets[0].position.z + 5 }
  await w.moveTo(target)
  assert.equal(w.follow, false)
  assert.deepEqual(w.pets[0].destination, target)
  for (let i = 0; i < 80; i++) w.update(0.1)
  assert.deepEqual(w.camera, camera)
  assert.deepEqual(w.pets[0].position, target)
  assert.ok(w.pets[0].arrivedAt)
})
test('placement uses the tapped center without snapping and confirmation keeps camera and preview location', async () => {
  const w = create({
    world: { width: 2240, height: 2240, canRelocate: true, plotSize: 112 },
    plot: { id: 'old', x: 140, z: 140, size: 48, mine: true }
  })
  w.buildWorld()
  w.beginPlacement()
  const point = { x: 369.25, z: 421.75 }
  await w.pickPlot(point)
  assert.equal(w.candidate.x, point.x)
  assert.equal(w.candidate.z, point.z)
  assert.equal(w.candidate.size, 112)
  const camera = { ...w.camera },
    plot = { ...w.candidate, id: 'new', mine: true }
  w.chunks.set('1,1', [w.ownPlot])
  w.setPlot(plot)
  assert.deepEqual(w.camera, camera)
  assert.equal(w.ownPlot.x, point.x)
  assert.equal(
    w.plots().some((p) => p.id === 'old'),
    false
  )
  w.beginPlacement()
  assert.equal(w.placing, true)
})
test('manual pinch fits every world corner without requesting empty chunks; map centering keeps that zoom', async () => {
  for (const size of [
    { width: 224, height: 448 },
    { width: 2240, height: 2240 },
    { width: 11200, height: 5600 }
  ]) {
    const w = create({ world: size })
    w.width = 390
    w.height = 844
    let calls = 0
    w.page.fetchRegion = async () => {
      calls++
      return { plots: [] }
    }
    w.page.fetchMapOverview = async () => ({ plots: [], nextCursor: '' })
    w.touchStart([{x:0,y:200},{x:1000,y:200}])
    w.touchMove([{x:499.999,y:200},{x:500.001,y:200}])
    const zoom=w.zoom
    w.fullOverview()
    assert.equal(w.zoom,zoom)
    await w.loadVisible()
    assert.deepEqual(w.camera, { x: size.width / 2, z: size.height / 2 })
    const screen = w.screenCenter()
    for (const [x, z] of [
      [0, 0],
      [size.width, 0],
      [size.width, size.height],
      [0, size.height]
    ]) {
      const p = w.project(x, z)
      assert.ok(p.x >= 15 && p.x <= 375)
      assert.ok(p.y >= screen.top && p.y <= screen.bottom)
    }
    if (size.width >= 2240) assert.equal(calls, 0)
  }
})
test('native touch coordinates account for canvas offset and use release point for placement', () => {
  const w = create()
  w.canvasRect = { left: 17, top: 31 }
  w.placing = true
  let received
  w.pickPlot = (point) => {
    received = point
  }
  const screen = w.project(356.5, 410.25)
  w.touchStart([{ clientX: screen.x + 17 - 1, clientY: screen.y + 31 - 1 }])
  w.touchEnd([{ clientX: screen.x + 17, clientY: screen.y + 31 }])
  assert.ok(Math.abs(received.x - 356.5) < 1e-8)
  assert.ok(Math.abs(received.z - 410.25) < 1e-8)
})

test('pinch can reach full map scale and recenters an off-center camera', () => {
  const w = create({ world: { width: 11200, height: 5600 } })
  w.camera = { x: 200, z: 400 }
  w.touchStart([
    { x: 0, y: 200 },
    { x: 1000, y: 200 }
  ])
  w.touchMove([
    { x: 499.5, y: 200 },
    { x: 500.5, y: 200 }
  ])
  assert.equal(w.zoom, w.minimumZoom())
  assert.deepEqual(w.camera, { x: 5600, z: 2800 })
  assert.equal(w.gesture.moved, true)
})

test('pure empty yard does not trigger dog bowl interaction and keeps residential home intact', () => {
  const w = create()
  const homePlot = {
    id: 'home_plot_1',
    plotId: 'home_plot_1',
    mine: true,
    buildingType: 'residential',
    x: 100,
    z: 100,
    size: 48,
    foodBowls: { dog: 50, cat: 50 }
  }
  const pureYard = {
    id: 'yard_plot_2',
    plotId: 'yard_plot_2',
    mine: true,
    buildingType: 'yard',
    x: 300,
    z: 300,
    size: 48,
    isNewPlot: true
  }

  w.sharedPlots = new Map([
    [homePlot.id, homePlot],
    [pureYard.id, pureYard]
  ])
  w.ownPlot = homePlot
  w.foodBowls = { dog: 50, cat: 50 }

  // 1. 角色走在纯地皮的相对食盆位置，绝对不应触发狗碗交互
  const { yardLayout } = require('../../miniprogram/packagePlayground/utils/yard-layout')
  const yardFakeBowl = yardLayout(pureYard).stations.dog.eat
  w.character = { position: { x: yardFakeBowl.x, z: yardFakeBowl.z } }
  w.characterTerrain = { cellX: Math.floor(yardFakeBowl.x / 56), cellZ: Math.floor(yardFakeBowl.z / 56) }
  w.characterAreaLoaded = () => true
  w.characterNavigation = () => ({ clearSegment: () => true })

  const nearbyInYard = w.nearbyInteractions()
  assert.equal(nearbyInYard.bowl, null, '纯地皮内不应触发狗碗交互')

  // 2. 角色走在初始出生庭院的真实食盆位置，正确触发狗碗交互
  const homeRealBowl = yardLayout(homePlot).stations.dog.eat
  w.character = { position: { x: homeRealBowl.x, z: homeRealBowl.z } }
  w.characterTerrain = { cellX: Math.floor(homeRealBowl.x / 56), cellZ: Math.floor(homeRealBowl.z / 56) }
  const nearbyInHome = w.nearbyInteractions()
  assert.ok(nearbyInHome.bowl, '出生庭院内应正常触发狗碗交互')
  assert.equal(nearbyInHome.bowl.plotId, homePlot.id)
})
