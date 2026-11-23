const test = require('node:test')
const assert = require('node:assert/strict')
const { THREE } = require('../../miniprogram/packageManor3d/vendor/three-runtime')
const { createManorNavigation } = require('../../miniprogram/packageManor3d/utils/manor-navigation')
const { createManorTowerLayout } = require('../../miniprogram/packageManor3d/utils/manor-tower-layout')

const config = {
  width: 1200, depth: 960, ground: 4.1, bridge: { x: 0, z: 66 },
  crossings: [], landmarkTrees: [], plots: []
}
const footprint = { width: 42, depth: 34 }

function arrange(communityId, updates = {}) {
  const navigation = createManorNavigation({ THREE, landscape: new THREE.Group(), config })
  return createManorTowerLayout({ config, navigation, footprint, communityId, ...updates })
}

function separated(a, b, padding = 0) {
  return Math.abs(a.x - b.x) >= (a.width + b.width) / 2 + padding ||
    Math.abs(a.z - b.z) >= (a.depth + b.depth) / 2 + padding
}

test('each neighborhood sees a stable layout with correctly rotated footprints and walking space', () => {
  const sample = Array.from({ length: 16 }, (_, i) => arrange('neighborhood-' + i))
  assert.deepEqual(sample[0], arrange('neighborhood-0'))
  assert.deepEqual(new Set(sample.map(towers => towers.length)), new Set([3, 4]))
  assert.ok(new Set(sample.map(towers => JSON.stringify(towers))).size > 1)
  assert.ok(sample.flat().some(tower => tower.yaw === Math.PI / 2))
  for (const towers of sample) {
    assert.equal(new Set(towers.map(tower => tower.id)).size, towers.length)
    towers.forEach((tower, index) => {
      assert.ok(towers.slice(index + 1).every(other => separated(tower, other, 5)))
      assert.equal(tower.y, config.ground)
      const isSideways = Math.abs(Math.sin(tower.yaw)) > .5
      assert.deepEqual([tower.width, tower.depth], isSideways ? [34, 42] : [42, 34])
    })
  }
})

test('an existing stone path and villa plot disqualify tower sites without consuming land', () => {
  const communityId = 'access-test'
  const [lotside, ...rest] = arrange(communityId)
  const pathside = rest.at(-1)
  const plot = { id: 'M151', x: lotside.x, z: lotside.z, width: 40, depth: 30 }
  const walk = { x: pathside.x + pathside.width / 2 - 3, z: pathside.z, width: 2.55, depth: 45 }
  const geometry = new THREE.PlaneGeometry(walk.width, walk.depth).rotateX(-Math.PI / 2)
  const path = new THREE.Mesh(geometry)
  path.name = 'Limestone_walk_test'
  path.position.set(walk.x, config.ground, walk.z)
  const changedConfig = { ...config, plots: [plot] }
  const navigation = createManorNavigation({ THREE, landscape: new THREE.Group().add(path), config: changedConfig })
  assert.equal(navigation.hasPath(walk.x, walk.z), true)
  assert.equal(navigation.hasPath(walk.x + 2, walk.z), false)

  const towers = arrange(communityId, { config: changedConfig, navigation })
  assert.ok(towers.length > 0)
  assert.ok(towers.every(tower => separated(tower, walk) && separated(tower, plot)))
  assert.ok(!towers.some(tower => tower.id === lotside.id || tower.id === pathside.id))
  assert.deepEqual(changedConfig.plots, [plot])
})

test('terrain with no safe public ground produces no towers', () => {
  for (const sample of [() => null, x => config.ground + .02 * x]) {
    assert.deepEqual(arrange('terrain-test', { navigation: { sample, hasPath: () => false } }), [])
  }
  assert.deepEqual(arrange('terrain-test', { footprint: { width: 1300, depth: 45 } }), [])
})
