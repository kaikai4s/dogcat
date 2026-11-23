const test = require('node:test')
const assert = require('node:assert/strict')
const { THREE } = require('../../miniprogram/packageManor3d/vendor/three-runtime')
const { createManorScene } = require('../../miniprogram/packageManor3d/utils/manor-scene')
const { createAnimatedCharacter } = require('../fixtures/manor3dCharacter')

const layout = {
  world: { width: 1200, depth: 960 },
  groundLevel: 4.1,
  bridge: { x: 0, z: 66 },
  plots: [
    { id: 'tiny', x: 4, y: 4.1, z: 70, width: 5, depth: 5 },
    { id: 'house', x: 54, y: 4.1, z: 88, width: 30, depth: 24 },
    { id: 'neighbor', x: 85, y: 4.1, z: 88, width: 30, depth: 24 }
  ]
}

function createFixture() {
  const frames = [], resized = [], disposed = []
  const view = createManorScene({ THREE, disposeModel: model => disposed.push(model), renderer: {
    setSize: (...args) => resized.push(args),
    render(scene, camera) {
      scene.updateMatrixWorld()
      camera.updateMatrixWorld()
      frames.push(camera.clone())
    }
  } })
  view.resize(390, 700)
  return { view, frames, resized, disposed }
}

function makeGrass(plot) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial())
  mesh.userData = { grass: true, detail: 'cluster', grassPlotId: plot.id }
  mesh.position.set(plot.x, plot.y, plot.z)
  return mesh
}

function makeVilla() {
  return new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(18.63, 12.89, 10.85), new THREE.MeshBasicMaterial()))
}

function makeCharacter() {
  const body = new THREE.Mesh(new THREE.BoxGeometry(.55, 1.6, .4), new THREE.MeshBasicMaterial())
  body.name = 'Body'
  body.position.y = .8
  const model = new THREE.Group().add(body)
  model.animations = [['Idle', .01], ['Walk', .3], ['Run', .7]].map(([name, angle]) =>
    new THREE.AnimationClip(name, 2, [new THREE.NumberKeyframeTrack('Body.rotation[x]', [0, 2], [angle, angle])]))
  return { model, body }
}

function makeCar() {
  const model = new THREE.Group()
  for (const name of ['Door_L', 'Door_R', 'Spin_FL', 'Spin_FR', 'Spin_RL', 'Spin_RR',
    'Steer_FL', 'Steer_FR', 'Steering_Wheel']) {
    const node = new THREE.Group()
    node.name = name
    model.add(node)
  }
  return model
}

test('running advances the avatar and camera faster, and replacing it leaves only one model at the same position', () => {
  const { view, frames, disposed } = createFixture()
  view.showLandscape(new THREE.Group(), layout)
  const boy = makeCharacter(), girl = makeCharacter()
  view.showCharacter(boy.model)
  view.render(0)
  const anchor = boy.model.parent
  const spawn = anchor.position.clone()
  const cameraStart = frames.at(-1).position.clone()
  const render = time => {
    for (let i = 1; i <= 30; i++) view.render(time + i / 30, 1 / 30)
  }
  view.setPlayerInput(0, .5)
  render(0)
  const walked = anchor.position.clone()
  assert.ok(walked.distanceTo(spawn) > 1)
  assert.ok(Math.abs(boy.body.rotation.x - .3) < 1e-6)
  assert.ok(frames.at(-1).position.distanceTo(cameraStart) > .8 * walked.distanceTo(spawn))

  view.setPlayerInput(0, 1)
  render(1)
  const ran = anchor.position.clone()
  assert.ok(ran.distanceTo(walked) > 2 * walked.distanceTo(spawn))
  assert.ok(Math.abs(boy.body.rotation.x - .7) < 1e-6)
  view.setPlayerInput(0, 0)
  render(2)
  assert.ok(ran.equals(anchor.position))
  assert.ok(Math.abs(boy.body.rotation.x - .01) < 1e-6)

  view.showCharacter(girl.model)
  assert.equal(boy.model.parent, null)
  assert.equal(girl.model.parent, anchor)
  assert.ok(ran.equals(anchor.position))
  assert.deepEqual(disposed, [boy.model])
  view.dispose()
  assert.equal(girl.model.parent, null)
  assert.ok(disposed.includes(girl.model))
})

test('jumping preserves movement input and allows steering and stopping in the air', () => {
  const { view } = createFixture()
  view.showLandscape(new THREE.Group(), layout)
  const { model, hips } = createAnimatedCharacter(THREE)
  model.animations.push(new THREE.AnimationClip('Jump', 1, [
    new THREE.VectorKeyframeTrack('Hips.position', [0, .5, 1], [0, .8, 0, 0, 1.12, 0, 0, .8, 0])
  ]))
  view.showCharacter(model)
  view.render(0)
  const anchor = model.parent
  const start = anchor.position.clone()
  view.setPlayerInput(0, .5)
  assert.equal(view.jumpPlayer(), true)
  for (let i = 1; i <= 6; i++) view.render(i / 30, 1 / 30)
  const forward = anchor.position.clone()
  assert.ok(forward.distanceTo(start) > .2)
  assert.ok(hips.position.y > .8)
  assert.equal(view.canJumpPlayer(), false)

  view.setPlayerInput(1, 0)
  for (let i = 7; i <= 12; i++) view.render(i / 30, 1 / 30)
  const turned = anchor.position.clone()
  const firstDirection = forward.clone().sub(start)
  const secondDirection = turned.clone().sub(forward)
  assert.ok(secondDirection.length() > firstDirection.length())
  assert.ok(Math.abs(firstDirection.dot(secondDirection)) < .01)

  view.setPlayerInput(0, 0)
  for (let i = 13; i <= 18; i++) view.render(i / 30, 1 / 30)
  assert.ok(anchor.position.distanceTo(turned) < 1e-6)
  for (let i = 19; i <= 31; i++) view.render(i / 30, 1 / 30)
  assert.equal(view.canJumpPlayer(), true)
  view.dispose()
})

test('villa uses the closest fitting plot and only suppresses grass on that plot while its neighbors remain visible', () => {
  const { view, resized } = createFixture()
  const [tiny, home, neighbor] = layout.plots.map(makeGrass)
  view.showLandscape(new THREE.Group().add(tiny, home, neighbor), layout)
  view.render(0)
  assert.ok(tiny.visible && home.visible && neighbor.visible)
  const villa = makeVilla()
  assert.equal(view.showVilla(villa).id, 'house')
  view.render(1)
  assert.ok(tiny.visible && !home.visible && neighbor.visible)
  const bounds = new THREE.Box3().setFromObject(villa)
  const center = bounds.getCenter(new THREE.Vector3())
  assert.ok(Math.abs(bounds.min.y - layout.groundLevel) < 0.03)
  assert.ok(Math.abs(center.x - 54) < 0.01 && Math.abs(center.z - 88) < 0.01)
  assert.deepEqual(resized, [[390, 700, false]])
  view.dispose()
})

test('shared 2D plots keep trees without rendering lot lines, paving or substitute houses', () => {
  const { view } = createFixture()
  const water = new THREE.Mesh(new THREE.PlaneGeometry(18, 12).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial())
  water.name = 'Winding clear stream'
  const landscape = new THREE.Group().add(water)
  view.showLandscape(landscape, layout)
  const villa = makeVilla()
  view.showVilla(villa)
  const x = 1260, z = 1320
  view.setSharedRecords([
    { kind: 'plot', id: 'empty', x, z, size: 48, buildingType: 'residential', buildings: [] },
    { kind: 'plot', id: 'legacy', x: 1350, z, size: 48, buildingType: 'residential' },
    { kind: 'plot', id: 'furnished', x: 1440, z, size: 48, buildings: [
      { instanceId: 'cabin', type: 'wood_cabin', x: 1440, z },
      { instanceId: 'tree', category: 'tree', x: 1449, z },
      { instanceId: 'private', type: 'floor_stone_tile', x: 1431, z }
    ] },
    { kind: 'plot', id: 'mine', x: 1530, z, size: 48, mine: true, buildings: [
      { instanceId: 'paved', category: 'floor', x: 1530, z }
    ] },
    { kind: 'plot', id: 'over-stream', x: 1120, z: 1120, size: 48, buildings: [
      { instanceId: 'stream-tree', category: 'tree', x: 1120, z: 1120 }
    ] }
  ], 'viewer')
  const scene = landscape.parent
  assert.equal(scene.getObjectByName('Shared plot empty'), undefined)
  assert.equal(scene.getObjectByName('Shared plot legacy'), undefined)
  assert.equal(scene.getObjectByName('Shared plot mine'), undefined)
  assert.deepEqual(scene.getObjectByName('Shared plot furnished').children.map(node => node.name),
    ['Shared plot detail tree'])
  assert.equal(scene.getObjectByName('Shared plot over-stream'), undefined)
  assert.equal(villa.parent.parent, scene)
  view.dispose()
})

test('shared Copper GT records render nearby peer cars and never create a second owned display car', () => {
  const { view } = createFixture()
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 4), new THREE.MeshBasicMaterial())
  const model = new THREE.Group().add(mesh)
  const landscape = new THREE.Group()
  view.showLandscape(landscape, layout)
  view.setVehicleModel(model)
  const peer = { id: 'peer-car', kind: 'manor3dVehicle', ownerId: 'neighbor',
    position3d: { x: 28, y: 4.1, z: 80 }, yaw: .7 }
  const own = { ...peer, id: 'own-car', ownerId: 'viewer', position3d: { x: 40, y: 4.1, z: 80 } }
  view.setSharedRecords([peer, own], 'viewer')
  const sceneRoot = landscape.parent
  assert.equal(view.getVehicleSyncState(), null)
  assert.ok(model.parent === null)
  view.render(.1, .05)
  const rendered = sceneRoot.getObjectByName('Shared Copper GT peer-car')
  assert.ok(rendered)
  assert.equal(sceneRoot.getObjectByName('Shared Copper GT own-car'), undefined)
  const x = rendered.position.x
  const updated = { ...peer, position3d: { x: 32, y: 4.1, z: 80 }, yaw: 1.1 }
  view.setSharedRecords([updated], 'viewer', { replace: false })
  view.render(.15, .05)
  assert.ok(rendered.position.x > x && rendered.position.x < 32)
  view.setSharedRecords([{ id: 'peer-car', deleted: true }], 'viewer', { replace: false })
  assert.equal(rendered.parent, null)
  view.dispose()
})

test('an owner vehicle record waits for the character when the car asset loads first', () => {
  const { view } = createFixture()
  view.showLandscape(new THREE.Group(), layout)
  const saved = { position3d: { x: 24, y: 4.1, z: 120 }, yaw: .4 }
  assert.equal(view.setVehicleModel(makeCar(), saved), true)
  assert.equal(view.getVehicleSyncState(), null)

  view.showCharacter(makeCharacter().model)

  const restored = view.getVehicleSyncState()
  assert.ok(restored)
  assert.equal(restored.position3d.x, saved.position3d.x)
  assert.equal(restored.position3d.z, saved.position3d.z)
  assert.equal(restored.yaw, saved.yaw)
  view.dispose()
})

test('live presence deltas interpolate existing avatars and preserve unchanged scene nodes', () => {
  const { view } = createFixture()
  const landscape = new THREE.Group()
  view.showLandscape(landscape, layout)
  view.showCharacter(makeCharacter().model)
  view.render(0)
  const scene = landscape.parent
  const { x, y, z } = view.getPlayerSyncState().position3d
  const nearby = { id: 'near', kind: 'presence', manor3dOnline: true, position3d: { x: x + 2, y, z }, manor3dFacing: 3 }
  const other = { ...nearby, id: 'other', position3d: { x: x + 1, y, z: z + 2 } }
  const distant = { ...nearby, id: 'far', position3d: { x: x + 350, y, z } }
  const plot = { id: 'garden', kind: 'plot', buildings: [{ instanceId: 'tree', category: 'tree', x: 1120, z: 1120 }] }
  view.setSharedRecords([nearby, other, distant, plot], 'own')
  const character = scene.getObjectByName('Shared character near')
  const unchanged = scene.getObjectByName('Shared character other')
  const decoration = scene.getObjectByName('Shared plot garden')
  assert.ok(character && unchanged && decoration)
  assert.equal(character.children[0].geometry, unchanged.children[0].geometry)
  assert.equal(scene.getObjectByName('Shared character far'), undefined)

  const delta = { replace: false }
  const destination = { x: x + 5, y: y + 2, z }
  view.setSharedRecords([{ ...nearby, position3d: destination, manor3dFacing: -3 }], 'own', delta)
  assert.equal(character.position.x, x + 2)
  view.render(.05, .05)
  assert.ok(character.position.x > x + 2 && character.position.x < x + 5)
  assert.ok(character.position.y > y && character.position.y < y + 2)
  assert.ok(character.rotation.y > 3)
  for (let step = 2; step <= 30; step++) view.render(step * .05, .05)
  assert.deepEqual(character.position.toArray(), [destination.x, destination.y, destination.z])
  assert.equal(scene.getObjectByName('Shared character near'), character)
  assert.equal(scene.getObjectByName('Shared character other'), unchanged)
  assert.equal(scene.getObjectByName('Shared plot garden'), decoration)

  view.setSharedRecords([{ id: 'near', deleted: true }], 'own', delta)
  assert.equal(character.parent, null)
  assert.equal(scene.getObjectByName('Shared character other'), unchanged)
  assert.ok(view.placeCharacterAt(distant.position3d))
  view.focusCharacter()
  for (let step = 31; step <= 37; step++) view.render(step * .05, .05)
  const farCharacter = scene.getObjectByName('Shared character far')
  assert.equal(farCharacter.position.x, distant.position3d.x)
  assert.equal(unchanged.parent, null)
  view.setSharedRecords([distant], 'own')
  assert.equal(decoration.parent, null)
  assert.equal(scene.getObjectByName('Shared character far'), farCharacter)
  view.dispose()
})

test('loading the villa preserves online neighbors from the initial snapshot', () => {
  const { view } = createFixture()
  const landscape = new THREE.Group()
  view.showLandscape(landscape, layout)
  view.showCharacter(makeCharacter().model)
  view.render(0)
  const { x, y, z } = view.getPlayerSyncState().position3d
  view.setSharedRecords([
    { id: 'near', kind: 'presence', manor3d: true, position3d: { x: x + 2, y, z }, name: '邻居甲' },
    { id: 'far', kind: 'presence', manor3dOnline: true, position3d: { x: x + 210, y, z } }
  ], 'own')
  const near = landscape.parent.getObjectByName('Shared character near')
  assert.ok(near)
  view.showVilla(makeVilla())
  view.render(.05, .05)
  assert.equal(landscape.parent.getObjectByName('Shared character near'), near)
  assert.deepEqual(view.getCommunityPlayers().map(player => [player.id, player.visible]), [['near', true], ['far', false]])
  view.dispose()
})

test('nearby avatars use the selected player model, share geometry and animate independently', () => {
  const { view, disposed } = createFixture()
  const landscape = new THREE.Group()
  view.showLandscape(landscape, layout)
  const boy = makeCharacter(), girl = makeCharacter()
  view.showCharacter(boy.model, 'boy')
  assert.ok(view.hasRemoteCharacterModel('boy'))
  assert.ok(view.setRemoteCharacterModel('girl', girl.model))
  const { x, y, z } = view.getPlayerSyncState().position3d
  view.setSharedRecords([
    { id: 'runner', kind: 'presence', manor3dOnline: true, position3d: { x: x + 2, y, z },
      manor3dMoving: true, manor3dRunning: true, manor3dCharacterType: 'boy' },
    { id: 'idle', kind: 'presence', manor3dOnline: true, position3d: { x: x - 2, y, z }, manor3dCharacterType: 'girl' }
  ], 'own')
  for (let step = 1; step < 8; step++) view.render(step * .04, .04)
  const scene = landscape.parent
  const runner = scene.getObjectByName('Shared character runner').getObjectByName('Body')
  const idle = scene.getObjectByName('Shared character idle').getObjectByName('Body')
  assert.equal(runner.geometry, boy.body.geometry)
  assert.equal(idle.geometry, girl.body.geometry)
  assert.ok(Math.abs(runner.rotation.x - .7) < 1e-6)
  assert.ok(Math.abs(idle.rotation.x - .01) < 1e-6)
  assert.ok(Math.abs(boy.body.rotation.x - .01) < 1e-6)
  view.showCharacter(makeCharacter().model, 'girl')
  assert.ok(!disposed.includes(boy.model))
  view.dispose()
  assert.equal(disposed.filter(model => model === boy.model).length, 1)
  assert.equal(disposed.filter(model => model === girl.model).length, 1)
})

test('remote players show the synchronized lying posture', () => {
  const { view } = createFixture()
  const landscape = new THREE.Group()
  view.showLandscape(landscape, layout)
  view.showCharacter(createAnimatedCharacter(THREE).model, 'boy')
  const { x, y, z } = view.getPlayerSyncState().position3d
  view.setSharedRecords([{ id: 'resting', kind: 'presence', manor3dOnline: true,
    manor3dPose: 'lie', position3d: { x: x + 2, y, z }, manor3dCharacterType: 'boy' }], 'own')
  for (let step = 1; step <= 24; step++) view.render(step * .04, .04)
  const hips = landscape.parent.getObjectByName('Shared character resting').getObjectByName('Hips')
  assert.ok(Math.abs(hips.quaternion.x + Math.SQRT1_2) < .02)
  view.dispose()
})

test('villa focus fits the model in portrait and pan/orbit/zoom remain bounded', () => {
  const { view, frames } = createFixture()
  view.showLandscape(new THREE.Group(), layout)
  assert.equal(view.focusVilla(), false)
  const villa = makeVilla()
  view.showVilla(villa)
  assert.equal(view.focusVilla(), true)
  view.render(1)
  const { min, max } = new THREE.Box3().setFromObject(villa)
  const focus = frames.at(-1)
  for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
    const corner = new THREE.Vector3(x, y, z).project(focus)
    assert.ok(Math.abs(corner.x) < 1 && Math.abs(corner.y) < 1)
  }
  view.enterMapView()
  view.render(1)
  const initial = frames.at(-1)
  view.zoom(1.2)
  view.render(1)
  assert.ok(frames.at(-1).position.y < initial.position.y)
  view.orbit(200, 0)
  view.pan(1e6, -1e6)
  view.zoom(1e-6)
  view.render(1)
  const camera = frames.at(-1)
  const direction = camera.getWorldDirection(new THREE.Vector3())
  const target = camera.position.clone().addScaledVector(direction, (4.1 + 3.5 - camera.position.y) / direction.y)
  assert.ok(Math.abs(target.x) <= 600.001 && Math.abs(target.z) <= 480.001)
  assert.ok(camera.position.distanceTo(target) <= 6000.001)
  assert.ok(direction.y < -0.30 && direction.y > -0.99)
  view.dispose()
})


test('the full map stays in view when rotating between portrait and landscape', () => {
  const { view, frames } = createFixture()
  view.showLandscape(new THREE.Group(), layout)
  view.enterMapView()

  const edge = new THREE.Vector3()
  for (const [width, height] of [[390, 844], [852, 393], [320, 740]]) {
    view.resize(width, height)
    view.render(0)
    const camera = frames.at(-1)
    assert.equal(camera.aspect, width / height)
    for (const x of [-layout.world.width / 2, layout.world.width / 2]) {
      for (const z of [-layout.world.depth / 2, layout.world.depth / 2]) {
        edge.set(x, layout.groundLevel, z).project(camera)
        assert.ok(Math.abs(edge.x) < 1 && Math.abs(edge.y) < 1 && Math.abs(edge.z) < 1,
          `map corner ${x}, ${z} is outside the ${width}×${height} view`)
      }
    }
  }
  view.dispose()
})

test('following the avatar ignores pan, stays framed when zooming and preserves the view across character changes', () => {
  const { view, frames } = createFixture()
  view.showLandscape(new THREE.Group(), layout)
  const boy = makeCharacter(), girl = makeCharacter()
  view.showCharacter(boy.model)
  view.render(0)
  const initialCamera = frames.at(-1)
  const avatar = boy.model.parent.position.clone()
  const avatarChest = avatar.clone().add(new THREE.Vector3(0, 1, 0))

  view.pan(10000, 0)
  view.render(0)
  assert.ok(frames.at(-1).position.equals(initialCamera.position))

  view.zoom(1e6)
  view.resize(852, 393)
  view.render(0)
  const zoomedCamera = frames.at(-1)
  assert.ok(zoomedCamera.position.distanceTo(avatar) < initialCamera.position.distanceTo(avatar) / 2)
  assert.ok(Math.abs(avatarChest.clone().project(zoomedCamera).x) < 1e-6)
  const feet = avatar.clone().project(zoomedCamera)
  const head = avatar.clone().add(new THREE.Vector3(0, 1.6, 0)).project(zoomedCamera)
  for (const point of [feet, head]) {
    assert.ok(Math.abs(point.x) < 1 && Math.abs(point.y) < 1, 'the entire avatar stays on screen')
  }

  view.showCharacter(girl.model)
  view.render(0)
  const switchedCamera = frames.at(-1)
  assert.ok(switchedCamera.position.distanceTo(zoomedCamera.position) < 1e-6)
  assert.ok(switchedCamera.quaternion.angleTo(zoomedCamera.quaternion) < 1e-6)
  view.focusCharacter()
  view.render(0)
  assert.ok(Math.abs(avatarChest.clone().project(frames.at(-1)).x) < 1e-6, 'returning to the avatar recenters the camera')
  view.dispose()
})

test('both camera modes can look up without moving the camera underground', () => {
  const { view, frames } = createFixture()
  view.showLandscape(new THREE.Group(), layout)
  const { model } = makeCharacter()
  view.showCharacter(model)
  view.resize(852, 393)

  const direction = new THREE.Vector3()
  view.zoom(1e6)
  for (const mapView of [false, true]) {
    if (mapView) {
      view.enterMapView()
      view.zoom(1e6)
    }
    view.orbit(0, -320)
    view.render(0)
    const camera = frames.at(-1)
    assert.ok(camera.getWorldDirection(direction).y > 0.4, 'the lens can tilt up toward the sky')
    assert.ok(camera.position.y > layout.groundLevel, 'camera stays above ground')
    if (mapView) {
      view.pan(0, 30)
      view.render(0)
      const moved = frames.at(-1)
      assert.ok(moved.position.distanceTo(camera.position) > 1)
      assert.ok(moved.getWorldDirection(direction).y > 0.4, 'map panning preserves the tilt')
    }
  }
  view.dispose()
})

test('first person follows the eye line, steers walking with the view, and resumes after the map', () => {
  const { view, frames } = createFixture()
  view.showLandscape(new THREE.Group(), layout)
  const { model } = makeCharacter()
  view.showCharacter(model)
  assert.equal(view.placeCharacterAt({ x: 5, z: 75 }, 0), true)
  const actor = model.parent
  const feet = actor.position.clone()
  assert.equal(view.setFirstPerson(true), true)
  view.render(0)
  const eye = frames.at(-1)
  assert.equal(actor.visible, false)
  assert.ok(eye.position.distanceTo(feet.clone().add(new THREE.Vector3(0, 1.6 * .92, 0))) < 1e-6)
  assert.ok(eye.getWorldDirection(new THREE.Vector3()).z > .99)

  view.orbit(100 * Math.PI, -70)
  view.render(0)
  const looked = frames.at(-1).getWorldDirection(new THREE.Vector3())
  assert.ok(looked.x < -.9 && looked.y > .3)
  view.setPlayerInput(0, -1)
  view.render(.1, .1)
  view.setPlayerInput(0, 0)
  assert.ok(actor.position.x < feet.x - .6)
  assert.ok(Math.abs(actor.position.z - feet.z) < 1e-6)

  view.enterMapView()
  view.render(.1)
  assert.equal(actor.visible, true)
  assert.equal(view.setFirstPerson(false), false)
  view.exitMapView()
  view.render(.1)
  assert.equal(actor.visible, false)
  assert.ok(frames.at(-1).getWorldDirection(new THREE.Vector3()).distanceTo(looked) < 1e-6)
  assert.equal(view.setFirstPerson(false), true)
  view.render(.1)
  assert.equal(actor.visible, true)
  assert.ok(frames.at(-1).position.distanceTo(actor.position) > 3)
  view.dispose()
})

test('first person descends into the vehicle, turns with steering, and returns to standing height', () => {
  const { view, frames } = createFixture()
  view.showLandscape(new THREE.Group(), layout)
  const { model } = makeCharacter()
  view.showCharacter(model)
  const vehicle = new THREE.Group()
  for (const name of ['Door_L', 'Door_R', 'Steering_Wheel', 'Steer_FL', 'Steer_FR', 'Spin_FL', 'Spin_FR', 'Spin_RL', 'Spin_RR']) {
    const part = new THREE.Group()
    part.name = name
    vehicle.add(part)
  }
  assert.equal(view.showVehicle(vehicle), true)
  assert.equal(view.setFirstPerson(true), true)
  assert.equal(view.enterVehicle('driver'), true)
  let elapsed = 0
  const tick = () => view.render(elapsed += .05, .05)
  const actor = model.parent
  const eyeHeight = () => frames.at(-1).position.y - actor.position.y
  const heights = []
  while (view.getVehicleState().mode === 'entering' && elapsed < 8) {
    tick()
    heights.push(eyeHeight())
  }
  assert.equal(view.getVehicleState().mode, 'driver')
  assert.ok(heights.some(height => height > 1.15 && height < 1.4), 'boarding lowers the eye line over several frames')
  assert.ok(eyeHeight() < 1.15)

  view.orbit(60, -10)
  tick()
  const car = vehicle.parent
  const look = new THREE.Vector3()
  const localLook = () => frames.at(-1).getWorldDirection(look).applyAxisAngle(new THREE.Vector3(0, 1, 0), -car.rotation.y).clone()
  const initialLook = localLook()
  const startingYaw = car.rotation.y
  view.setPlayerInput(1, -1)
  for (let i = 0; i < 20; i++) tick()
  assert.ok(Math.abs(car.rotation.y - startingYaw) > .2)
  assert.ok(localLook().distanceTo(initialLook) < 1e-6)
  view.brakeVehicle()
  for (let i = 0; i < 20; i++) tick()
  assert.equal(view.exitVehicle(), true)
  const exitEnd = elapsed + 4
  while (view.getVehicleState().mode === 'exiting' && elapsed < exitEnd) tick()
  assert.equal(view.getVehicleState().mode, 'walking')
  assert.ok(Math.abs(eyeHeight() - 1.6 * .92) < 1e-6)
  view.dispose()
})

test('opening the map stops movement and late character loading does not move its camera', () => {
  const { view, frames } = createFixture()
  view.showLandscape(new THREE.Group(), layout)
  view.enterMapView()
  view.render(0)
  const overview = frames.at(-1)
  const character = makeCharacter()
  view.showCharacter(character.model)
  view.render(0)
  assert.ok(frames.at(-1).position.equals(overview.position))

  view.exitMapView()
  view.render(0)
  assert.ok(!frames.at(-1).position.equals(overview.position))
  view.setPlayerInput(0, 1)
  view.render(.1, .1)
  const position = character.model.parent.position.clone()
  view.enterMapView()
  view.setPlayerInput(0, 1)
  view.render(.2, .1)
  assert.ok(character.model.parent.position.equals(position), 'map preview leaves the character stationary')
  view.exitMapView()
  view.render(.3, .1)
  assert.ok(character.model.parent.position.equals(position), 'a previous joystick drag does not resume movement')
  view.dispose()
})

test('invalid layouts leave the active models attached and each accepted model is disposed only once', () => {
  const { view, frames, disposed } = createFixture()
  const land = new THREE.Group()
  const villa = makeVilla()
  const replacement = new THREE.Group()
  view.showLandscape(land, layout)
  view.showVilla(villa)
  assert.throws(() => view.showLandscape(replacement, { ...layout, plots: [{ id: 'invalid' }] }), { code: 'MANOR_INVALID_LAYOUT' })
  assert.deepEqual(disposed, [])
  view.showLandscape(replacement, layout)
  assert.deepEqual(disposed, [villa, land])
  view.render(2)
  view.dispose()
  view.dispose()
  view.render(3)
  assert.deepEqual(disposed, [villa, land, replacement])
  assert.equal(frames.length, 1)
})
