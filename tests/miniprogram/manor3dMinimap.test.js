const test = require('node:test')
const assert = require('node:assert/strict')
const { THREE } = require('../../miniprogram/packageManor3d/vendor/three-runtime')
const { createManorMinimap, projectManorMapPoint } = require('../../miniprogram/packageManor3d/utils/manor-minimap')

function makeLandscape() {
  const positions = [
    -600, 0, -100, 0, 0, 0, 600, 0, 100,
    -600, 0, -60, 0, 0, 50, 600, 0, 140
  ]
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  const stream = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
  stream.name = 'Winding clear stream'

  const landscape = new THREE.Group()
  landscape.position.set(20, 0, -10)
  landscape.scale.set(.5, 1, 2)
  landscape.add(stream)
  landscape.updateMatrixWorld(true)
  return landscape
}

test('the minimap projects landscape geometry and landmarks into screen percentages', () => {
  const minimap = createManorMinimap({
    world: { width: 1200, depth: 960 },
    plots: [{ id: 'P1', x: 0, z: 0, width: 60, depth: 40 }],
    crossings: [{ id: 'bridge-1', x: 0, z: 24, width: 7.6, length: 20, yaw: Math.PI / 2 }],
    landmarkTrees: [{ id: 'tree-1', x: -300, z: 240, r: 6 }]
  }, makeLandscape())

  assert.deepEqual({ worldWidth: minimap.worldWidth, worldDepth: minimap.worldDepth }, {
    worldWidth: 1200,
    worldDepth: 960
  })
  assert.deepEqual(minimap.plots[0], { id: 'P1', x: 50, y: 50, width: 5, height: 40 / 960 * 100, angle: 0 })
  assert.deepEqual(minimap.crossings[0], {
    id: 'bridge-1', x: 50, y: 52.5, width: 7.6 / 1200 * 100, height: 20 / 960 * 100, angle: -90
  })
  assert.deepEqual(minimap.trees[0], {
    id: 'tree-1', x: 25, y: 75, width: 1, height: 1.25, angle: 0
  })
  assert.match(minimap.river, /^polygon\(26\.7% 28\.1%/)
  assert.match(minimap.river, /76\.7% 69\.8%/)
  assert.equal(minimap.river.match(/% /g).length, 98)
  assert.deepEqual(projectManorMapPoint(minimap, 0, 0), { x: 50, y: 50 })
})

test('missing map geometry safely leaves a plain minimap', () => {
  assert.equal(createManorMinimap(null), null)
  assert.equal(createManorMinimap({ world: { width: 0, depth: 10 } }), null)
  const minimap = createManorMinimap({ world: { width: 100, depth: 80 } }, new THREE.Group())
  assert.equal(minimap.river, '')
  assert.deepEqual(minimap.plots, [])
  assert.deepEqual(minimap.crossings, [])
  assert.deepEqual(minimap.trees, [])
  assert.equal(projectManorMapPoint(minimap, NaN, 0), null)
})
