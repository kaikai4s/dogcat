const test = require('node:test')
const assert = require('node:assert/strict')
const { THREE } = require('../../miniprogram/packageManor3d/vendor/three-runtime')
const { createManorScene } = require('../../miniprogram/packageManor3d/utils/manor-scene')

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
