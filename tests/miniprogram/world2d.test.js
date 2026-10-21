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
test('building instances normalize legacy data without resurrecting removed buildings', () => {
  const fs = require('node:fs')
  const client = '../../miniprogram/packagePlayground/utils/'
  const server = '../../cloudfunctions/api/services/playground-shared/'
  for (const name of ['plot-buildings', 'yard-layout', 'farm-model']) {
    assert.equal(fs.readFileSync(require.resolve(client + name), 'utf8'), fs.readFileSync(require.resolve(server + name), 'utf8'))
  }
  const { placedBuildings, withBuildings, buildingGeometryKey } = require(client + 'plot-buildings')
  const legacy = { id: 'legacy_garden', x: 400, z: 400, size: 48, isNewPlot: true,
    buildingId: 'tree_template', buildingType: 'tree', buildingWidth: 7, buildingDepth: 7, buildingX: 410, buildingZ: 412 }
  const instances = placedBuildings(legacy)
  assert.equal(instances.length, 1)
  assert.equal(instances[0].x, 410)
  assert.equal(instances[0].z, 412)
  assert.equal(placedBuildings(legacy)[0].instanceId, instances[0].instanceId)
  assert.deepEqual(placedBuildings({ ...legacy, buildings: [] }), [])
  const normalized = withBuildings(legacy, instances)
  assert.equal(normalized.buildings.length, 1)
  assert.equal(normalized.buildingType, 'tree')
  const moved = withBuildings(normalized, [{ ...instances[0], x: 408 }])
  assert.notEqual(buildingGeometryKey(normalized), buildingGeometryKey(moved))
  const home = withBuildings({ ...legacy, isNewPlot: false }, instances)
  assert.equal(home.buildingType, 'residential')
  assert.equal(home.buildings.length, 1)
  assert.equal(withBuildings(home, []).buildingType, 'residential')
  const { yardLayout } = require(client + 'yard-layout')
  const sprites = yardLayout(home).sprites
  assert.ok(sprites.some((s) => s.name === 'house' && !s.buildingInstanceId))
  assert.ok(sprites.some((s) => s.buildingInstanceId === instances[0].instanceId))
})

test('instance placement validates other buildings but permits flooring and excludes only the moved instance', () => {
  const { validateBuildingPlacement } = require('../../miniprogram/packagePlayground/utils/plot-buildings')
  const tree = { instanceId: 'existing_tree', buildingId: 'tree', type: 'tree', category: 'tree', width: 7, depth: 7, x: 400, z: 400 }
  const plot = { id: 'capacity_plot', x: 400, z: 400, size: 48, isNewPlot: true, buildings: [tree] }
  assert.ok(validateBuildingPlacement(plot, tree, { x: 400, z: 406 }))
  assert.equal(validateBuildingPlacement(plot, tree, { x: 400, z: 407 }), null)
  assert.equal(validateBuildingPlacement(plot, tree, { x: 400, z: 400 }, tree.instanceId), null)
  assert.equal(validateBuildingPlacement(plot, { ...tree, type: 'floor', category: 'floor' }, { x: 400, z: 400 }), null)
  const publicBuilding = { instanceId: 'public_one', type: 'committee', category: 'public', width: 7, depth: 7, x: 400, z: 400 }
  assert.ok(validateBuildingPlacement({ ...plot, buildings: [publicBuilding] }, publicBuilding, { x: 414, z: 414 }))
  assert.equal(validateBuildingPlacement({ ...plot, buildings: [publicBuilding] }, tree, { x: 414, z: 414 }), null)
  const home = { ...plot, isNewPlot: false, buildingType: 'residential', buildings: [] }
  assert.ok(validateBuildingPlacement(home, { ...tree, type: 'wood_cabin', category: 'residential' }, { x: 400, z: 400 }))
  assert.ok(validateBuildingPlacement(home, publicBuilding, { x: 414, z: 414 }))
})

test('building previews keep the home visible in both scene and overview rendering', async () => {
  const w = create()
  const home = { id: 'home_visible', x: 400, z: 400, size: 48, mine: true, isNewPlot: false, buildingType: 'residential' }
  w.ownPlot = home
  w.sharedPlots.set(home.id, home)
  w.isPlacingBuilding = true
  w.isPlacingNewPlot = false
  w.candidate = { isBuilding: true, x: 416, z: 416, width: 7, depth: 7, valid: true }
  const rendered = []
  let markers = 0
  w.ctx = { setTransform() {}, fillRect() {}, save() {}, transform() {}, scale() {}, restore() {},
    beginPath() {}, arc() { markers++ }, fill() {}, stroke() {} }
  w.visibleBounds = () => ({ minX: 0, minZ: 0, maxX: 1000, maxZ: 1000 })
  w.isMapOverview = () => false
  w.drawYard = (plot) => rendered.push(plot.id)
  for (const name of ['drawFarm', 'drawPetSelection', 'drawYardOwners', 'drawDestination', 'drawPetNames', 'drawInteractionFeedback', 'drawPlacement', 'drawCharacter']) w[name] = () => {}
  w.draw()
  assert.deepEqual(rendered, [home.id])
  w.drawMapPlots(w.visibleBounds())
  assert.equal(markers, 1)
  w.candidate.valid = false
  rendered.length = 0
  w.draw()
  assert.deepEqual(rendered, [home.id])
  w.isPlacingBuilding = false
  rendered.length = 0
  w.draw()
  assert.deepEqual(rendered, [])
})

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

test('overview and applySceneRecords prioritize residential villa over committee/yard', async () => {
  const page = { setData: () => {}, pushStatusMessage: () => {} }
  const homePlot = {
    id: 'plot_home',
    mine: true,
    buildingType: 'residential',
    x: 100,
    z: 100,
    size: 112,
    isNewPlot: false
  }
  const committeePlot = {
    id: 'plot_committee',
    mine: true,
    buildingType: 'committee',
    x: 400,
    z: 400,
    size: 48,
    isNewPlot: true
  }

  // World initially loaded with ownPlot pointing to committee due to old bug
  const w = new World2D(page, null, {
    world: { width: 800, height: 800 },
    plot: committeePlot,
    pets: []
  })
  w.ownPlot = committeePlot
  w.camera = { x: committeePlot.x, z: committeePlot.z }

  // 1. overview() must center on residential plot
  w.sharedPlots = new Map([
    [homePlot.id, homePlot],
    [committeePlot.id, committeePlot]
  ])
  w.overview()
  assert.equal(w.camera.x, homePlot.x)
  assert.equal(w.camera.z, homePlot.z)

  // 2. applySceneRecords must detect residential plot and auto-recenter camera & character
  w.camera = { x: committeePlot.x, z: committeePlot.z }
  w.character = { position: { x: committeePlot.x + 3, z: committeePlot.z + 14 } }
  w.characterMoved = false
  await w.applySceneRecords([
    { kind: 'plot', ...homePlot },
    { kind: 'plot', ...committeePlot }
  ])
  assert.equal(w.ownPlot.id, homePlot.id)
  assert.equal(w.camera.x, homePlot.x)
  assert.equal(w.camera.z, homePlot.z)
  assert.equal(w.character.position.x, homePlot.x + 3)
  assert.equal(w.character.position.z, homePlot.z + 14)
})

test('drawYard renders floor tiles at ground level and tree sprites with proper depth and custom images', () => {
  const page = { setData: () => {}, pushStatusMessage: () => {} }
  const drawCalls = []
  const ctx = {
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    clip() {},
    stroke() {},
    fill() {},
    rect() {},
    roundRect() {},
    fillText() {},
    strokeText() {},
    drawImage(...args) {
      drawCalls.push(args)
    }
  }
  const w = new World2D(page, null, {
    world: { width: 1000, height: 1000 },
    pets: []
  })
  w.ctx = ctx
  w.scale = 10
  w.zoom = 1
  w.project = (x, z) => ({ x: x * 2, y: z * 2 })
  w.sprite = (name, x, z, size, anchor) => {
    drawCalls.push([name, x, z, size, anchor])
  }

  // 1. 地板地坪素材绘制：如果有自定义图片，平铺绘制在地表层，不产生立面遮挡
  const floorPlot = {
    id: 'plot_floor',
    x: 200,
    z: 200,
    size: 48,
    buildingType: 'floor',
    buildingCategory: 'floor',
    buildingWidth: 7,
    buildingDepth: 7,
    buildingImage: 'cloud://test/deck.png'
  }
  w.buildingImage = (id) => (id === 'cloud://test/deck.png' ? { width: 100, height: 100 } : null)
  const items = []
  w.drawYard(floorPlot, items)
  // 地板地坪素材在地面层平铺绘制，不将立面房子放入 items 遮挡角色（items 中仅含外围栅栏段）
  const buildingInItems = items.find((it) => it.depth === floorPlot.x + floorPlot.z)
  assert.equal(buildingInItems, undefined)
  assert.ok(drawCalls.length > 0)

  // 2. 树木景观素材绘制：参与立体 items 排序
  const treePlot = {
    id: 'plot_tree',
    x: 300,
    z: 300,
    size: 48,
    buildingType: 'tree',
    buildingCategory: 'tree',
    buildingWidth: 7,
    buildingDepth: 7,
    buildingImage: 'cloud://test/cherry.png'
  }
  w.buildingImage = (id) => (id === 'cloud://test/cherry.png' ? { width: 120, height: 160 } : null)
  const treeItems = []
  w.drawYard(treePlot, treeItems)
  const treeInItems = treeItems.find((it) => it.depth === treePlot.x + treePlot.z)
  assert.ok(treeInItems, '树木应当参与 items 立体深度排序')
  assert.equal(treeInItems.depth, 600)
  treeInItems.draw()
  // 确认树木的 drawImage 被调用
  assert.ok(drawCalls.some((args) => args[0] && args[0].width === 120))
})

test('multiple building sprites render independently and nearby selection identifies the closest instance', async () => {
  const page = { data: {}, setData(v) { Object.assign(this.data, v) } }
  const w = new World2D(page, null, { world: { width: 1000, height: 1000 }, pets: [] })
  const draws = []
  w.ctx = new Proxy({}, { get(target, key) { return target[key] || (() => {}) } })
  w.scale = 10
  w.zoom = 1
  w.project = (x, z) => ({ x: x * 2, y: z * 2 })
  w.sprite = () => {}
  w.buildingImage = (image) => ({ width: 120, height: 160, image })
  w.ctx.drawImage = (image) => draws.push(image.image)
  const buildings = [
    { instanceId: 'tree_one', buildingId: 'tree_template', type: 'tree', category: 'tree', name: '第一棵树', image: 'tree_one.png', width: 7, depth: 7, x: 480, z: 480 },
    { instanceId: 'tree_two', buildingId: 'tree_template', type: 'tree', category: 'tree', name: '第二棵树', image: 'tree_two.png', width: 7, depth: 7, x: 520, z: 520 }
  ]
  const plot = { id: 'multi_tree_plot', x: 500, z: 500, size: 112, isNewPlot: true, mine: true, buildingType: 'tree', buildings }
  w.sharedPlots.set(plot.id, plot)
  const items = []
  w.drawYard(plot, items)
  assert.ok(items.some((i) => i.depth === 960))
  assert.ok(items.some((i) => i.depth === 1040))
  for (const item of items) item.draw()
  assert.ok(draws.includes('tree_one.png'))
  assert.ok(draws.includes('tree_two.png'))
  w.character = { position: { x: 521, z: 521 }, moving: false, direction: 'south' }
  w.characterTerrain = { cellX: 9, cellZ: 9 }
  w.characterAreaLoaded = () => true
  w.characterNavigation = () => ({ clearSegment: () => true })
  const nearby = w.nearbyInteractions().building
  assert.equal(nearby.buildingInstanceId, 'tree_two')
  assert.equal(nearby.name, '第二棵树')
  const hit = w.buildingAt({ x: 1040, y: 1030 })
  assert.equal(hit.buildingInstanceId, 'tree_two')
  w.selectBuilding(hit)
  assert.equal(page.data.selectedBuildingInfo.buildingInstanceId, 'tree_two')
  await w.applySceneChanges([{ ...plot, kind: 'plot', buildings: [buildings[0]], revision: 2 }])
  assert.equal(page.data.selectedBuildingInfo, null)
})

test('custom building keeps its name hidden until tapped and supports plots with only _id', () => {
  const page = { data: {}, setData(value) { Object.assign(this.data, value) }, pushStatusMessage: () => {} }
  const textCalls = []
  const ctx = {
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    clip() {},
    stroke() {},
    fill() {},
    rect() {},
    roundRect() {},
    fillText(text, x, y) {
      textCalls.push(text)
    },
    strokeText() {},
    drawImage() {}
  }
  const w = new World2D(page, null, {
    world: { width: 1000, height: 1000 },
    pets: []
  })
  w.ctx = ctx
  w.scale = 10
  w.zoom = 1
  w.project = (x, z) => ({ x: x * 2, y: z * 2 })
  w.sprite = () => {}

  // 1. 设置角色在靠近自定义景观装饰的位置
  w.character = {
    position: { x: 500, z: 500 },
    moving: false,
    direction: 'south'
  }
  w.characterTerrain = { cellX: Math.floor(500 / 56), cellZ: Math.floor(500 / 56) }
  w.characterAreaLoaded = () => true
  w.characterNavigation = () => ({ clearSegment: () => true })

  // 2. 地皮只有 _id（没有 .id 属性）
  const decorPlot = {
    _id: 'plot_custom_decor_123',
    x: 502,
    z: 502,
    size: 48,
    mine: true,
    isNewPlot: true,
    buildingType: 'decoration',
    buildingCategory: 'decoration',
    buildingName: '中式望江楼',
    buildingWidth: 10,
    buildingDepth: 10
  }
  w.sharedPlots.set(decorPlot._id, decorPlot)

  // 3. 测试 nearbyInteractions() 检查附近的建筑
  const nearbyResult = w.nearbyInteractions()
  assert.ok(nearbyResult.building)
  assert.equal(nearbyResult.building.plotId, 'plot_custom_decor_123')
  assert.equal(nearbyResult.building.name, '中式望江楼')
  assert.equal(nearbyResult.building.type, 'decoration')
  assert.equal(nearbyResult.building.canDismantle, true)

  // 4. 场景不常驻绘制名称，点击建筑后在信息卡展示名称。
  const items = []
  w.drawYard(decorPlot, items)
  const decorInItems = items.find((it) => it.depth === decorPlot.x + decorPlot.z)
  assert.ok(decorInItems)
  decorInItems.draw()
  assert.equal(textCalls.includes('中式望江楼'), false)
  assert.equal(page.data.selectedBuildingInfo, undefined)
  w.assets.house = {width:256,height:256}
  const hit = w.buildingAt({x:1004,y:950})
  assert.equal(hit.plotId, decorPlot._id)
  w.selectBuilding(hit)
  assert.equal(page.data.selectedBuildingInfo.name, '中式望江楼')
  w.clearBuildingSelection()
  assert.equal(page.data.selectedBuildingInfo, null)
})

test('nearbyInteractions selects closest plot and canEnterPlot respects custom decoration/floor/tree', () => {
  const page = { setData: () => {}, pushStatusMessage: () => {} }
  const w = new World2D(page, null, {
    world: { width: 1000, height: 1000 },
    pets: []
  })
  w.character = {
    position: { x: 500, z: 500 },
    moving: false,
    direction: 'south'
  }
  w.characterTerrain = { cellX: Math.floor(500 / 56), cellZ: Math.floor(500 / 56) }
  w.characterAreaLoaded = () => true
  w.characterNavigation = () => ({ clearSegment: () => true })

  // 两个相邻地皮：地皮 A 在 (526, 500)，地皮 B 在 (502, 500)
  // 角色在 (500, 500)，离地皮 B 仅 2 米，离地皮 A 有 26 米
  const plotFar = {
    _id: 'plot_far',
    x: 526,
    z: 500,
    size: 48,
    mine: true,
    isNewPlot: true,
    buildingType: 'tree',
    buildingName: '远处的樱花树'
  }
  const plotClose = {
    _id: 'plot_close',
    x: 502,
    z: 500,
    size: 48,
    mine: true,
    isNewPlot: true,
    buildingType: 'floor',
    buildingName: '脚下的古朴石板'
  }

  // 故意将远处的 plotFar 放在前面
  w.sharedPlots.set(plotFar._id, plotFar)
  w.sharedPlots.set(plotClose._id, plotClose)

  const result = w.nearbyInteractions()
  assert.ok(result.building)
  // 必须精确匹配距离最近的地皮（脚下的古朴石板），而不是误选远处的樱花树
  assert.equal(result.building.plotId, 'plot_close')
  assert.equal(result.building.name, '脚下的古朴石板')

  // 测试 canEnterPlot 对前缀和 category 的放行
  assert.equal(w.canEnterPlot({ buildingType: 'decoration_fountain' }), true)
  assert.equal(w.canEnterPlot({ buildingCategory: 'decoration' }), true)
  assert.equal(w.canEnterPlot({ buildingCategory: 'floor' }), true)
  assert.equal(w.canEnterPlot({ buildingType: 'floor_marble' }), true)
})

test('building placement allows free positioning with grass tile capacity validation and relocation', async () => {
  const pageData = {}
  const page = {
    data: pageData,
    setData: (patch) => Object.assign(pageData, patch),
    pushStatusMessage: () => {}
  }
  const w = new World2D(page, null, {
    world: { width: 1000, height: 1000 },
    pets: []
  })

  const ownPlot = {
    _id: 'plot_home',
    id: 'plot_home',
    x: 200,
    z: 200,
    size: 48,
    mine: true,
    isNewPlot: false,
    buildingType: 'residential',
    name: '我的自家庭院'
  }
  const greenPlot = {
    _id: 'plot_green_1',
    id: 'plot_green_1',
    x: 400,
    z: 400,
    size: 48,
    mine: true,
    isNewPlot: true,
    buildingType: 'yard',
    name: '专属爱心绿地'
  }

  w.ownPlot = ownPlot
  w.sharedPlots.set(ownPlot.id, ownPlot)
  w.sharedPlots.set(greenPlot.id, greenPlot)

  const publicBuilding = {
    id: 'b_comm',
    name: '居委会',
    type: 'committee',
    category: 'public',
    width: 8,
    depth: 8
  }
  const decorBuilding = {
    id: 'b_tree',
    name: '红枫树',
    type: 'tree',
    category: 'tree',
    width: 6,
    depth: 6
  }

  // 1. 公共配套设施不能建在出生庭院
  w.beginBuildingPlacement(publicBuilding, false)
  assert.equal(w.isPlacingBuilding, true)
  assert.equal(pageData.isPlacingBuilding, true)
  assert.equal(pageData.canConfirm, false)

  await w.pickPlot({ x: 200, z: 200 })
  assert.equal(w.candidate.valid, false)
  assert.match(w.candidate.reason, /专属绿地/)
  assert.equal(pageData.canConfirm, false)

  // 2. 公共配套设施在独立专属绿地内，选择合适位置（满足草坪方块空间容纳）：呈现绿色指示
  await w.pickPlot({ x: 400, z: 400 })
  assert.equal(w.candidate.valid, true)
  assert.equal(w.candidate.buildingX, 400)
  assert.equal(w.candidate.buildingZ, 400)
  assert.equal(pageData.canConfirm, true)

  // 3. 点击偏离中心但仍在草坪方块容纳范围内：非中心化放置成功
  await w.pickPlot({ x: 410, z: 412 })
  assert.equal(w.candidate.valid, true)
  assert.equal(w.candidate.buildingX, 410)
  assert.equal(w.candidate.buildingZ, 412)
  assert.equal(pageData.canConfirm, true)

  // 4. 点击超出草坪围栏边缘导致草坪方块空间不足：呈现红色指示，禁止确认
  // 绿地范围 [400 - 24, 400 + 24] = [376, 424]，建筑宽度 8，半宽 4，若点击 423 则 423 + 4 = 427 > 424
  await w.pickPlot({ x: 423, z: 400 })
  assert.equal(w.candidate.valid, false)
  assert.match(w.candidate.reason, /空间不足/)
  assert.equal(pageData.canConfirm, false)

  // 5. 点击非领地范围：呈现红色指示
  await w.pickPlot({ x: 700, z: 700 })
  assert.equal(w.candidate.valid, false)
  assert.match(w.candidate.reason, /领地范围/)
  assert.equal(pageData.canConfirm, false)

  // 6. 非公共配套建筑（景观树/木屋/地砖）：可以在自家庭院的空旷草坪建造
  w.beginBuildingPlacement(decorBuilding, false)
  // 点击自家庭院的空旷草坪角落 (216, 216)
  await w.pickPlot({ x: 216, z: 216 })
  assert.equal(w.candidate.valid, true)
  assert.equal(w.candidate.targetPlot.id, 'plot_home')
  assert.equal(pageData.canConfirm, true)

  // 若与自家庭院原生主屋中心 (200, 200) 重叠：呈现红色指示
  await w.pickPlot({ x: 200, z: 200 })
  assert.equal(w.candidate.valid, false)
  assert.match(w.candidate.reason, /重叠/)

  // 7. 测试位置调整（Relocation）：
  const existingDecorPlot = {
    _id: 'plot_tree_placed',
    id: 'plot_tree_placed',
    x: 400,
    z: 400,
    size: 48,
    mine: true,
    isNewPlot: true,
    buildingType: 'tree',
    buildingName: '红枫树',
    buildingWidth: 6,
    buildingDepth: 6,
    buildingX: 405,
    buildingZ: 405
  }
  w.sharedPlots.set(existingDecorPlot.id, existingDecorPlot)

  w.beginBuildingPlacement(decorBuilding, true, existingDecorPlot)
  assert.equal(w.candidate.isRelocating, true)
  assert.equal(w.candidate.x, 405)
  assert.equal(w.candidate.z, 405)
  assert.equal(w.candidate.valid, true)
  assert.equal(w.candidate.targetPlot.id, existingDecorPlot.id)

  existingDecorPlot.buildingX = 423
  await w.beginBuildingPlacement(decorBuilding, true, existingDecorPlot)
  assert.equal(w.candidate.valid, false)
  assert.match(w.candidate.reason, /空间不足/)
  assert.equal(pageData.canConfirm, false)

  const otherPlot = { ...greenPlot, id: 'plot_other', _id: 'plot_other', x: 600, z: 600 }
  w.sharedPlots.set(otherPlot.id, otherPlot)
  await w.pickPlot({ x: 600, z: 600 })
  assert.equal(w.candidate.targetPlot.id, existingDecorPlot.id)
  assert.equal(w.candidate.valid, false)
  assert.equal(pageData.canConfirm, false)

  // 移动到新草坪方块 (395, 398)
  await w.pickPlot({ x: 395, z: 398 })
  assert.equal(w.candidate.valid, true)
  assert.equal(w.candidate.x, 395)
  assert.equal(w.candidate.z, 398)
  assert.equal(w.candidate.targetPlot.id, existingDecorPlot.id)
  assert.equal(pageData.canConfirm, true)

  // 8. 验证 yardLayout 支持自定义 buildingX、buildingZ 偏移
  const { yardLayout } = require('../../miniprogram/packagePlayground/utils/yard-layout')
  const layout = yardLayout({
    x: 400,
    z: 400,
    size: 48,
    buildingX: 412,
    buildingZ: 388
  })
  const houseSprite = layout.sprites.find((s) => s.name === 'house')
  assert.ok(houseSprite)
  assert.equal(houseSprite.x, 412)
  assert.equal(houseSprite.z, 388)

  // 9. 验证偏离中心放置的地板（floor）可通过 buildingAt 精确命中点击
  w.cancelPlacement()
  const offsetFloorPlot = {
    _id: 'plot_offset_floor',
    id: 'plot_offset_floor',
    x: 400,
    z: 400,
    size: 48,
    mine: true,
    isNewPlot: true,
    buildingType: 'floor',
    buildingName: '偏心大理石',
    buildingWidth: 10,
    buildingDepth: 10,
    buildingX: 410,
    buildingZ: 390
  }
  w.sharedPlots.set(offsetFloorPlot.id, offsetFloorPlot)
  // 点击建筑实际坐标 (410, 390) 对应的屏幕投影点
  const screenPt = w.project(410, 390)
  const hitBuilding = w.buildingAt(screenPt)
  assert.ok(hitBuilding)
  assert.equal(hitBuilding.plotId, 'plot_offset_floor')
  assert.equal(hitBuilding.name, '偏心大理石')
})
