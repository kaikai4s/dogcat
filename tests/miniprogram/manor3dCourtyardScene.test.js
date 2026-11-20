const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { THREE, loadGlb, disposeModel } = require('../../miniprogram/packageManor3d/utils/model-runtime')
const { createManorScene } = require('../../miniprogram/packageManor3d/utils/manor-scene')
const { createCourtyardInterior } = require('../../miniprogram/packageManor3d/utils/manor-courtyard-interior')
const { createAnimatedCharacter } = require('../fixtures/manor3dCharacter')

const courtyard = 'songying_courtyard'
const assetPath = path.resolve(__dirname, '../../output/manor-courtyard-cloud-upload/courtyard-villa.glb')
const plot = { id: 'court', x: -40, y: 4.1, z: -52, width: 42, depth: 42 }
const anotherPlot = { ...plot, id: 'another', x: 42 }
const layout = { world: { width: 200, depth: 200 }, groundLevel: 4.1,
  plots: [{ ...plot, id: 'red', x: 0, z: 0 }, plot, anotherPlot] }

function mount(avatar = createAnimatedCharacter(THREE).model) {
  let scene, time = 0
  const view = createManorScene({ THREE, disposeModel, renderer: {
    setSize() {}, render(next) { scene = next; scene.updateMatrixWorld() }
  } })
  view.resize(390, 700)
  view.showLandscape(new THREE.Group(), layout)
  view.showCharacter(avatar)
  const tick = (frames = 1) => {
    for (let frame = 0; frame < frames; frame++) view.render(time += .05, .05)
  }
  tick()
  return { view, tick, actor: scene.getObjectByName('Manor player'),
    floor: id => scene.getObjectByName('Built building ' + id)?.getObjectByName('F1') }
}

function placement(lot, rotation) {
  return { id: lot.id, plotId: lot.id, buildingId: courtyard, x: lot.x, z: lot.z, rotation }
}

function courtyardFixture() {
  const floor = new THREE.Group(), exterior = new THREE.Group()
  floor.name = 'F1'
  exterior.name = 'Exterior'
  const hull = new THREE.Mesh(new THREE.BoxGeometry(26, 12, 36), new THREE.MeshBasicMaterial())
  hull.position.set(8, 5.5, 10)
  return new THREE.Group().add(floor.add(exterior), hull)
}

function point(floor, x, y, z) {
  return floor.localToWorld(new THREE.Vector3(x, y, z))
}

function samePosition(actual, expected) {
  assert.ok(expected.distanceTo(actual) < 1e-6,
    'Actual ' + [actual.x, actual.y, actual.z] + ' != expected ' + expected.toArray())
}

test('the uploaded courtyard opens each placed doorway, walks through it and exits at the same door', {
  skip: !fs.existsSync(assetPath)
}, async () => {
  const { view, tick, actor, floor } = mount()
  const source = await loadGlb(fs.readFileSync(assetPath))
  view.setBuildModel(courtyard, source)
  const original = source.getObjectByName('F1').getObjectByName('Exterior').children.find(node => node.isMesh).geometry
  try {
    for (const rotation of [0, 90, 180, 270]) {
      view.setPlacedBuildings([placement(plot, rotation), placement(anotherPlot, (rotation + 90) % 360)])
      const f1 = floor(plot.id)
      for (const [id, x, z, direction] of [['north', 7.7, 0, 1], ['south', 7.8, 14, -1]]) {
        const outside = point(f1, x, 0, z - direction * 1.5)
        const inside = point(f1, x, .22, z + direction * 1.2)
        assert.equal(view.placeCharacterAt(outside, 0), true)
        assert.deepEqual(view.getCourtyardDoor(), { plotId: plot.id, doorId: id,
          label: id === 'north' ? '北侧正门' : '南侧花园门', distance: 0, inside: false })
        assert.equal(view.interactCourtyardDoor(anotherPlot.id, id), false)
        assert.equal(view.interactCourtyardDoor(plot.id, id), true)
        assert.equal(view.getCourtyardDoor(), null)
        assert.equal(view.isCourtyardDoorBusy, true)
        assert.equal(view.setBuildPreview({ buildingId: courtyard }), false)
        tick(9)
        let hinge
        f1.traverse(node => { if (node.name === 'Courtyard door ' + id + ' left') hinge = node })
        assert.ok(Math.abs(hinge.rotation.y) > 1)
        assert.equal(view.isInsideVilla, false)
        assert.equal(view.getPlayerSyncState().interior, null)
        samePosition(view.getPlayerCheckpoint(), outside)
        tick(30)
        assert.equal(Math.abs(hinge.rotation.y), 0)
        assert.equal(view.isCourtyardDoorBusy, false)
        assert.equal(view.isInsideCourtyard, true)
        assert.deepEqual(view.getPlayerSyncState().interior, { kind: 'courtyard', plotId: plot.id })
        assert.equal(view.getCourtyardDoor().inside, true)
        samePosition(actor.position, inside)
        assert.equal(view.interactCourtyardDoor(plot.id, id), true)
        tick(9)
        assert.equal(view.getPlayerCheckpoint().interior.plotId, plot.id)
        samePosition(view.getPlayerCheckpoint(), inside)
        tick(18)
        assert.equal(view.isCourtyardDoorBusy, true)
        assert.equal(view.isInsideVilla, false)
        samePosition(view.getPlayerCheckpoint(), outside)
        tick(12)
        assert.equal(view.isInsideVilla, false)
        assert.equal(view.isCourtyardDoorBusy, false)
        samePosition(actor.position, outside)
      }
      assert.equal(source.getObjectByName('F1').getObjectByName('Exterior').children.find(node => node.isMesh).geometry, original)
    }
  } finally {
    view.dispose()
  }
})

test('a rotated third-floor checkpoint restores the correct building and removal moves the avatar outside', () => {
  const { view, actor, floor } = mount()
  view.setBuildModel(courtyard, courtyardFixture())
  const other = placement(anotherPlot, 180)
  view.setPlacedBuildings([placement(plot, 90), other])
  const f1 = floor(plot.id)
  const upstairs = point(f1, 7.7, 7.12, 1.2)
  const outside = point(f1, 7.7, 0, -1.5)
  const facing = .78
  const saved = { x: upstairs.x, y: upstairs.y, z: upstairs.z, facing,
    interior: { kind: 'courtyard', plotId: plot.id }, exterior: { x: outside.x, y: outside.y, z: outside.z } }
  try {
    assert.equal(view.restorePlayerPosition(saved), true)
    samePosition(actor.position, upstairs)
    assert.ok(Math.abs(actor.rotation.y - facing) < 1e-8)
    assert.equal(view.getCourtyardDoor(), null)
    assert.deepEqual(view.getPlayerCheckpoint(), saved)
    view.setPlacedBuildings([other])
    assert.equal(view.isInsideVilla, false)
    samePosition(actor.position, outside)
    assert.equal(view.getCourtyardDoor(), null)
    assert.equal(view.restorePlayerPosition(saved), false)
    assert.equal(view.restorePlayerPosition({ ...saved.exterior, facing }), true)
    samePosition(actor.position, outside)
    assert.equal(view.getPlayerCheckpoint().interior, undefined)
  } finally {
    view.dispose()
  }
})

test('resting in a rotated courtyard leaves a walkable checkpoint beside the bed', {
  skip: !fs.existsSync(assetPath)
}, async () => {
  const { view, tick, actor, floor } = mount()
  try {
    view.setBuildModel(courtyard, await loadGlb(fs.readFileSync(assetPath)))
    view.setPlacedBuildings([placement(plot, 90)])
    const { navigation } = createCourtyardInterior({ THREE, model: floor(plot.id) })
    const bed = navigation.restSpots.find(spot => spot.kind === 'lie')
    assert.ok(bed, 'the courtyard exposes a bed')
    const interior = { kind: 'courtyard', plotId: plot.id }
    assert.equal(view.restorePlayerPosition({ ...bed.entry, facing: 0, interior }), true)
    assert.equal(view.getRestState('lie')?.spotId, bed.id)
    assert.equal(view.interactRest('lie'), true)
    tick(60)
    assert.equal(view.getRestState('lie')?.label, '起身')
    assert.equal(view.interactRest('sit'), false)
    samePosition(actor.position, bed.position)
    const checkpoint = view.getPlayerCheckpoint()
    assert.deepEqual(checkpoint.interior, interior)
    samePosition(checkpoint, bed.exit)
    assert.equal(view.interactRest('lie'), true)
    tick(60)
    samePosition(actor.position, bed.exit)
    assert.equal(view.getRestState('lie')?.label, '躺下')
  } finally {
    view.dispose()
  }
})
