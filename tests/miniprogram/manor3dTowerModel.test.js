const test = require('node:test')
const assert = require('node:assert/strict')
const { THREE, disposeModel } = require('../../miniprogram/packageManor3d/utils/model-runtime')
const { createManorTowerDisplay } = require('../../miniprogram/packageManor3d/utils/manor-tower-model')
const { createManorScene } = require('../../miniprogram/packageManor3d/utils/manor-scene')
const { createAnimatedCharacter } = require('../fixtures/manor3dCharacter')

function fixture() {
  const source = new THREE.Group()
  const concrete = new THREE.MeshStandardMaterial({ name: 'Stone' })
  const glass = new THREE.MeshStandardMaterial({ name: 'Glazing', transparent: true, opacity: .47 })
  const box = new THREE.BoxGeometry(1, 1, 1)
  const mesh = (material, x, y, z, w, h, d) => {
    const part = new THREE.Mesh(box, material)
    part.position.set(x, y, z)
    part.scale.set(w, h, d)
    return part
  }
  const layer = (parent, name, ...parts) => {
    const group = new THREE.Group()
    if (parts.length) group.add(...parts)
    group.name = name
    parent.add(group)
    return group
  }
  const site = layer(source, 'Site', mesh(concrete, 0, -.25, 1, 42, .5, 34))
  layer(source, 'Roof', mesh(concrete, 0, 56, 0, 32, 2, 26))
  for (let i = 0; i < 18; i++) {
    const floor = layer(source, 'Floor_' + String(i + 1).padStart(2, '0'))
    const suffix = i ? '_' + i : ''
    floor.position.y = i ? 4 + (i - 1) * 3 : 0
    layer(floor, 'Structure' + suffix, mesh(concrete, 0, 0, 0, 30, .25, 22))
    layer(floor, 'Facade' + suffix, mesh(concrete, -14, 1.5, 0, 2, 3, 22), mesh(glass, 0, 1.5, 11, 2, 3, .05))
    layer(floor, 'Detail' + suffix, mesh(concrete, 200, 0, 0, 2, 1, 2))
    const doors = layer(floor, 'Doors' + suffix)
    layer(doors, i ? 'A_BalconySlider' + suffix : 'SouthEntry_L', mesh(glass, 0, 1.5, 12, 2, 3, .05))
    layer(doors, 'Interior_Door' + suffix, mesh(glass, 0, 1.5, 200, 2, 3, .05))
  }
  const front = source.getObjectByName('SouthEntry_L').children[0]
  return { source, site, concrete, glass, box, front }
}

function withLobby({ source, concrete, glass, front }) {
  const left = front.parent
  left.position.set(-.7, 0, 11.145)
  left.userData.slideX = -1.36
  front.position.set(0, 1.5, 0)
  front.scale.x = 1.4
  const right = left.clone(true)
  right.name = 'SouthEntry_R'
  right.position.x = .7
  right.userData.slideX = 1.36
  left.parent.add(right)
  const floor = source.getObjectByName('Floor_01')
  const detail = floor.getObjectByName('Detail')
  detail.children[0].position.set(0, .015, 8)
  detail.children[0].scale.set(8, .03, 6)
  left.parent.remove(left.parent.getObjectByName('Interior_Door'))
  floor.getObjectByName('Facade').children.find(mesh => mesh.material === glass).material = concrete
  return source
}

test('tower display preserves its real site and exterior doors while removing indoor geometry', () => {
  const { source, concrete, glass, box, front } = fixture()
  source.position.set(37, 2, 69)
  source.rotation.y = Math.PI / 2
  const display = createManorTowerDisplay(THREE, source)
  const bounds = new THREE.Box3().setFromObject(display)
  assert.deepEqual(bounds.min.toArray(), [-21, -.5, -16])
  assert.deepEqual(bounds.max.toArray(), [21, 57, 18])

  // A ray at the closed entry hits its glazing before the main facade.
  const hit = new THREE.Raycaster(new THREE.Vector3(0, 1.5, 20), new THREE.Vector3(0, 0, -1))
    .intersectObject(display, true)[0]
  assert.equal(hit.object.material.name, 'Glazing')
  assert.ok(Math.abs(hit.point.z - 12.025) < 1e-5)
  assert.equal(hit.object.material.transparent, false)
  assert.equal(front.material, glass)
  assert.equal(front.material.opacity, .47)

  let meshes = 0
  const ownedGeometries = new Set()
  display.traverse(node => {
    if (!node.isMesh) return
    meshes++
    ownedGeometries.add(node.geometry)
    assert.ok(node.geometry.index.array instanceof Uint16Array)
    assert.notEqual(node.geometry, box)
    assert.notEqual(node.material, concrete)
    assert.notEqual(node.material, glass)
  })
  assert.ok(meshes < 32)
  assert.ok(ownedGeometries.size < meshes)

  const otherTower = display.clone(true)
  otherTower.position.x = 90
  const clonedLeaf = otherTower.getObjectByName('SouthEntry_L').children[0]
  assert.equal(clonedLeaf.geometry, hit.object.geometry)
  assert.equal(clonedLeaf.material, hit.object.material)
  assert.equal(display.position.x, 0)

  let originalDisposals = 0
  let displayDisposals = 0
  box.addEventListener('dispose', () => originalDisposals++)
  hit.object.geometry.addEventListener('dispose', () => displayDisposals++)
  disposeModel(source)
  assert.equal(originalDisposals, 1)
  assert.equal(displayDisposals, 0)
  disposeModel(display)
  assert.equal(displayDisposals, 1)
})

test('a different GLB is rejected without disposing the source', () => {
  const { source, site, concrete } = fixture()
  source.remove(site)
  let disposals = 0
  concrete.addEventListener('dispose', () => disposals++)
  assert.throws(() => createManorTowerDisplay(THREE, source), /缺少有效的外景/)
  assert.equal(disposals, 0)
  disposeModel(source)
})

test('rotated high-rise doors open independently and walk the character in and out of the lobby', () => {
  let scene, time = 0
  const view = createManorScene({ THREE, disposeModel, renderer: {
    setSize() {}, render(next) { scene = next; scene.updateMatrixWorld() }
  } })
  const tick = frames => {
    for (let i = 0; i < frames; i++) view.render(time += .05, .05)
  }
  view.resize(390, 700)
  view.showLandscape(new THREE.Group(), { world: { width: 1200, depth: 960 }, groundLevel: 4.1,
    plots: [{ id: 'red', x: 0, y: 4.1, z: 0, width: 40, depth: 30 }] })
  view.showCharacter(createAnimatedCharacter(THREE).model)
  const source = withLobby(fixture())
  const towers = view.showHighRises(source, 'toolbar-test')
  disposeModel(source)
  try {
    tick(1)
    const fixture = towers.find(tower => tower.yaw === Math.PI / 2)
    assert.ok(fixture)
    const model = scene.getObjectByName('Manor high-rise ' + fixture.id)
    const other = towers.find(tower => tower !== fixture)
    const otherModel = scene.getObjectByName('Manor high-rise ' + other.id)
    const leaf = model.getObjectByName('SouthEntry_L')
    const otherLeaf = otherModel.getObjectByName('SouthEntry_L')
    const lobby = model.getObjectByName('Tower lobby')
    const outside = model.localToWorld(new THREE.Vector3(0, 0, 12.595))
    assert.equal(lobby.visible, false)
    assert.equal(view.placeCharacterAt(outside, 0), true)
    view.focusCharacter()
    assert.deepEqual(view.getCourtyardDoor(), { plotId: fixture.id, doorId: 'main',
      label: '住宅楼正门', distance: view.getCourtyardDoor().distance, inside: false })
    assert.equal(view.interactCourtyardDoor(other.id, 'main'), false)
    assert.equal(view.interactCourtyardDoor(fixture.id, 'main'), true)
    tick(8)
    assert.ok(leaf.position.x < -2)
    assert.equal(otherLeaf.position.x, -.7)
    assert.equal(lobby.visible, true)
    assert.equal(view.getPlayerSyncState().interior, null)
    tick(40)
    const checkpoint = view.getPlayerCheckpoint()
    assert.deepEqual(checkpoint.interior, { kind: 'tower', plotId: fixture.id })
    assert.equal(view.getCourtyardDoor().inside, true)
    assert.equal(view.interactCourtyardDoor(fixture.id, 'main'), true)
    tick(50)
    assert.equal(view.isInsideVilla, false)
    assert.equal(lobby.visible, false)
    assert.equal(leaf.position.x, -.7)
    assert.ok(Math.hypot(view.getPlayerCheckpoint().x - outside.x, view.getPlayerCheckpoint().z - outside.z) < 1e-6)
    assert.equal(view.restorePlayerPosition(checkpoint), true)
    assert.deepEqual(view.getPlayerCheckpoint(), checkpoint)
  } finally {
    view.dispose()
  }
})
