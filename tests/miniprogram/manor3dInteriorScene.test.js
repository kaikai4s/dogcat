const test = require('node:test')
const assert = require('node:assert/strict')
const { THREE } = require('../../miniprogram/packageManor3d/vendor/three-runtime')
const { createManorScene } = require('../../miniprogram/packageManor3d/utils/manor-scene')

const layout = {
  world: { width: 1200, depth: 960 },
  groundLevel: 4.1,
  bridge: { x: 0, z: 66 },
  plots: [{ id: 'house', x: 54, y: 4.1, z: 88, width: 30, depth: 24 }]
}
const metadata = {
  model: 'manor-villa-interior.glb',
  anchors: {
    FrontDoor: { position: [2.7015, .406, 3.1112], yaw: 0 },
    InteriorSpawn: { position: [2.7015, .411, 1.9712], yaw: Math.PI }
  },
  frontDoorOpening: { enterDirection: [0, 0, -1] }
}

function villa() {
  return new THREE.Group().add(new THREE.Mesh(
    new THREE.BoxGeometry(18.63, 12.89, 10.85), new THREE.MeshBasicMaterial()))
}

function character() {
  const model = new THREE.Group()
  const body = new THREE.Mesh(new THREE.BoxGeometry(.55, 1.6, .4), new THREE.MeshBasicMaterial())
  body.name = 'Body'
  body.position.y = .8
  model.add(body)
  model.animations = ['Idle', 'Walk', 'Run'].map(name => new THREE.AnimationClip(name, 1,
    [new THREE.NumberKeyframeTrack('Body.rotation[x]', [0, 1], [0, 0])]))
  return model
}

function fixture() {
  const disposed = []
  let drawnScene, drawnCamera
  const view = createManorScene({
    THREE,
    disposeModel: model => disposed.push(model),
    renderer: {
      setSize() {},
      render(scene, camera) {
        drawnScene = scene
        drawnCamera = camera
        scene.updateMatrixWorld()
        camera.updateMatrixWorld()
      }
    }
  })
  view.resize(390, 700)
  return { view, disposed, player: () => drawnScene?.getObjectByName('Manor player'), camera: () => drawnCamera }
}

function mountInside(view, interior, data = metadata) {
  view.showLandscape(new THREE.Group(), layout)
  const exterior = villa()
  view.showVilla(exterior)
  view.showCharacter(character())
  view.setVillaInteriorMetadata(data)
  const { entry } = view.getVillaEntryState()
  assert.equal(view.placeCharacterAt({ x: entry.x, z: entry.z + 3.1 }, 0), true)
  assert.equal(view.enterInterior(interior, data), true)
  view.render(0)
  return exterior.parent.position
}

test('entering and leaving the villa toggles the exterior and interior models and disposes both', () => {
  const { view, disposed, player, camera } = fixture()
  view.showLandscape(new THREE.Group(), layout)
  const exterior = villa()
  view.showVilla(exterior)
  view.showCharacter(character())
  view.setVillaInteriorMetadata(metadata)
  const entry = view.getVillaEntryState().entry
  assert.equal(view.placeCharacterAt({ x: entry.x, z: entry.z + 3.1 }, 0), true)
  assert.equal(view.getVillaEntryState().nearDoor, true)
  view.orbit(43, 17)
  view.zoom(1.5)
  view.focusCharacter()
  view.render(0)
  const outdoorOffset = camera().position.clone().sub(player().position)
  const interior = new THREE.Group().add(new THREE.Mesh(
    new THREE.BoxGeometry(8, 4, 8), new THREE.MeshBasicMaterial()))

  assert.equal(view.getVillaEntryState().inside, false)
  assert.equal(view.getVillaEntryState().available, true)
  assert.equal(view.enterInterior(interior, metadata), true)
  assert.equal(view.isInsideVilla, true)
  assert.equal(exterior.visible, false)
  assert.equal(interior.visible, true)
  assert.equal(interior.parent, exterior.parent)
  view.orbit(-48, -34)
  view.zoom(1.3)

  assert.equal(view.exitInterior(), true)
  assert.equal(view.isInsideVilla, false)
  assert.equal(exterior.visible, true)
  assert.equal(interior.visible, false)
  view.render(0)
  assert.ok(camera().position.clone().sub(player().position).distanceTo(outdoorOffset) < 1e-8)

  view.dispose()
  assert.ok(disposed.includes(exterior))
  assert.ok(disposed.includes(interior))
})

test('replacing the villa while its interior is attached releases the interior model once', () => {
  const { view, disposed } = fixture()
  view.showLandscape(new THREE.Group(), layout)
  const exterior = villa()
  view.showVilla(exterior)
  view.showCharacter(character())
  view.setVillaInteriorMetadata(metadata)
  const entry = view.getVillaEntryState().entry
  assert.equal(view.placeCharacterAt({ x: entry.x, z: entry.z + 3.1 }, 0), true)
  const interior = new THREE.Group().add(new THREE.Mesh(
    new THREE.BoxGeometry(8, 4, 8), new THREE.MeshBasicMaterial()))
  view.enterInterior(interior, metadata)

  const replacement = villa()
  view.showVilla(replacement)
  assert.ok(disposed.includes(exterior))
  assert.ok(disposed.includes(interior))
  view.dispose()
  assert.equal(disposed.filter(model => model === replacement).length, 1)
})

test('the door trigger is reachable outside the villa and exit restores a walkable outdoor position', () => {
  const { view } = fixture()
  view.showLandscape(new THREE.Group(), layout)
  view.showVilla(villa())
  view.showCharacter(character())
  view.setVillaInteriorMetadata(metadata)
  const entry = view.getVillaEntryState()
  assert.equal(entry.available, true)
  assert.equal(entry.nearDoor, false)

  const outside = { x: entry.entry.x, z: entry.entry.z + 3.1 }
  assert.equal(view.placeCharacterAt(outside, Math.PI), true)
  assert.equal(view.getVillaEntryState().nearDoor, true)
  const interior = new THREE.Group().add(new THREE.Mesh(
    new THREE.BoxGeometry(8, 4, 8), new THREE.MeshBasicMaterial()))
  view.enterInterior(interior, metadata)
  assert.equal(view.isInsideVilla, true)
  assert.equal(view.exitInterior(), true)
  assert.equal(view.isInsideVilla, false)
  assert.ok(view.getPlayerSyncState().position3d.z > entry.entry.z)
  view.dispose()
})

test('entering a revised interior uses its GLB navigation data for the player height and collisions', () => {
  const { view, player } = fixture()
  view.showLandscape(new THREE.Group(), layout)
  const exterior = villa()
  view.showVilla(exterior)
  view.showCharacter(character())
  view.setVillaInteriorMetadata(metadata)
  const entry = view.getVillaEntryState().entry
  assert.equal(view.placeCharacterAt({ x: entry.x, z: entry.z + 3.1 }, 0), true)
  const interior = new THREE.Group()
  const root = new THREE.Group()
  root.name = 'VillaInterior'
  root.userData.navigation = {
    offset: { x: 2.70, y: .2, z: 1.97 },
    floors: [{ minX: -2, maxX: 2, minZ: -2, maxZ: 2, y: .48, level: 1 }],
    ramps: [],
    obstacles: [{ minX: .7, maxX: 1, minZ: -1.2, maxZ: 1.2, level: 1 }]
  }
  interior.add(root)
  assert.equal(view.enterInterior(interior, metadata), true)
  view.render(0, 0)
  const start = player().position.clone()
  assert.ok(Math.abs(start.y - exterior.parent.position.y - .68) < 1e-6)
  view.setPlayerInput(1, 0)
  for (let i = 1; i <= 8; i++) view.render(i / 10, .1)
  const distance = player().position.x - start.x
  assert.ok(distance > .1 && distance < .4)
  view.dispose()
})

test('the villa elevator opens the correct doors, carries the avatar both ways and restores walking', async () => {
  const { ELEVATOR, VILLA_LAYOUT } = await import('../../tools/manor_villa_interior/villa-layout.js')
  const asset = new THREE.Group(), root = new THREE.Group(), platform = new THREE.Group()
  const lowerDoor = new THREE.Group(), upperDoor = new THREE.Group(), cabinDoor = new THREE.Group()
  root.name = 'VillaInterior'
  platform.name = ELEVATOR.platformNode
  platform.position.y = ELEVATOR.landings[0].y
  lowerDoor.name = 'LowerLandingDoor'
  upperDoor.name = 'UpperLandingDoor'
  cabinDoor.name = 'CabinDoor'
  const offset = { x: 1.4215, y: .00595, z: -.4488 }
  root.userData.navigation = { ...VILLA_LAYOUT, offset, elevator: { ...ELEVATOR, doorNodes: [
    { name: lowerDoor.name, floor: 1, dx: -.55, dz: 0 },
    { name: upperDoor.name, floor: 2, dx: -.55, dz: 0 },
    { name: cabinDoor.name, dx: -.55, dz: 0 }
  ] } }
  platform.add(cabinDoor)
  const ceiling = new THREE.Group()
  ceiling.userData.floorSurfaceLevel = 2
  const { minX, maxX, minZ, maxZ } = ELEVATOR.bounds
  const floorSlabs = [[-7, minX, -4, 4], [maxX, 3, -4, 4], [minX, maxX, -4, minZ], [minX, maxX, maxZ, 4]]
  for (const [left, right, back, front] of floorSlabs) {
    const floor = new THREE.Mesh(new THREE.BoxGeometry(right - left, .24, front - back), new THREE.MeshBasicMaterial())
    floor.position.set((left + right) / 2 + offset.x, ELEVATOR.landings[1].y + offset.y - .12, (front + back) / 2 + offset.z)
    ceiling.add(floor)
  }
  root.add(platform, lowerDoor, upperDoor, ceiling)
  asset.add(root)
  const freshAsset = asset.clone()

  const { view, player, camera } = fixture()
  const origin = mountInside(view, asset)
  assert.equal(view.useElevator(), false)
  const [lower, upper] = ELEVATOR.landings.map(({ x, y, z }) => new THREE.Vector3(
    x + offset.x + origin.x, y + offset.y + origin.y, z + offset.z + origin.z))
  const actor = player()
  const ray = new THREE.Raycaster()
  function assertRiderInView() {
    for (const height of [.08, 1.5]) {
      const point = actor.position.clone().add(new THREE.Vector3(0, height, 0))
      const screen = point.clone().project(camera())
      assert.ok(Math.abs(screen.x) < 1 && Math.abs(screen.y) < 1, 'The upper floor should not push the rider off screen')
      ray.set(camera().position, point.clone().sub(camera().position).normalize())
      ray.far = camera().position.distanceTo(point)
      assert.equal(ray.intersectObject(ceiling, true).length, 0, 'The upper floor should not occlude the rider')
    }
  }
  actor.position.copy(lower).add(new THREE.Vector3(0, 0, .7))
  assert.deepEqual(view.getElevatorState(), { phase: 'ready', targetFloor: 2, busy: false })
  let time = 0
  const tick = () => view.render(time += .05, .05)
  function takeTrip(destination, targetFloor, withCall = false) {
    assert.equal(view.useElevator(), true)
    assert.equal(view.useElevator(), false)
    assert.equal(view.exitInterior(), false)
    const opened = new Set(), phases = new Set()
    const before = actor.position.clone()
    const startDoor = targetFloor === 2 ? lowerDoor : upperDoor
    const endDoor = targetFloor === 2 ? upperDoor : lowerDoor
    const arrivalHeights = new Set()
    for (let frame = 0; frame < 200 && view.getElevatorState()?.busy; frame++) {
      const phase = view.getElevatorState().phase
      view.setPlayerInput(1, -1)
      tick()
      phases.add(phase)
      if (startDoor.position.x < -.54 && cabinDoor.position.x < -.54) opened.add('boarding')
      if (endDoor.position.x < -.54 && cabinDoor.position.x < -.54) opened.add('leaving')
      if (view.getElevatorState()?.phase === 'riding') {
        assert.ok(Math.abs(actor.position.y - platform.position.y - origin.y - offset.y) < 1e-8)
        assert.equal(lowerDoor.position.x, 0)
        assert.equal(upperDoor.position.x, 0)
        assert.equal(cabinDoor.position.x, 0)
        arrivalHeights.add(actor.position.y)
        const checkpoint = view.getPlayerCheckpoint()
        assert.equal(checkpoint.interior.kind, 'red')
        assert.ok([lower, upper].some(point => Math.abs(checkpoint.y - point.y) < 1e-8),
          'A save in the moving cabin must resolve to a landing')
        assertRiderInView()
      }
      if (view.getElevatorState()?.phase === 'calling') assert.equal(actor.position.y, before.y)
    }
    assert.ok(phases.has('riding') && phases.has('leaving'))
    assert.equal(phases.has('calling'), withCall)
    assert.ok(arrivalHeights.size > 4, 'The cabin travels over several frames')
    assert.deepEqual([...opened], ['boarding', 'leaving'])
    assert.ok(actor.position.distanceTo(destination) < 1e-8)
    assert.equal(view.getElevatorState()?.busy, false)
    assert.deepEqual([lowerDoor.position.x, upperDoor.position.x, cabinDoor.position.x], [0, 0, 0])
  }

  takeTrip(upper, 2)
  tick()
  assert.ok(actor.position.distanceTo(upper) < 1e-8, 'No stale input after the trip')
  view.setPlayerInput(1, 0)
  tick()
  assert.ok(actor.position.distanceTo(upper) > .05, 'The joystick works after getting out')
  takeTrip(lower, 1)
  takeTrip(upper, 2)

  assert.equal(view.exitInterior(), true)
  assert.equal(view.enterInterior(asset, metadata), true)
  actor.position.copy(lower)
  assert.deepEqual(view.getElevatorState(), { phase: 'call', targetFloor: 2, busy: false })
  takeTrip(upper, 2, true)
  const checkpoint = view.getPlayerCheckpoint()
  assert.equal(checkpoint.y, upper.y)
  view.dispose()

  const resumed = fixture()
  resumed.view.showLandscape(new THREE.Group(), layout)
  resumed.view.showVilla(villa())
  resumed.view.showCharacter(character())
  resumed.view.setVillaInteriorMetadata(metadata)
  assert.equal(resumed.view.getVillaEntryState().nearDoor, false)
  assert.equal(resumed.view.enterInterior(freshAsset, metadata, checkpoint), true)
  resumed.view.render(0)
  assert.ok(resumed.player().position.distanceTo(upper) < 1e-8)
  assert.equal(resumed.view.getPlayerCheckpoint().facing, checkpoint.facing)
  resumed.view.dispose()
})

test('the interior follow camera stays in front of walls and below the next floor', () => {
  const asset = new THREE.Group(), wall = new THREE.Group(), floor = new THREE.Group()
  wall.userData.facadeIndex = 1
  floor.userData.floorSurfaceLevel = 2
  const [spawnX, , spawnZ] = metadata.anchors.InteriorSpawn.position
  wall.position.set(spawnX + 1.12, 1.7, spawnZ)
  wall.add(new THREE.Mesh(new THREE.BoxGeometry(.14, 3.2, 5), new THREE.MeshBasicMaterial()))
  floor.position.set(spawnX, 3.3, spawnZ)
  floor.add(new THREE.Mesh(new THREE.BoxGeometry(8, .26, 8), new THREE.MeshBasicMaterial()))
  asset.add(wall, floor)

  const { view, player, camera } = fixture()
  const origin = mountInside(view, asset)
  assert.ok(camera().position.x < origin.x + wall.position.x - .1)
  assert.ok(camera().position.x > player().position.x + .65)
  view.orbit(0, 260)
  view.render(.1, .1)
  assert.ok(camera().position.y < origin.y + floor.position.y - .15)
  assert.ok(camera().position.y > player().position.y + 1.9)
  view.dispose()
})
