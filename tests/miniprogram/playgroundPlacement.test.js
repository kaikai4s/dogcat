const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

test('building relocation submits the selected instance and keeps the server multi-building state', async () => {
  let page
  const requests = []
  const tree = { id: 'tree_template', instanceId: 'selected_tree', type: 'tree', name: '选中的树', width: 7, depth: 7 }
  const original = { id: 'garden', x: 400, z: 400, isNewPlot: true, buildings: [
    { ...tree, buildingId: tree.id, x: 390, z: 390 },
    { ...tree, instanceId: 'other_tree', buildingId: tree.id, x: 410, z: 410 }
  ] }
  const response = { ...original, buildings: original.buildings.map((b) => b.instanceId === tree.instanceId ? { ...b, x: 390.25, z: 410.75 } : b) }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/packagePlayground/pages/world.js'), 'utf8'), {
    Page: (p) => { page = p },
    require: (name) => name.includes('utils/cloud') ? { callFunction: async (module, action, data) => {
      requests.push({ action, data })
      return { plot: response }
    } } : name.includes('plot-buildings') ? require('../../miniprogram/packagePlayground/utils/plot-buildings') : {},
    wx: { showModal(options) { if (options.success) options.success({ confirm: true }) }, showToast() {} },
    setTimeout, clearTimeout
  })
  page.setData = (patch) => Object.assign(page.data, patch)
  page.pushStatusMessage = () => {}
  page.pendingBuilding = tree
  page.data.isRelocatingBuilding = true
  let applied
  page.world = {
    candidate: { isBuilding: true, isRelocating: true, valid: true, building: tree, buildingInstanceId: tree.instanceId, targetPlot: original, x: 390.25, z: 410.75 },
    relocatingBuildingInstanceId: tree.instanceId,
    relocatingPlot: original,
    scene: { sceneId: 'scene' }, sharedPlots: new Map(),
    updatePlot(plot) { applied = plot }, cancelPlacement() {}
  }
  await page.confirmPlot()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].action, 'relocateBuilding')
  assert.equal(requests[0].data.plotId, original.id)
  assert.equal(requests[0].data.buildingInstanceId, tree.instanceId)
  assert.equal(requests[0].data.buildingX, 390.25)
  assert.equal(applied, response)
  assert.equal(applied.buildings.length, 2)
  assert.deepEqual(applied.buildings[1], original.buildings[1])
})

test('new construction retries reuse an intent id while another tree receives a new id', async () => {
  const { World2D } = require('../../miniprogram/packagePlayground/utils/world2d')
  const model = require('../../miniprogram/packagePlayground/utils/plot-buildings')
  let page
  let stored = { id: 'home_retry', x: 400, z: 400, size: 48, mine: true, isNewPlot: false, buildingType: 'residential', buildings: [] }
  const requests = []
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/packagePlayground/pages/world.js'), 'utf8'), {
    Page: (p) => { page = p },
    require: (name) => name.includes('utils/cloud') ? { callFunction: async (module, action, data) => {
      requests.push(data)
      if (requests.length === 1) throw new Error('测试建造重试')
      stored = model.withBuildings(stored, [...stored.buildings, {
        instanceId: data.buildingInstanceId, buildingId: data.buildingId, type: 'tree', category: 'tree', name: '树', width: 7, depth: 7, x: data.buildingX, z: data.buildingZ
      }])
      return { plot: stored }
    } } : name.includes('plot-buildings') ? model : {},
    wx: { showModal(options) { if (options.success) options.success({ confirm: true }) }, showToast() {} },
    setTimeout, clearTimeout
  })
  page.setData = (patch) => Object.assign(page.data, patch)
  page.pushStatusMessage = () => {}
  page.fetchRegion = async () => ({ plots: [] })
  page.data.hasPlot = true
  page.data.selectedBuilding = { id: 'tree_template', name: '树', type: 'tree', category: 'tree', width: 7, depth: 7, unlocked: true }
  const world = new World2D(page, null, { world: { width: 1000, height: 1000 }, pets: [] })
  world.ownPlot = stored
  world.sharedPlots.set(stored.id, stored)
  page.world = world
  await page.buildInYardAction()
  await world.pickPlot({ x: 416, z: 416 })
  await page.confirmPlot()
  assert.equal(world.candidate.valid, true)
  await page.confirmPlot()
  assert.ok(requests[0].buildingInstanceId)
  assert.equal(requests[0].buildingInstanceId, requests[1].buildingInstanceId)
  await page.buildInYardAction()
  await world.pickPlot({ x: 384, z: 384 })
  await page.confirmPlot()
  assert.notEqual(requests[2].buildingInstanceId, requests[1].buildingInstanceId)
  assert.equal(stored.buildings.length, 2)
  assert.equal(world.ownPlot.buildingType, 'residential')
})

test('building catalog loads owned plots before chunk loading and public construction can focus a remote garden', async () => {
  const { World2D } = require('../../miniprogram/packagePlayground/utils/world2d')
  const model = require('../../miniprogram/packagePlayground/utils/plot-buildings')
  const home = { id: 'home', x: 280, z: 280, size: 112, mine: true, buildingType: 'residential', buildings: [], revision: 10 }
  const garden = { id: 'remote_garden', x: 1400, z: 1400, size: 48, mine: true, isNewPlot: true, buildings: [], revision: 10 }
  const building = { id: 'clinic', type: 'pet_hospital', category: 'public', name: '医院', unlocked: true, width: 7, depth: 7 }
  let page, requested
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/packagePlayground/pages/world.js'), 'utf8'), {
    Page: (p) => { page = p },
    require: (name) => name.includes('utils/cloud') ? { callFunction: async (module, action, data) => {
      requested = data
      return { buildings: [building], buildablePlots: [home, garden], emptyPlots: [garden] }
    } } : name.includes('plot-buildings') ? model : {},
    wx: { showToast() {}, showModal() { assert.fail('available garden must not ask for a new plot') } }
  })
  page.setData = (patch) => Object.assign(page.data, patch)
  const world = new World2D(page, null, { world: { width: 2240, height: 2240 }, scene: { sceneId: 'scene' }, pets: [] })
  world.loadVisible = async () => {}
  page.world = world
  await page.openBuild()
  assert.equal(requested.sceneId, 'scene')
  assert.deepEqual(new Set(world.plots().map((p) => p.id)), new Set([home.id, garden.id]))
  assert.equal(page.getAvailableEmptyPlots().length, 1)
  await page.buildInYardAction()
  assert.equal(world.isPlacingBuilding, true)
  assert.deepEqual(world.camera, { x: garden.x, z: garden.z })
  assert.equal(world.isMapOverview(), false)
})

test('a delayed construction response cannot replace a newer live plot with fewer trees', async () => {
  const { World2D } = require('../../miniprogram/packagePlayground/utils/world2d')
  const model = require('../../miniprogram/packagePlayground/utils/plot-buildings')
  let page, world
  const tree = { instanceId: 'tree_one', buildingId: 'tree_template', type: 'tree', width: 7, depth: 7, x: 416, z: 416 }
  const old = { id: 'home_late', x: 400, z: 400, size: 48, mine: true, buildingType: 'residential', buildings: [tree], revision: 10 }
  const latest = { ...old, buildings: [tree, { ...tree, instanceId: 'tree_two', x: 384, z: 384 }], revision: 20 }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/packagePlayground/pages/world.js'), 'utf8'), {
    Page: (p) => { page = p },
    require: (name) => name.includes('utils/cloud') ? { callFunction: async () => {
      world.updatePlot(latest)
      return { plot: old }
    } } : name.includes('plot-buildings') ? model : {},
    wx: { showModal(options) { options.success({ confirm: true }) }, showToast() {} }
  })
  page.setData = (patch) => Object.assign(page.data, patch)
  page.pushStatusMessage = () => {}
  page.pendingBuilding = { id: tree.buildingId, type: 'tree', name: '树', buildingInstanceId: tree.instanceId }
  world = new World2D(page, null, { world: { width: 1000, height: 1000 }, pets: [], plot: { ...old, buildings: [], revision: 1 } })
  page.world = world
  world.candidate = { isBuilding: true, valid: true, x: tree.x, z: tree.z, targetPlot: world.ownPlot }
  await page.confirmPlot()
  assert.equal(world.ownPlot.buildings.length, 2)
  assert.equal(world.plots().find((p) => p.id === old.id).buildings.length, 2)
})

test('placement failure shows the complete cloud error and retains the existing yard', async () => {
  const modals = []
  let page
  const oldPlot = { id: 'old', x: 200, z: 200 }
  const source = fs.readFileSync(
    path.join(__dirname, '../../miniprogram/packagePlayground/pages/world.js'),
    'utf8'
  )
  vm.runInNewContext(source, {
    Page: (value) => {
      page = value
    },
    require: (name) =>
      name.includes('world2d')
        ? {}
        : {
            callFunction: async () => {
              const error = new Error(
                'document.set:fail resource system error; requestId: test-request'
              )
              error.code = -501001
              throw error
            }
          },
    wx: {
      showModal(options) {
        modals.push(options)
        if (options.success) options.success({ confirm: true })
      }
    }
  })
  page.setData = (value) => Object.assign(page.data, value)
  page.data.hasPlot = true
  page.data.canRelocate = true
  page.world = {
    ownPlot: oldPlot,
    candidate: { x: 400.25, z: 500.75, cellX: 7, cellZ: 8, size: 72 },
    chunks: new Map(),
    chunkKey: (x, z) => `${x},${z}`,
    setPlot() {
      assert.fail('failed save must not replace the old yard')
    }
  }
  await page.confirmPlot()
  assert.equal(modals.length, 2)
  assert.equal(modals[1].title, '庭院位置保存失败')
  assert.match(modals[1].content, /document.set:fail.*test-request/)
  assert.match(modals[1].content, /-501001/)
  assert.equal(modals[1].showCancel, false)
  assert.equal(page.world.ownPlot, oldPlot)
  assert.equal(page.data.claiming, false)
})
