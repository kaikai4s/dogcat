const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { THREE, loadGlb, disposeModel } = require('../../miniprogram/packageManor3d/utils/model-runtime')
const { createCourtyardInterior } = require('../../miniprogram/packageManor3d/utils/manor-courtyard-interior')

function placedVilla(rotation) {
  const anchor = new THREE.Group(), model = new THREE.Group(), floor = new THREE.Group(), facade = new THREE.Group()
  anchor.position.set(34, .62, -17)
  anchor.rotation.y = rotation
  model.position.set(-8, 0, -10.5)
  floor.name = 'F1'
  facade.name = 'Exterior'
  floor.add(facade)
  model.add(floor)
  anchor.add(model)
  return { floor, interior: createCourtyardInterior({ THREE, model }) }
}

const samePoint = (actual, expected) => assert.ok(actual.distanceTo(expected) < 1e-6, actual.toArray())

test('both entrances stay aligned after placement and allow movement through the threshold', () => {
  for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
    const { floor, interior } = placedVilla(angle)
    const { navigation } = interior
    const [north, south] = interior.getEntrances()
    assert.deepEqual([north.id, south.id], ['north', 'south'])
    for (const [door, x, z, direction] of [[north, 7.70, 0, 1], [south, 7.80, 14, -1]]) {
      samePoint(door.threshold, floor.localToWorld(new THREE.Vector3(x, .22, z + direction * .083)))
      samePoint(door.outside, floor.localToWorld(new THREE.Vector3(x, 0, z - direction * 1.5)))
      samePoint(door.forward, new THREE.Vector3(Math.sin(angle) * direction, 0, Math.cos(angle) * direction))
      assert.equal(navigation.sampleMove(door.inside.x, door.inside.z, door.threshold), door.inside.y)
      assert.equal(navigation.sampleMove(door.threshold.x, door.threshold.z, door.inside), door.threshold.y)
    }
    assert.equal(navigation.sample(north.outside.x, north.outside.z, null, north.outside.y), null)
  }
})

test('the indoor route follows the two stair landings up to the third floor and blocks solid walls and furniture', () => {
  const { floor, interior } = placedVilla(-Math.PI / 2)
  const { navigation } = interior
  const point = (x, y, z) => floor.localToWorld(new THREE.Vector3(x, y, z))
  const [north, south] = interior.getEntrances()
  const betweenDoors = navigation.sampleMove(south.inside.x, south.inside.z, north.inside)
  assert.equal(betweenDoors, south.inside.y)
  const blockedByWall = point(6.5, .22, .8)
  assert.equal(navigation.sampleMove(blockedByWall.x, blockedByWall.z, north.inside), null)
  const sofa = point(3.2, .22, 9.05)
  assert.equal(navigation.sample(sofa.x, sofa.z, null, sofa.y), null)

  let from = point(9.43, .22, 6.94)
  const ascend = [
    [9.43, 3.18, 2.02], [10.57, 3.18, 2.02], [10.57, 6.94, 3.82],
    [9.43, 6.94, 3.82], [9.43, 3.18, 5.47], [10.57, 3.18, 5.47], [10.57, 6.94, 7.12]
  ]
  const descend = [
    [10.57, 3.18, 5.47], [9.43, 3.18, 5.47], [9.43, 6.94, 3.82],
    [10.57, 6.94, 3.82], [10.57, 3.18, 2.02], [9.43, 3.18, 2.02], [9.43, 6.94, .22]
  ]
  for (const [x, z, y] of [...ascend, ...descend]) {
    const target = point(x, y, z)
    const actual = navigation.sampleMove(target.x, target.z, from)
    assert.ok(actual !== null && Math.abs(actual - target.y) < 1e-6, JSON.stringify({ x, z, y, actual }))
    from = target
  }
})

const assetPath = path.resolve(__dirname, '../../output/manor-courtyard-cloud-upload/courtyard-villa.glb')
test('the existing cloud asset opens both doors without changing neighboring glazing or shared geometry', {
  skip: !fs.existsSync(assetPath)
}, async () => {
  const asset = await loadGlb(fs.readFileSync(assetPath))
  const placed = asset.clone(true)
  const facade = placed.getObjectByName('F1').getObjectByName('Exterior')
  const originalMeshes = facade.children.filter(node => node.isMesh)
  const original = originalMeshes.map(mesh => mesh.geometry)
  let disposedOriginal = 0
  for (const geometry of original) geometry.addEventListener('dispose', () => disposedOriginal++)
  const interior = createCourtyardInterior({ THREE, model: placed })
  function hit(x, z, direction) {
    placed.updateMatrixWorld(true)
    const ray = new THREE.Raycaster(new THREE.Vector3(x, 1.2, z - direction * .55), new THREE.Vector3(0, 0, direction), 0, .85)
    return ray.intersectObject(facade, true).length > 0
  }
  try {
    assert.equal(hit(7.70, 0, 1), true)
    assert.equal(hit(7.80, 14, -1), true)
    assert.equal(interior.setDoorOpen('north', true), true)
    assert.equal(hit(7.70, 0, 1), false)
    assert.equal(hit(7.80, 14, -1), true)
    assert.equal(interior.setDoorOpen('south', true), true)
    assert.equal(hit(7.80, 14, -1), false)
    assert.equal(hit(1.50, 0, 1), true)
    assert.equal(hit(2.00, 14, -1), true)
    let disposedSplit = 0
    facade.traverse(mesh => {
      if (mesh.isMesh && !original.includes(mesh.geometry) && !originalMeshes.some(originalMesh => originalMesh !== mesh && originalMesh.geometry === mesh.geometry)) {
        mesh.geometry.addEventListener('dispose', () => disposedSplit++)
      }
    })
    interior.resetDoors()
    assert.equal(hit(7.70, 0, 1), true)
    assert.equal(hit(7.80, 14, -1), true)
    interior.dispose()
    assert.deepEqual(originalMeshes.map(mesh => mesh.geometry), original)
    assert.equal(disposedOriginal, 0)
    assert.equal(disposedSplit, 13)
  } finally {
    interior.dispose()
    disposeModel(asset)
  }
})
