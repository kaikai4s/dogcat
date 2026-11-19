const test = require('node:test')
const assert = require('node:assert/strict')
const { THREE } = require('../../miniprogram/packageManor3d/vendor/three-runtime')
const { createManorNavigation } = require('../../miniprogram/packageManor3d/utils/manor-navigation')

function grid(name, columns, rows, point) {
  const positions = [], indices = []
  for (let j = 0; j < rows; j++) for (let i = 0; i < columns; i++) {
    positions.push(...point(i, j))
    if (i < columns - 1 && j < rows - 1) {
      const a = j * columns + i
      indices.push(a, a + columns, a + 1, a + 1, a + columns, a + columns + 1)
    }
  }
  const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  const mesh = new THREE.Mesh(geometry)
  mesh.name = name
  return mesh
}

const config = {
  width: 80, depth: 80, ground: 4.1, plots: [],
  bridge: { x: 0, z: 0 }, crossings: [{ x: 0, z: 0, yaw: 0, width: 7.6, length: 20 }],
  landmarkTrees: [{ x: 20, z: 20, r: 6 }]
}
function fixture() {
  const ground = grid('01 | Continuous meadow', 5, 5, (i, j) => [i * 20 - 40, 4.1 + .02 * (i * 20 - 40), j * 20 - 40 + i * .3])
  const water = grid('03 | Winding clear stream', 5, 2, (i, j) => [i * 20 - 40, .25, (j ? 1 : -1) * 4 + i * .3])
  const bridge = new THREE.Group()
  bridge.name = '04 | Stone footbridge 0'
  bridge.add(grid('01 Stone arch | barrel vault and abutments', 2, 5, (i, j) => [i ? 3.8 : -3.8, j === 2 ? 7 : 4.1, j * 5 - 10]))
  return createManorNavigation({ THREE, config, landscape: new THREE.Group().add(ground, water, bridge) })
}

test('navigation uses the exported sloped meadow, blocks water and boundaries, and follows the continuous bridge surface', () => {
  const navigation = fixture()
  assert.ok(Math.abs(navigation.sample(10, 20) - 4.3) < 1e-6)
  assert.equal(navigation.sample(12, 0), null)
  assert.equal(navigation.sample(39.9, 20), null)
  assert.equal(navigation.sample(NaN, 0), null)
  for (let z = -10; z <= 10; z += .17) {
    assert.ok(Number.isFinite(navigation.sample(0, z)), 'bridge must remain continuous at ' + z)
  }
  assert.ok(navigation.sample(0, 0) > 7)
  assert.equal(navigation.sample(3.3, 0), null, 'coping keeps the player away from the rails')
  assert.equal(navigation.sample(20, 20), null, 'landmark trunk is solid')
})

test('slow steps remain walkable at both ends of the bridge', () => {
  const navigation = fixture()
  for (const end of [-10, 10]) {
    let previous = navigation.sample(0, end - .05)
    assert.ok(Number.isFinite(previous))
    for (let step = 1; step <= 20; step++) {
      const z = end - .05 + step * .005
      const height = navigation.sample(0, z)
      assert.ok(Number.isFinite(height), 'bridge approach is blocked at z=' + z)
      assert.ok(Math.abs(height - previous) < .15, 'height jumps at the bridge approach')
      previous = height
    }
  }
})

test('spawn stays outside a villa and its footprint is on walkable terrain', () => {
  const navigation = fixture()
  const villa = new THREE.Box3(new THREE.Vector3(-5, 0, 9), new THREE.Vector3(5, 20, 20))
  assert.equal(navigation.sample(0, 12, villa), null)
  const spawn = navigation.spawn(villa)
  assert.ok(spawn)
  assert.equal(navigation.sample(spawn.x, spawn.z, villa), spawn.y)
  assert.ok(spawn.z < 0)
})

test('community placement can snap to nearby walkable ground without crossing the movement bound', () => {
  const navigation = fixture()
  const nearest = navigation.nearestWalkable(12, 0, null, 24)
  assert.ok(nearest)
  assert.ok(Math.hypot(nearest.x - 12, nearest.z) <= 24)
  assert.ok(Number.isFinite(navigation.sample(nearest.x, nearest.z)))
  assert.equal(navigation.nearestWalkable(12, 0, null, 1), null)
})

test('a yawed and translated bridge is sampled in its local coordinates', () => {
  const bridge = new THREE.Group()
  bridge.name = '04 | Stone footbridge test'
  bridge.position.set(12, 2, -7)
  bridge.rotation.y = .78
  bridge.add(grid('01 Stone arch | barrel vault and abutments', 2, 3, (i, j) => [i ? 3.8 : -3.8, j === 1 ? 6 : 4.1, j * 5 - 5]))
  const navigation = createManorNavigation({ THREE, config, landscape: new THREE.Group().add(bridge) })
  assert.ok(Math.abs(navigation.sample(12, -7) - 8.076) < 1e-5)
  const blocked = new THREE.Vector3(3.3, 0, 0).applyMatrix4(bridge.matrixWorld)
  assert.equal(navigation.sample(blocked.x, blocked.z), null)
})
