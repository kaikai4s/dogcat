const test = require('node:test')
const assert = require('node:assert/strict')
const {
  World2D,
  yardObstacles
} = require('../../miniprogram/packagePlayground/utils/world2d')
const {
  yardLayout
} = require('../../miniprogram/packagePlayground/utils/yard-layout')
const {
  createNavigation
} = require('../../miniprogram/packagePlayground/utils/navigation')

function create(plots = []) {
  const mine = { id: 'mine', x: 300, z: 300, size: 112, mine: true }
  const page = {
    setData() {},
    fetchRegion: async (x, z) => ({
      plots: plots.filter(
        (p) => Math.floor(p.x / 112) === x && Math.floor(p.z / 112) === z
      )
    })
  }
  const w = new World2D(page, () => {}, {
    world: { width: 1120, height: 1120 },
    plot: mine,
    pets: [
      { _id: 'dog', name: '豆豆', species: 'dog' },
      { _id: 'cat', name: '团团', species: 'cat' }
    ]
  })
  let seed = 123
  w.random = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296
  w.buildWorld()
  w.selectPet('dog')
  return w
}
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('manual arrival rests for three seconds before roaming without moving the camera', async () => {
  const w = create()
  const pet = w.selectedPet()
  w.pets = [pet]
  const camera = { ...w.camera }
  const target = { x: 290, z: 320 }
  await w.moveTo(target)
  for (let i = 0; pet.moving && i < 300; i++) w.update(0.1)
  assert.deepEqual(pet.position, target)
  w.update(2.99)
  await settle()
  assert.equal(pet.mode, 'manual')
  assert.equal(pet.moving, false)
  w.update(0.02)
  await settle()
  assert.equal(pet.mode, 'roaming')
  assert.equal(pet.moving, true)
  assert.equal(pet.destination, null)
  w.update(0.5)
  assert.notDeepEqual(pet.position, target)
  assert.deepEqual(w.camera, camera)
  w.destroy()
})

test('automatic walking stays in its yard, including when starting at the open gate', async () => {
  const w = create()
  const pet = w.selectedPet()
  w.pets = [pet]
  pet.position = { x: 300, z: 355.9 }
  for (let trip = 0; trip < 20; trip++) {
    await w.planRoam(pet)
    assert.ok(pet.route.length > 0, 'a safe indoor route should be available')
    assert.equal(pet.roamPlotId, 'mine')
    for (const p of pet.route) {
      assert.ok(Math.abs(p.x - 300) <= 56 && Math.abs(p.z - 300) <= 56)
    }
    for (let i = 0; pet.moving && i < 400; i++) {
      w.update(0.1)
      assert.ok(
        Math.abs(pet.position.x - 300) <= 56 &&
          Math.abs(pet.position.z - 300) <= 56
      )
    }
  }
  w.destroy()
})

test('outdoor roaming cannot enter its own or neighboring yards through a gate', async () => {
  const neighbor = { id: 'neighbor', x: 420, z: 300, size: 112 }
  const w = create([neighbor])
  const pet = w.selectedPet()
  w.pets = [pet]
  pet.position = { x: 300, z: 356.1 }
  for (let trip = 0; trip < 25; trip++) {
    await w.planRoam(pet)
    assert.ok(pet.route.length > 0)
    assert.equal(pet.roamPlotId, null)
    for (let i = 0; pet.moving && i < 400; i++) {
      w.update(0.1)
      for (const plot of [w.ownPlot, neighbor]) {
        assert.ok(
          Math.abs(pet.position.x - plot.x) > 56 ||
            Math.abs(pet.position.z - plot.z) > 56
        )
      }
      assert.ok(
        pet.position.x >= 1 &&
          pet.position.z >= 1 &&
          pet.position.x <= 1119 &&
          pet.position.z <= 1119
      )
    }
  }
  w.destroy()
})

test('a manual command overrides a pending roaming plan and may cross the gate', async () => {
  const w = create()
  const pet = w.selectedPet()
  w.pets = [pet]
  pet.position = { x: 300, z: 350 }
  let release
  const load = w.loadNavigationArea.bind(w)
  w.loadNavigationArea = (bounds) =>
    new Promise((resolve) => {
      release = () => load(bounds).then(resolve)
    })
  const pending = w.planRoam(pet)
  w.loadNavigationArea = load
  const target = { x: 300, z: 365 }
  await w.moveTo(target)
  release()
  await pending
  assert.equal(pet.mode, 'manual')
  assert.deepEqual(pet.destination, target)
  for (let i = 0; pet.moving && i < 200; i++) w.update(0.1)
  assert.deepEqual(pet.position, target)
  assert.equal(pet.planning, false)
  w.destroy()
})

test('relocation invalidates an old roaming response and resets pets', async () => {
  const w = create()
  const pet = w.selectedPet()
  let release
  w.loadNavigationArea = () =>
    new Promise((resolve) => {
      release = resolve
    })
  const pending = w.planRoam(pet)
  const newPlot = { id: 'new', x: 600, z: 600, size: 112, mine: true }
  w.setPlot(newPlot)
  const start = { ...pet.position }
  release()
  await pending
  assert.deepEqual(pet.position, start)
  assert.equal(pet.mode, 'idle')
  assert.equal(pet.route.length, 0)
  assert.equal(pet.planning, false)
  w.destroy()
})

test('yard props and species stations fit old and expanded yards without obstructing the gate', () => {
  for (const size of [48, 72, 112]) {
    const plot = { id: 'mine', x: 300, z: 300, size }
    const layout = yardLayout(plot)
    const nav = createNavigation(
      { minX: 200, maxX: 400, minZ: 200, maxZ: 400 },
      yardObstacles(plot),
      0.8,
      1.5
    )
    for (const item of layout.sprites) {
      assert.ok(Math.abs(item.x - plot.x) + item.radius < size / 2)
      assert.ok(Math.abs(item.z - plot.z) + item.radius < size / 2)
    }
    for (const species of ['dog', 'cat']) {
      for (const station of Object.values(layout.stations[species]))
        assert.equal(nav.walkable(station), true)
    }
    assert.ok(
      nav.clearSegment(
        { x: 300, z: 300 + size / 2 - 4 },
        { x: 300, z: 300 + size / 2 + 4 }
      )
    )
  }
})

test('all visible pets have legible names even with no selection and close positions', () => {
  const w = create()
  w.selectedPetId = ''
  w.pets[1].position = { ...w.pets[0].position }
  const labels = []
  w.ctx = {
    save() {},
    restore() {},
    measureText: (name) => ({ width: name.length * 12 })
  }
  w.markerLabel = (name, x, y) => labels.push({ name, x, y })
  w.line = () => {}
  w.drawPetNames()
  assert.deepEqual(
    labels.map((p) => p.name),
    ['豆豆', '团团']
  )
  assert.ok(Math.abs(labels[0].y - labels[1].y) >= 24)
  w.destroy()
})

test('home view retains expanded yard detail at phone size instead of switching to map markers', () => {
  const w = create()
  w.resize(390, 844)
  assert.equal(w.isMapOverview(), false)
  const h = w.ownPlot.size / 2
  for (const [x, z] of [
    [300 - h, 300 - h],
    [300 + h, 300 - h],
    [300 + h, 300 + h],
    [300 - h, 300 + h]
  ]) {
    const point = w.project(x, z)
    assert.ok(point.x >= 18 && point.x <= 372)
    assert.ok(
      point.y > w.screenCenter().top && point.y < w.screenCenter().bottom
    )
  }
  w.destroy()
})

test('all eight pets spawn clear of props and fences in legacy and expanded yards', () => {
  for (const size of [48, 72, 112]) {
    const w = create()
    w.ownPlot.size = size
    w.overviewData.pets = Array.from({ length: 8 }, (_, i) => ({
      _id: String(i),
      name: '宠物' + i,
      species: 'dog'
    }))
    w.buildWorld()
    const nav = createNavigation(w.bounds, yardObstacles(w.ownPlot), 0.8, 1.5)
    for (const pet of w.pets) {
      assert.equal(
        nav.walkable(pet.position),
        true,
        `pet ${pet.id} is blocked in a ${size}m yard`
      )
      assert.ok(Math.abs(pet.position.z - w.ownPlot.z) < size / 2)
    }
    w.destroy()
  }
})
